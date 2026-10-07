import * as vscode from "vscode";
import * as path from "path";
import { hasDangerPatterns } from "../prompts/prompt-template";
import { verifyHasElseBranch } from "./verify-rules";
import { getResolvedPrompt, getResolvedUserPrompt } from '../../../storage/prompt-library';
import type { CustomLlmClient } from "../../../services/llm/adapters/types";
import { buildMcpToolsPrompt, executeMcpToolCalls, buildMcpResultsPrompt } from "../../../services/mcp/agent/mcp-agent";
import { buildAgentPoolPrompt } from "../../../services/agent-pool";

export type DmcrGeneratedChange = {
  changeName: string; // slug only, e.g. "add_email_to_customer"
  deploySql: string;
  verifySql: string;
  revertSql: string;
  metaJson?: string;
};

export async function loadDmcrContextText(
  wsFolder: vscode.WorkspaceFolder
): Promise<string> {
  const candidates = ["dmcr.ps1", "dmcr.cfg", "dmcr_change_log_ddl.sql"].map(p =>
    vscode.Uri.file(path.join(wsFolder.uri.fsPath, p))
  );

  const parts: string[] = [];
  for (const uri of candidates) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      parts.push(`FILE: ${path.basename(uri.fsPath)}\n-----\n${text}\n-----\n`);
    } catch {
      // ignore missing
    }
  }

  return parts.length ? parts.join("\n") : "No dmcr.* files found at workspace root.";
}

/** @deprecated Use getResolvedPrompt('DMCR_RULES') from prompt-library instead. */
export { dmcrRulesSystemPrompt as dmcrRulesPrompt } from "../prompts/prompt-template";

export async function generateDmcrChangeWithCopilot(
  userRequest: string,
  dmcrContext: string,
  token: vscode.CancellationToken,
  onChunk?: (partial: string) => void,
  family?: string,
  onToken?: (delta: string) => void
): Promise<DmcrGeneratedChange> {
  const filter: { vendor: string; family?: string } = { vendor: "copilot" };
  if (family) filter.family = family;
  const models = await vscode.lm.selectChatModels(filter);
  const model = models?.[0];
  if (!model) {
    throw new Error(
      "No Copilot chat model available. Ensure GitHub Copilot Chat is installed and enabled."
    );
  }

  // Discover MCP tools dynamically (empty string if no MCP servers configured)
  let mcpToolsPrompt = '';
  try { mcpToolsPrompt = await buildMcpToolsPrompt(); } catch { /* no MCP */ }

  const agentPoolPrompt = buildAgentPoolPrompt();
  const vars = { toolList: mcpToolsPrompt, agentPool: agentPoolPrompt, dmcrContext, userRequest };
  const systemPrompt = getResolvedPrompt('DMCR_RULES', vars);
  const userPromptText = getResolvedUserPrompt('DMCR_RULES', vars);

  const baseMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.Assistant(systemPrompt),
    vscode.LanguageModelChatMessage.User(userPromptText),
  ];

  // Attempt 1
  const resp1 = await model.sendRequest(
    baseMessages,
    { modelOptions: { temperature: 0.2 } },
    token
  );
  const out1 = await concatResponse(resp1, onChunk, onToken);

  let parsed = tryParseGenerated(out1);

  // Check if agent requested MCP tool calls before generating SQL
  if (!parsed && mcpToolsPrompt) {
    const toolCalls = tryParseMcpToolCalls(out1);
    if (toolCalls.length > 0) {
      onChunk?.('Calling MCP tools: ' + toolCalls.map(t => t.tool).join(', ') + '…');
      const toolResults = await executeMcpToolCalls(toolCalls, 'dmcr-gen-copilot');
      const resultsPrompt = buildMcpResultsPrompt(toolResults);

      // Re-generate with tool results injected
      const messagesWithResults: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.Assistant(systemPrompt),
        vscode.LanguageModelChatMessage.User(
          `${userPromptText}\n${resultsPrompt}\n\nNow generate the DMCR change JSON using the tool results above. Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.`
        ),
      ];
      const resp1b = await model.sendRequest(messagesWithResults, { modelOptions: { temperature: 0.2 } }, token);
      const out1b = await concatResponse(resp1b, onChunk, onToken);
      parsed = tryParseGenerated(out1b);
    }
  }

  // Attempt 2 (repair)
  if (!parsed) {
    const repairMessages: vscode.LanguageModelChatMessage[] = [
      ...baseMessages,
      vscode.LanguageModelChatMessage.Assistant(
        [
          "Your previous response was NOT valid JSON.",
          "Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.",
          "No markdown. No commentary. No leading/trailing text.",
          "",
          "Previous (invalid) output:",
          out1.length > 4000 ? out1.slice(0, 4000) + "\n...[truncated]..." : out1,
        ].join("\n")
      ),
    ];

    const resp2 = await model.sendRequest(
      repairMessages,
      { modelOptions: { temperature: 0 } },
      token
    );
    const out2 = await concatResponse(resp2, undefined, onToken);

    parsed = tryParseGenerated(out2);

    if (!parsed) {
      throw new Error("DMCR_NOT_SQL_REQUEST");
    }
  }

  // Auto-heal verify.sql if model forgot dmcr.change_log (common for DML)
  parsed.verifySql = ensureVerifyHasDmcrGuard(parsed.verifySql, parsed.deploySql);

  return validateOrCorrect(parsed, async (fixText) => {
    const resp3 = await model.sendRequest(
      [...baseMessages, vscode.LanguageModelChatMessage.User(fixText)],
      { modelOptions: { temperature: 0 } },
      token
    );
    return concatResponse(resp3, undefined, onToken);
  });
}

/**
 * Generate a DMCR change using a custom HTTP LLM provider (OpenAI/Anthropic/etc).
 * Mirrors generateDmcrChangeWithCopilot logic but uses CustomLlmClient.
 */
export async function generateDmcrChangeWithCustomClient(
  client: CustomLlmClient,
  model: string,
  userRequest: string,
  dmcrContext: string,
  onChunk?: (partial: string) => void,
  onToken?: (delta: string) => void
): Promise<DmcrGeneratedChange> {
  // Discover MCP tools dynamically
  let mcpToolsPrompt = '';
  try { mcpToolsPrompt = await buildMcpToolsPrompt(); } catch { /* no MCP */ }

  const agentPoolPrompt2 = buildAgentPoolPrompt();
  const vars2 = { toolList: mcpToolsPrompt, agentPool: agentPoolPrompt2, dmcrContext, userRequest };
  const hint = getResolvedPrompt('DMCR_RULES', vars2);
  const context = getResolvedUserPrompt('DMCR_RULES', vars2);

  // Use streaming if the adapter supports it and a token callback was provided
  const out1 = (client.stream && onToken)
    ? await client.stream(hint, context, model, onToken, 0.2)
    : await client.generateText(hint, context, model, 0.2);
  onChunk?.(out1);

  let parsed = tryParseGenerated(out1);

  // Check if agent requested MCP tool calls
  if (!parsed && mcpToolsPrompt) {
    const toolCalls = tryParseMcpToolCalls(out1);
    if (toolCalls.length > 0) {
      onChunk?.('Calling MCP tools: ' + toolCalls.map(t => t.tool).join(', ') + '…');
      const toolResults = await executeMcpToolCalls(toolCalls, 'dmcr-gen-custom');
      const resultsPrompt = buildMcpResultsPrompt(toolResults);
      const contextWithResults = `${context}\n${resultsPrompt}\n\nNow generate the DMCR change JSON using the tool results above. Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.`;
      const out1b = await client.generateText(hint, contextWithResults, model, 0.2);
      onChunk?.(out1b);
      parsed = tryParseGenerated(out1b);
    }
  }

  if (!parsed) {
    const repairHint = [
      hint,
      "",
      "Your previous response was NOT valid JSON.",
      "Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.",
      "No markdown fences. No commentary. No leading/trailing text.",
      "",
      "Previous (invalid) output:",
      out1.length > 4000 ? out1.slice(0, 4000) + "\n...[truncated]..." : out1,
    ].join("\n");
    const out2 = await client.generateText(repairHint, context, model, 0);
    onChunk?.(out2);
    parsed = tryParseGenerated(out2);
    if (!parsed) throw new Error("DMCR_NOT_SQL_REQUEST");
  }

  parsed.verifySql = ensureVerifyHasDmcrGuard(parsed.verifySql, parsed.deploySql);
  return validateOrCorrect(parsed, (fixText) => client.generateText(hint, `${context}\n\n${fixText}`, model, 0));
}

/**
 * Validate a generated change; if it breaks a DMCR rule, give the model one chance to fix
 * exactly that (temperature 0) before failing. Without this, a rule like "no ELSE in verify.sql"
 * could fail the same request every time.
 */
async function validateOrCorrect(
  parsed: DmcrGeneratedChange,
  regenerate: (fixText: string) => Promise<string>,
): Promise<DmcrGeneratedChange> {
  try {
    validateGenerated(parsed);
    return parsed;
  } catch (err) {
    const rule = err instanceof Error ? err.message : String(err);
    const guidance = /ELSE/.test(rule)
      ? "In verify.sql use two independent blocks and no ELSE branch: IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN <applied checks> END IF; IF NOT EXISTS (same query) THEN <reverted checks> END IF; (CASE expressions are fine)."
      : /changeName/.test(rule)
        ? "changeName must be lowercase snake_case (letters, digits, underscores)."
        : "Fix only what the rule requires.";
    const fixText = [
      `Your previous change broke a DMCR rule: ${rule}.`,
      guidance,
      "Return the same change again as ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql, metaJson — change nothing except what the rule requires.",
      "",
      "Previous change:",
      JSON.stringify(parsed).slice(0, 12000),
    ].join("\n");
    const out = await regenerate(fixText);
    const fixed = tryParseGenerated(out);
    if (!fixed) { throw err; }
    fixed.verifySql = ensureVerifyHasDmcrGuard(fixed.verifySql, fixed.deploySql);
    validateGenerated(fixed); // still broken → the original rule's message reaches the user
    return fixed;
  }
}

async function concatResponse(
  resp: vscode.LanguageModelChatResponse,
  onChunk?: (partial: string) => void,
  onToken?: (delta: string) => void
): Promise<string> {
  let out = "";
  for await (const part of resp.text) {
    out += part;
    onToken?.(part);
    onChunk?.(out);
  }
  return out.trim();
}

function extractJsonObject(text: string): string {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/```$/i, "").trim();

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}

function tryParseGenerated(text: string): DmcrGeneratedChange | null {
  try {
    const jsonText = extractJsonObject(text);
    const obj = JSON.parse(jsonText) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const x = obj as Record<string, unknown>;
    // Require all four fields to be non-empty strings — if any is missing the
    // model hasn't produced a real DMCR change (e.g. it responded conversationally).
    for (const k of ["changeName", "deploySql", "verifySql", "revertSql"] as const) {
      if (typeof x[k] !== "string" || !(x[k] as string).trim()) return null;
    }
    return x as unknown as DmcrGeneratedChange;
  } catch {
    return null;
  }
}

/**
 * Try to extract mcpToolCalls from an LLM response that isn't a valid DMCR change.
 * The agent may respond with: { "mcpToolCalls": [{ "tool": "...", "args": {...} }] }
 */
function tryParseMcpToolCalls(text: string): Array<{ tool: string; args?: Record<string, unknown> }> {
  try {
    const jsonText = extractJsonObject(text);
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    if (Array.isArray(obj.mcpToolCalls)) {
      return obj.mcpToolCalls.filter(
        (c: unknown) => c && typeof c === 'object' && typeof (c as Record<string, unknown>).tool === 'string'
      ) as Array<{ tool: string; args?: Record<string, unknown> }>;
    }
  } catch { /* not parseable */ }
  return [];
}

function detectPrimaryTableFqn(sql: string): string | undefined {
  if (!sql || typeof sql !== "string") return undefined;
  // Look for common patterns
  const m =
    sql.match(/\bALTER\s+TABLE\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/i) ??
    sql.match(/\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/i) ??
    sql.match(/\bUPDATE\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/i) ??
    sql.match(/\bDELETE\s+FROM\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b/i);

  if (!m) return undefined;

  // Fix common model mistake: public.schema.table -> schema.table
  const fqn = m[1].replace(/^public\./i, "");
  return fqn;
}

function ensureVerifyHasDmcrGuard(verifySql: string, deploySql: string): string {
  // dmcr.repeatable_log is the gate for repeatable (R__) changes
  const hasChangeLog = /dmcr\s*\.\s*(change_log|repeatable_log)/i.test(verifySql);
  const hasPlaceholder = /__DMCR_CHANGE_ID__/.test(verifySql);

  if (hasChangeLog && hasPlaceholder) {
    return verifySql;
  }

  const tableFqn = detectPrimaryTableFqn(deploySql);
  const tableLiteral = tableFqn ? `${tableFqn}` : "public.your_table_here";

  // Replace with a DMCR-safe verify template
  return [
    "-- DMCR verify (auto-healed): enforce dmcr.change_log guard",
    "DO $$",
    "DECLARE",
    "  _t regclass;",
    "BEGIN",
    "  IF EXISTS (",
    "    SELECT 1",
    "    FROM dmcr.change_log",
    "    WHERE change_id = '__DMCR_CHANGE_ID__'",
    "  ) THEN",
    `    _t := to_regclass('${tableLiteral}');`,
    "    IF _t IS NULL THEN",
    `      RAISE EXCEPTION 'Invariant failed: expected table % to exist when change is applied.', '${tableLiteral}';`,
    "    END IF;",
    "  END IF;",
    "END $$;",
    "",
  ].join("\n");
}

function validateGenerated(x: DmcrGeneratedChange) {
  if (!x || typeof x !== "object") {
    throw new Error("Model output was not an object.");
  }
  for (const k of ["changeName", "deploySql", "verifySql", "revertSql"] as const) {
    if (typeof (x as any)[k] !== "string" || !(x as any)[k].trim()) {
      throw new Error(`Model output missing/invalid: ${k}`);
    }
  }
  // R__ prefix: a repeatable change (Freeform → "repeatable")
  if (!/^(R__)?[a-z0-9]+(_[a-z0-9]+)*$/.test(x.changeName.trim())) {
    throw new Error(`Invalid changeName slug: ${x.changeName}`);
  }
  if (!x.verifySql.includes("dmcr.change_log") && !x.verifySql.includes("dmcr.repeatable_log")) {
    throw new Error(
      "verify.sql must reference dmcr.change_log to be DMCR-safe (must work after deploy and revert)"
    );
  }
  if (!x.verifySql.includes("__DMCR_CHANGE_ID__")) {
    throw new Error("verify.sql must reference __DMCR_CHANGE_ID__");
  }
  if (verifyHasElseBranch(x.verifySql)) {
    throw new Error("verify.sql must not assert reverted or negative state using ELSE blocks");
  }
}