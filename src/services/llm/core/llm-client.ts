/**
 * Shared LLM caller for DMCR.
 *
 * Works transparently with either:
 *   - A custom provider (OpenAI-compatible, Anthropic, LM Studio, Ollama)
 *     configured in DMCR Settings → Custom Providers, or
 *   - GitHub Copilot (via VS Code Language Model API)
 *
 * Handles MCP tool-call loops internally so callers never need to duplicate
 * that logic.
 *
 * Usage:
 *   import { callActiveLlm } from '../services/llm-client';
 *   const text = await callActiveLlm(systemPrompt, userMsg, 0.3, token);
 */
import * as vscode from 'vscode';
import { getActiveCustomProviderKey, getActiveFamily } from './llm-settings';
import { getCustomProviderWithKey, createCustomProviderClient } from './custom-providers';
import { buildMcpToolsPrompt, executeMcpToolCalls, buildMcpResultsPrompt } from '../../mcp/agent/mcp-agent';
import { resolvePromptTemplate, type PromptVarMap } from '../template/prompt-template-resolver';
export type { PromptVarMap } from '../template/prompt-template-resolver';
export { resolvePromptTemplate } from '../template/prompt-template-resolver';

/**
 * Call the currently active LLM provider.
 *
 * @param systemPrompt        System / assistant-role prompt.
 * @param userMsg             User message.
 * @param temperature         Sampling temperature (default 0.5).
 * @param token               VS Code cancellation token (optional).
 * @param onMcpProgress       Optional callback fired when MCP tools are invoked,
 *                            receives a human-readable progress string.
 * @param mcpRetryInstruction Instruction appended to the user message when
 *                            re-calling after MCP tool results are returned.
 *                            Defaults to a generic accurate-answer instruction.
 */
export async function callActiveLlm(
  systemPrompt: string,
  userMsg: string,
  temperature = 0.5,
  token?: vscode.CancellationToken,
  onMcpProgress?: (msg: string) => void,
  mcpRetryInstruction = '\n\nUse the tool results above to answer accurately.',
  vars?: PromptVarMap,
  conversationId?: string,
): Promise<string> {
  // Discover MCP tools
  let mcpTools = '';
  try { mcpTools = await buildMcpToolsPrompt(); } catch { /* no MCP servers configured */ }

  // Build the resolved var map (caller vars + runtime toolList)
  const resolvedVars: PromptVarMap = { ...vars, toolList: vars?.toolList ?? mcpTools };

  // Resolve {{varName}} placeholders in both prompts
  const resolvedSystem = resolvePromptTemplate(systemPrompt, resolvedVars);
  const resolvedUser = resolvePromptTemplate(userMsg, resolvedVars);

  // First call
  let text = await _callProvider(resolvedSystem, resolvedUser, temperature, token);

  // MCP tool-call loop — if the model requested tools, execute them and re-call once.
  // Guard runs whether or not mcpTools was populated — the model may still emit
  // mcpToolCalls if it was trained on the format or the prompt hard-codes it.
  const looksLikeMcpEnvelope = (s: string) => s.includes('"mcpToolCalls"');

  if (looksLikeMcpEnvelope(text)) {
    if (!mcpTools) {
      // No MCP servers configured — model hallucinated tool calls; re-call without tools
      try {
        text = await _callProvider(resolvePromptTemplate(systemPrompt, { ...resolvedVars, toolList: '' }), resolvedUser, temperature, token);
      } catch { /* keep original and fall through to final guard below */ }
    } else {
      try {
        const jsonStart = text.indexOf('{');
        const jsonEnd   = text.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
          if (Array.isArray(parsed?.mcpToolCalls) && parsed.mcpToolCalls.length > 0) {
            if (onMcpProgress) {
              onMcpProgress(
                'Calling MCP tools: ' +
                parsed.mcpToolCalls.map((t: { tool: string }) => t.tool).join(', ') +
                '\u2026',
              );
            }
            const toolResults = await executeMcpToolCalls(parsed.mcpToolCalls, conversationId);
            const resultsPrompt = buildMcpResultsPrompt(toolResults);
            // Re-call WITHOUT the tools list so the model synthesises results
            const noToolsSystem = resolvePromptTemplate(systemPrompt, { ...resolvedVars, toolList: '' });
            text = await _callProvider(
              noToolsSystem,
              resolvedUser + '\n' + resultsPrompt + mcpRetryInstruction,
              temperature,
              token,
            );
          }
        }
      } catch {
        // MCP execution failed (server down, tool not found, timeout, etc.)
        // Re-call without the tool results so the model answers from its own knowledge
        try {
          text = await _callProvider(resolvePromptTemplate(systemPrompt, { ...resolvedVars, toolList: '' }), resolvedUser, temperature, token);
        } catch { /* last resort: fall through to guard below */ }
      }
    }
  }

  // Final safety net: if text is still a raw tool-call envelope, return a friendly message
  if (looksLikeMcpEnvelope(text)) {
    return "I couldn't retrieve the schema information — the MCP server may be unavailable or the requested tool doesn't exist. You can still provide schema context manually in the Schema field, or check your MCP server connection in DMCR Settings.";
  }

  return text;
}

// ─── Internal provider dispatch ──────────────────────────────────────────────

async function _callProvider(
  systemPrompt: string,
  userMsg: string,
  temperature: number,
  token?: vscode.CancellationToken,
): Promise<string> {
  const activeCustomKey = getActiveCustomProviderKey();

  if (activeCustomKey) {
    return _callCustomProvider(activeCustomKey, systemPrompt, userMsg, temperature);
  }

  return _callCopilot(systemPrompt, userMsg, temperature, token);
}

async function _callCustomProvider(
  key: string,
  systemPrompt: string,
  userMsg: string,
  temperature: number,
): Promise<string> {
  const cfg = await getCustomProviderWithKey(key);
  if (!cfg) throw new Error(`Custom provider '${key}' not found.`);

  const client = await createCustomProviderClient(key);
  const modelId = cfg.activeModel || cfg.cachedModels?.[0]?.id || '';

  // Prefer streaming when available (gives live token output on providers that support it)
  if (client.stream) {
    return client.stream(systemPrompt, userMsg, modelId, () => {}, temperature);
  }
  return client.generateText(systemPrompt, userMsg, modelId, temperature);
}

async function _callCopilot(
  systemPrompt: string,
  userMsg: string,
  temperature: number,
  token?: vscode.CancellationToken,
): Promise<string> {
  const activeFamily = getActiveFamily();
  const filter: { vendor: string; family?: string } = { vendor: 'copilot' };
  if (activeFamily) filter.family = activeFamily;

  const [model] = await vscode.lm.selectChatModels(filter);
  if (!model) throw new Error('No Copilot model available. Either configure a Custom Provider in DMCR Settings or ensure GitHub Copilot is signed in.');

  const cts = token ? undefined : new vscode.CancellationTokenSource();
  const effectiveToken = token ?? cts!.token;

  try {
    const resp = await model.sendRequest(
      [
        vscode.LanguageModelChatMessage.Assistant(systemPrompt),
        vscode.LanguageModelChatMessage.User(userMsg),
      ],
      { modelOptions: { temperature } },
      effectiveToken,
    );
    let out = '';
    for await (const part of resp.text) out += part;
    return out.trim();
  } finally {
    cts?.dispose();
  }
}
