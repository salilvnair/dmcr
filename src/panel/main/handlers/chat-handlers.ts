/**
 * Chat / conversation message handlers: requestConversationHtml, chat (MasterAgent routing).
 */
import * as vscode from "vscode";
import { setSelfCheckContext } from "../../../forms/llm/generation/self-check";
import * as path from "path";
import * as fs from "fs";
import {
  generateDmcrChangeWithCopilot,
  generateDmcrChangeWithCustomClient,
  loadDmcrContextText,
  type DmcrGeneratedChange,
} from "../../../forms/llm/generation/generator";
import { searchWiki } from "../../../forms/llm/generation/wiki-search";
import { getResolvedPrompt, getResolvedUserPrompt, getAgentName } from "../../../storage/prompt-library";
import { callActiveLlm } from "../../../services/llm/core/llm-client";
import {
  getActiveFamily,
  getActiveCustomProviderKey,
} from "../../../services/llm/core/llm-settings";
import {
  getAllCustomProviders,
  createCustomProviderClient,
} from "../../../services/llm/core/custom-providers";
import { getMaxAuditId, insertAudit, saveConversationSql, getConversationSql } from "../../../storage/db";
import { buildAgentPoolPrompt, executeAgentPoolCall } from "../../../services/agent-pool";
import { buildMcpToolsPrompt, executeMcpToolCalls, buildMcpResultsPrompt, getConfiguredMcpServers } from "../../../services/mcp/agent/mcp-agent";
import type { McpServerConfig } from "../../../services/mcp/server/mcp";
import { hasServerConn, serverConnUrl, connRef } from "../../../services/mcp/server/conn-url";
import type { HandlerContext, Message } from "./types";
import { compareChangeIds } from '../../../storage/change-order';

export async function handleChatMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  setSelfCheckContext(ctx.extensionPath, ctx.extensionContext);
  const { webview } = ctx;

  switch (msg.type) {

    /* ── Inline conversation HTML (navbar tab) ── */
    case "requestConversationHtml": {
      const distPath = path.join(ctx.extensionUri.fsPath, "webview", "dist");
      const htmlDir  = path.join(distPath, "webview-ui");
      const htmlPath = path.join(htmlDir, "conversation.html");
      if (!fs.existsSync(htmlPath)) return true;
      let html = fs.readFileSync(htmlPath, "utf8");
      html = html.replace(/(src|href)="((?:\.\.\/|\.\/|\/)[^"]+)"/g, (_m: string, attr: string, assetPath: string) => {
        const filePath = assetPath.startsWith("/")
          ? path.join(distPath, assetPath.slice(1))
          : path.resolve(htmlDir, assetPath);
        const resourceUri = webview.asWebviewUri(vscode.Uri.file(filePath));
        return `${attr}="${resourceUri}"`;
      });
      html = html.replace(/\s+crossorigin/g, "");
      const shim = `<script>
  if (window.parent && window.parent !== window && window.parent.__DMCR_VSCODE_API__) {
    window.__DMCR_VSCODE_API__ = window.parent.__DMCR_VSCODE_API__;
  } else {
    try { window.__DMCR_VSCODE_API__ = acquireVsCodeApi(); } catch(e) {}
  }
  window.__DMCR_MODE__ = 'vscode-extension';
</script>`;
      html = html.replace("</head>", `${shim}\n</head>`);
      const csp2 = [
        `default-src 'none'`,
        `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'`,
        `style-src  ${webview.cspSource} 'unsafe-inline'`,
        `font-src   ${webview.cspSource} data:`,
        `img-src    ${webview.cspSource} data: https: blob:`,
        `connect-src 'none'`,
      ].join("; ");
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp2}">`);
      if (!html.includes("Content-Security-Policy")) {
        html = html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp2}">`);
      }
      ctx.state.inlineConvSessionStartId = getMaxAuditId();
      webview.postMessage({ type: 'formHtml', payload: { form: 'conversation', html } });
      return true;
    }

    /* ── Inline conversation chat — MasterAgent routing ── */
    case "chat": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { msgId, payload } = msg as { msgId?: string; payload?: any };
      const userText: string = payload?.text ?? "";

      // ── Handle metadata form response (from DmcrMetadataFormRenderer) ──
      const inputParams = payload?.inputParams ?? {};
      if (inputParams.action === 'metadata_confirmed' || inputParams.action === 'metadata_skipped') {
        const pendingMap = ctx.state.pendingGenerations;
        const formPendingId = inputParams.pendingId as string | undefined;
        // Older forms carry no pendingId: fall back to the latest one in this conversation.
        const pendingKey = (formPendingId && pendingMap[formPendingId]) ? formPendingId
          : Object.keys(pendingMap).filter(k => pendingMap[k].conversationId === payload?.conversationId).pop();
        const pending = pendingKey ? pendingMap[pendingKey] : undefined;
        if (!pending || !pendingKey) {
          webview.postMessage({ type: 'reply', msgId, text: JSON.stringify({ type: 'text', rawText: 'This metadata form has expired (the chat was reset or the change was already generated). Please describe the change again.' }) });
          webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
          return true;
        }
        delete pendingMap[pendingKey];

        const progress2 = (text: string) =>
          webview.postMessage({ type: 'sseEvent', stage: 'VERBOSE', data: JSON.stringify({ verbose: { text } }) });
        progress2(`${getAgentName('DMCR_RULES')} is generating your change\u2026`);

        const activeCustomKey2 = getActiveCustomProviderKey();
        const activeFamily2    = getActiveFamily();
        const cts2 = new vscode.CancellationTokenSource();
        ctx.disposables.push({ dispose: () => cts2.dispose() });

        try {
          const t0_2 = Date.now();
          let fullResponseText2 = '';
          let dmcrProgressSent2 = false;
          let usedModelLabel2 = '';
          const onChunk2 = (chunk: string) => { fullResponseText2 = chunk; if (!dmcrProgressSent2 && chunk.includes('"changeName"')) { dmcrProgressSent2 = true; progress2("Generating DMCR change\u2026"); } };
          // the AI's tokens are counted on its step in the progress card (trackAi), never shown raw
          const onToken2 = (_delta: string) => { /* streamed size is reported by the generator's AI step */ };
          // every step (MCP calls, the AI request, the self-check) goes to the Assistant's progress card
          const { withActivity } = await import('../../../services/activity.js');
          const postActivity2 = (event: unknown) => webview.postMessage({ type: 'genActivity', payload: { form: 'conversation', event } });
          let change2: DmcrGeneratedChange;
          if (activeCustomKey2) {
            const allP2 = getAllCustomProviders();
            const pCfg2 = allP2.find(p => p.key === activeCustomKey2);
            if (!pCfg2) throw new Error(`Custom provider '${activeCustomKey2}' not found.`);
            const client2 = await createCustomProviderClient(activeCustomKey2);
            const modelId2 = pCfg2.activeModel ?? '';
            usedModelLabel2 = `${pCfg2.name}/${modelId2 || 'default'}`;
            change2 = await withActivity(postActivity2, `${pCfg2.name} · ${modelId2 || 'default'}`,
              () => generateDmcrChangeWithCustomClient(client2, modelId2, pending.contextualUserText, pending.dmcrContext, onChunk2, onToken2));
          } else {
            usedModelLabel2 = activeFamily2 || 'copilot';
            change2 = await withActivity(postActivity2, `Copilot · ${activeFamily2 || 'default model'}`,
              () => generateDmcrChangeWithCopilot(pending.contextualUserText, pending.dmcrContext, cts2.token, onChunk2, activeFamily2 || undefined, onToken2));
          }

          if (inputParams.action === 'metadata_confirmed' && inputParams.metadata) {
            change2.metaJson = JSON.stringify(inputParams.metadata, null, 2);
          }
          // A name hint the user typed wins over the name the AI proposed
          const hintName = (pending.changeNameHint ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
          if (hintName) change2.changeName = change2.changeName.startsWith('R__') ? `R__${hintName.replace(/^r__/, '')}` : hintName;

          const dur2 = Date.now() - t0_2;
          const systemPrompt2 = getResolvedPrompt('DMCR_RULES');
          insertAudit({ conversation_id: pending.conversationId, stage: 'DMCR_AGENT_OUTPUT', model: usedModelLabel2, system_prompt: systemPrompt2, user_prompt: pending.fullUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: systemPrompt2.slice(0, 2000) }, { role: 'user', content: pending.fullUserText.slice(0, 2000) }], context: pending.dmcrContext.slice(0, 2000) }), response_payload: JSON.stringify({ raw: fullResponseText2.slice(0, 4000) }), headers: JSON.stringify({ vendor: activeCustomKey2 ?? 'copilot', family: activeFamily2 }), duration_ms: dur2 });
          // Persist full SQL for SQL_REFINE agent lookups
          saveConversationSql({
            conversation_id: pending.conversationId,
            change_name: change2.changeName,
            deploy_sql: change2.deploySql,
            verify_sql: change2.verifySql,
            revert_sql: change2.revertSql,
            meta_json: change2.metaJson ?? null,
          });
          const dmcrPayload2 = { type: "DmcrChange" as const, changeName: change2.changeName, deploySql: change2.deploySql, verifySql: change2.verifySql, revertSql: change2.revertSql, metaJson: change2.metaJson, selfCheck: change2.selfCheck };
          webview.postMessage({ type: "reply", msgId, text: JSON.stringify(dmcrPayload2) });
        } catch (err2: unknown) {
          const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
          webview.postMessage({ type: "error", msgId, text: errMsg2 });
        }
        webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
        return true;
      }

      if (!userText.trim()) return true;

      // ── /help intercept ──
      if (/^\/help\b|^help$/i.test(userText.trim())) {
        webview.postMessage({ type: "reply", msgId, text: JSON.stringify({ type: "dmcrHelp" }) });
        webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
        return true;
      }

      // ── Schema server picker response — user selected a server from the interactive card ──
      if (inputParams._dmcr_schema_picker) {
        const serverId: string = inputParams.serverId ?? '';
        const serverName: string = inputParams.serverName ?? userText;
        const servers = getConfiguredMcpServers() as McpServerConfig[];
        const chosen = servers.find(s => s.id === serverId);
        const secondConn = chosen ? await serverConnUrl(chosen) : null;
        const cts2sp = new vscode.CancellationTokenSource();
        ctx.disposables.push({ dispose: () => cts2sp.dispose() });
        const progress2sp = (text: string) =>
          webview.postMessage({ type: 'sseEvent', stage: 'VERBOSE', data: JSON.stringify({ verbose: { text } }) });
        const callLlmSp = async (systemPrompt: string, um: string, temp = 0.5) =>
          callActiveLlm(systemPrompt, um, temp, cts2sp.token, (m) => progress2sp(m), undefined, undefined, msgId ?? `conv_${Date.now()}`);
        if (!secondConn) {
          const reply = `I couldn't extract a connection URL for **${serverName}**. Please check its configuration in Settings → MCP Servers and ensure the connection string is in the args (e.g. \`--conn postgresql://...\`) or env (\`DATABASE_URL\`).`;
          webview.postMessage({ type: 'reply', msgId, text: JSON.stringify({ type: 'text', rawText: reply }) });
          webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
          return true;
        }
        try {
          progress2sp(`Running compare_schemas against ${serverName}…`);
          const { executeMcpToolCalls: execTools, buildMcpResultsPrompt: buildResults } = await import('../../../services/mcp/agent/mcp-agent.js');
          const toolResults = await execTools([{ tool: 'compare_schemas', args: { second_conn: secondConn } }], msgId);
          const resultsCtx = buildResults(toolResults);
          const toolsPrompt = await buildMcpToolsPrompt();
          const { getResolvedPrompt: gRP } = await import('../../../storage/prompt-library.js');
          const synthSysPrompt = gRP('MCP_TOOL_AGENT', { toolList: toolsPrompt }) + '\n\n' + resultsCtx;
          const synthUserMsg = `Using compare_schemas results above, provide a clear markdown summary of what has drifted between the configured database and ${serverName}.`;
          progress2sp('Synthesizing drift report…');
          const finalReply = await callLlmSp(synthSysPrompt, synthUserMsg, 0.3);
          webview.postMessage({ type: 'reply', msgId, text: JSON.stringify({ type: 'text', rawText: finalReply }) });
        } catch (spErr: unknown) {
          webview.postMessage({ type: 'error', msgId, text: `Schema comparison failed: ${spErr instanceof Error ? spErr.message : String(spErr)}` });
        }
        webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
        return true;
      }

      const schemaCtx: string = (payload?.inputParams?.schemaCtx ?? "").trim();
      const changeNameHint: string = (payload?.inputParams?.changeNameHint ?? "").trim();
      const schemaContext = schemaCtx
        ? `\n\nSchema context: ${schemaCtx}\nUse "${schemaCtx}" as the default schema for all unqualified table/function/sequence names in deploy.sql, verify.sql and revert.sql.`
        : '';
      const changeNameContext = changeNameHint
        ? `\n\nChange name hint: ${changeNameHint}\nUse "${changeNameHint}" (or a close variation) as the changeName for the DMCR change file.`
        : '';
      const fullUserText = schemaContext || changeNameContext
        ? `${userText}${schemaContext}${changeNameContext}`
        : userText;
      const ws2 = vscode.workspace.workspaceFolders?.[0];
      const cts2 = new vscode.CancellationTokenSource();
      ctx.disposables.push({ dispose: () => cts2.dispose() });
      const conversationId = payload?.conversationId ?? msgId ?? `conv_${Date.now()}`;
      const activeCustomKey2 = getActiveCustomProviderKey();
      const activeFamily2    = getActiveFamily();
      const progress2 = (text: string) =>
        webview.postMessage({ type: 'sseEvent', stage: 'VERBOSE', data: JSON.stringify({ verbose: { text } }) });

      // an AI request: a step in the progress card when one is listening (no-op otherwise)
      const callLlm = async (systemPrompt: string, userMsg: string, temp = 0.5): Promise<string> => {
        const { trackAi } = await import('../../../services/activity.js');
        return trackAi('answering', () => callActiveLlm(systemPrompt, userMsg, temp, cts2.token, (m) => progress2(m), undefined, undefined, conversationId));
      };

      // ── Dialogue intent resolution ──
      type HistoryEntry = { role: string; content: string };
      const rawHistory: HistoryEntry[] = payload?.inputParams?.conversationHistory ?? [];
      let resolvedUserText = fullUserText;
      const t0Intent = Date.now();
      if (rawHistory.length > 0) {
        try {
          progress2(`${getAgentName('DIALOGUE_INTENT')} resolving context\u2026`);
          const historyText = rawHistory
            .map((h: HistoryEntry) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content.slice(0, 600)}`)
            .join('\n\n');
          const intentPrompt = getResolvedPrompt('DIALOGUE_INTENT', { conversationHistory: historyText });
          const intentUserMsg = getResolvedUserPrompt('DIALOGUE_INTENT', { conversationHistory: historyText, userMessage: fullUserText });
          const resolved = await callLlm(intentPrompt, intentUserMsg, 0.1);
          if (resolved.trim()) resolvedUserText = resolved.trim();
          insertAudit({
            conversation_id: conversationId,
            stage: 'DIALOGUE_INTENT_OUTPUT',
            model: activeFamily2 || 'copilot',
            system_prompt: intentPrompt.slice(0, 500),
            user_prompt: fullUserText,
            request_payload: JSON.stringify({ messages: [{ role: 'system', content: intentPrompt.slice(0, 2000) }, { role: 'user', content: intentUserMsg.slice(0, 2000) }], temperature: 0.1 }),
            response_payload: JSON.stringify({ original: fullUserText, resolved: resolvedUserText }),
            duration_ms: Date.now() - t0Intent,
            meta: JSON.stringify({ userInput: userText }),
          });
        } catch { /* fall back to original text */ }
      }

      const historyCtx = rawHistory.length > 0
        ? 'Recent conversation (for context):\n' +
          rawHistory
            .map((h: HistoryEntry) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content.slice(0, 600)}`)
            .join('\n') +
          '\n\nCurrent request:\n'
        : '';

      // Build the shared var map for all agent user prompts
      const agentPoolText = buildAgentPoolPrompt(conversationId);
      const chatVars: Record<string, string> = {
        userMessage: resolvedUserText,
        conversationHistory: historyCtx,
        schemaContext: schemaContext,
        changeNameContext: changeNameContext,
        agentPool: agentPoolText,
      };

      try {
        const dmcrCtx2 = ws2 ? await loadDmcrContextText(ws2) : "No workspace folder open.";

        // ─── Step 1: MasterAgent classifies intent ───
        progress2(`${getAgentName('MASTER_AGENT')} is routing your request\u2026`);
        let agentType: "GREETING" | "GENERAL_FAQ" | "SQL_FAQ" | "MCP_TOOL" | "SQL_REFINE" | "WIKI" | "DMCR" = "DMCR";
        const t0Master = Date.now();
        let masterClassification = '';
        const masterPrompt = getResolvedPrompt('MASTER_AGENT');
        const masterUserMsg = getResolvedUserPrompt('MASTER_AGENT', chatVars);
        // No answer from the provider (down, timed out) is an error the chat shows; only an answer DMCR cannot
        // read falls back to DMCR generation. (A question became an unasked change request before.)
        masterClassification = await callLlm(masterPrompt, masterUserMsg, 0);
        try {
          const jsonStart = masterClassification.indexOf('{');
          const jsonEnd   = masterClassification.lastIndexOf('}');
          if (jsonStart !== -1 && jsonEnd > jsonStart) {
            const parsed = JSON.parse(masterClassification.slice(jsonStart, jsonEnd + 1));
            const agent = parsed.agent === 'FAQ' ? 'GENERAL_FAQ' : parsed.agent;
            if (['GREETING', 'GENERAL_FAQ', 'SQL_FAQ', 'MCP_TOOL', 'SQL_REFINE', 'WIKI', 'DMCR'].includes(agent)) {
              agentType = agent;
            }
            const questionRe = /^(what|how|why|when|where|explain|tell|describe|is|are|can|does|do|who|which)\b/i;
            if (agentType === 'DMCR' && (parsed.confidence ?? 1) < 0.6 && questionRe.test(userText.trim())) {
              agentType = 'GENERAL_FAQ';
            }
            // If SQL_REFINE but no prior SQL exists in this conversation, fall back to DMCR
            if (agentType === 'SQL_REFINE') {
              const priorSql = getConversationSql(conversationId);
              if (!priorSql) agentType = 'DMCR';
            }
          }
        } catch { /* an answer that is not the expected JSON: default to DMCR */ }
        insertAudit({ conversation_id: conversationId, stage: 'MASTER_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: masterPrompt, user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: masterPrompt.slice(0, 2000) }, { role: 'user', content: resolvedUserText.slice(0, 2000) }], temperature: 0 }), response_payload: JSON.stringify({ classification: masterClassification, routed_to: agentType }), duration_ms: Date.now() - t0Master, meta: JSON.stringify({ userInput: userText, routedTo: agentType }) });

        // ─── Step 2: Route to correct agent ───
        if (agentType === 'GREETING') {
          progress2(`${getAgentName('GREETING_AGENT')} responding\u2026`);
          const t0g = Date.now();
          const greetingPrompt = getResolvedPrompt('GREETING_AGENT');
          const greetingUserMsg = getResolvedUserPrompt('GREETING_AGENT', chatVars);
          const reply = await callLlm(greetingPrompt, greetingUserMsg, 0.7);
          insertAudit({ conversation_id: conversationId, stage: 'GREETING_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: greetingPrompt, user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: greetingPrompt.slice(0, 2000) }, { role: 'user', content: resolvedUserText.slice(0, 2000) }], temperature: 0.7 }), response_payload: JSON.stringify({ text: reply }), duration_ms: Date.now() - t0g, meta: JSON.stringify({ userInput: userText }) });
          webview.postMessage({ type: "reply", msgId, text: JSON.stringify({ type: "text", rawText: reply }) });

        } else if (agentType === 'GENERAL_FAQ') {
          progress2(`${getAgentName('GENERAL_FAQ_AGENT')} answering\u2026`);
          const t0f = Date.now();
          const faqPrompt = getResolvedPrompt('GENERAL_FAQ_AGENT');
          const faqUserMsg = getResolvedUserPrompt('GENERAL_FAQ_AGENT', chatVars);
          const reply = await callLlm(faqPrompt, faqUserMsg, 0.3);
          insertAudit({ conversation_id: conversationId, stage: 'GENERAL_FAQ_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: faqPrompt, user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: faqPrompt.slice(0, 2000) }, { role: 'user', content: faqUserMsg.slice(0, 2000) }], temperature: 0.3 }), response_payload: JSON.stringify({ text: reply }), duration_ms: Date.now() - t0f, meta: JSON.stringify({ userInput: userText }) });
          webview.postMessage({ type: "reply", msgId, text: JSON.stringify({ type: "text", rawText: reply }) });

        } else if (agentType === 'SQL_FAQ') {
          progress2(`${getAgentName('SQL_FAQ_AGENT')} answering\u2026`);
          const t0sf = Date.now();
          // The live database tools (the MCP servers DMCR keeps for test / prod, plus any you added),
          // and what ${schema} is on each environment, so "tables in ${schema}" can be answered.
          const sqlFaqTools = await buildMcpToolsPrompt();
          let envSection = '';
          try {
            const { cfgEnvSchemas, managedId } = await import('../../../services/mcp/server/env-servers.js');
            const schemas = cfgEnvSchemas();
            const lines = Object.entries(schemas).map(([env, sch]) => `  ${env}: \${schema} = ${sch} · its database server is "${managedId(env)}" (call its tools as "${managedId(env)}.<tool>")`);
            if (lines.length) envSection = `\n\n━━━ ENVIRONMENTS (DMCR Config) ━━━\nChange files write \${schema}; it means a different schema on each database. When the user says \${schema} without naming an environment, answer for the first one (the active environment) and say which.\n${lines.join('\n')}`;
          } catch { /* no DMCR Config: tools only */ }
          const sqlFaqPrompt = getResolvedPrompt('SQL_FAQ_AGENT', { ...chatVars, toolList: sqlFaqTools }) + envSection;
          const sqlFaqUserMsg = getResolvedUserPrompt('SQL_FAQ_AGENT', chatVars);
          // the tool calls and the AI requests show as steps in the Assistant's progress card
          const { withActivity: withActivitySf } = await import('../../../services/activity.js');
          const postActivitySf = (event: unknown) => webview.postMessage({ type: 'genActivity', payload: { form: 'conversation', event } });
          let reply = await withActivitySf(postActivitySf, activeFamily2 || 'AI', async () => {
            const first = await callLlm(sqlFaqPrompt, sqlFaqUserMsg, 0.3);
            // it asked for tools: run them (read-only), then answer from their results
            let calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
            try {
              const a = first.indexOf('{'), b = first.lastIndexOf('}');
              if (sqlFaqTools && first.includes('"mcpToolCalls"') && a !== -1 && b > a) {
                const parsed = JSON.parse(first.slice(a, b + 1));
                if (Array.isArray(parsed.mcpToolCalls)) calls = parsed.mcpToolCalls;
              }
            } catch { /* not a tool request */ }
            if (!calls.length) return first;
            progress2(`Reading the database (${calls.length} tool call${calls.length === 1 ? '' : 's'})\u2026`);
            const results = await executeMcpToolCalls(calls, conversationId);
            progress2('Writing the answer\u2026');
            return callLlm(sqlFaqPrompt + '\n\n' + buildMcpResultsPrompt(results),
              `Based on the tool results above, answer in clear markdown (do not request more tools):\n\n${resolvedUserText}`, 0.3);
          });
          insertAudit({ conversation_id: conversationId, stage: 'SQL_FAQ_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: sqlFaqPrompt, user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: sqlFaqPrompt.slice(0, 2000) }, { role: 'user', content: sqlFaqUserMsg.slice(0, 2000) }], temperature: 0.3 }), response_payload: JSON.stringify({ text: reply }), duration_ms: Date.now() - t0sf, meta: JSON.stringify({ userInput: userText }) });

          // Check if the agent wants to delegate to another agent via agentPoolCall
          if (reply.includes('"agentPoolCall"')) {
            try {
              const jsonStart = reply.indexOf('{');
              const jsonEnd = reply.lastIndexOf('}');
              if (jsonStart !== -1 && jsonEnd > jsonStart) {
                const parsed = JSON.parse(reply.slice(jsonStart, jsonEnd + 1));
                if (parsed.agentPoolCall?.agent) {
                  progress2(`Delegating to ${parsed.agentPoolCall.agent}\u2026`);
                  const poolResult = await executeAgentPoolCall(
                    parsed.agentPoolCall.agent,
                    { ...parsed.agentPoolCall.params, userMessage: resolvedUserText },
                    conversationId,
                    { extensionPath: ctx.extensionPath },
                  );
                  if (poolResult.success) {
                    // The delegated agent returned a DmcrChange JSON — forward it
                    const delegateReply = poolResult.result;
                    try {
                      const delegateJson = JSON.parse(delegateReply.slice(delegateReply.indexOf('{'), delegateReply.lastIndexOf('}') + 1));
                      if (delegateJson.deploySql) {
                        saveConversationSql({ conversation_id: conversationId, change_name: delegateJson.changeName, deploy_sql: delegateJson.deploySql, verify_sql: delegateJson.verifySql || '', revert_sql: delegateJson.revertSql || '', meta_json: delegateJson.metaJson || null });
                        const dmcrPayload = { type: "DmcrChange" as const, changeName: delegateJson.changeName, deploySql: delegateJson.deploySql, verifySql: delegateJson.verifySql || '', revertSql: delegateJson.revertSql || '', metaJson: delegateJson.metaJson ?? undefined };
                        webview.postMessage({ type: "reply", msgId, text: JSON.stringify(dmcrPayload) });
                        webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
                        return true;
                      }
                    } catch { /* not a DmcrChange JSON, send as text */ }
                    reply = delegateReply;
                  }
                }
              }
            } catch { /* agentPoolCall parse failed, send original reply */ }
          }
          webview.postMessage({ type: "reply", msgId, text: JSON.stringify({ type: "text", rawText: reply }) });

        } else if (agentType === 'WIKI') {
          progress2(`${getAgentName('WIKI_AGENT')} is searching documentation\u2026`);
          const t0w = Date.now();
          const wikiContext  = searchWiki(resolvedUserText, ctx.extensionPath, 4);
          const wikiPrompt   = getResolvedPrompt('WIKI_AGENT', { context: wikiContext });
          const wikiUserMsg  = getResolvedUserPrompt('WIKI_AGENT', chatVars);
          const reply = await callLlm(wikiPrompt, wikiUserMsg, 0.3);
          insertAudit({ conversation_id: conversationId, stage: 'WIKI_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: wikiPrompt, user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: wikiPrompt.slice(0, 2000) }, { role: 'user', content: wikiUserMsg.slice(0, 2000) }], temperature: 0.3 }), response_payload: JSON.stringify({ text: reply }), duration_ms: Date.now() - t0w, meta: JSON.stringify({ userInput: userText }) });
          webview.postMessage({ type: "reply", msgId, text: JSON.stringify({ type: "text", rawText: reply }) });

        } else if (agentType === 'SQL_REFINE') {
          // ─── SQL Refine Agent — modify previously generated SQL ───
          progress2(`${getAgentName('SQL_REFINE_AGENT')} refining your change\u2026`);
          const t0r = Date.now();
          const priorSql = getConversationSql(conversationId)!;
          const refineVars: Record<string, string> = {
            previousChangeName: priorSql.change_name,
            previousDeploySql:  priorSql.deploy_sql,
            previousVerifySql:  priorSql.verify_sql,
            previousRevertSql:  priorSql.revert_sql,
            previousMetaJson:   priorSql.meta_json || '{}',
            userMessage:        resolvedUserText,
          };
          const refinePrompt   = getResolvedPrompt('SQL_REFINE_AGENT', refineVars);
          const refineUserMsg  = getResolvedUserPrompt('SQL_REFINE_AGENT', refineVars);
          const refineReply = await callLlm(refinePrompt, refineUserMsg, 0.2);

          // Parse the JSON response from the refine agent
          let refinedChange: { changeName: string; deploySql: string; verifySql: string; revertSql: string; metaJson?: string } | null = null;
          try {
            const jsonStart = refineReply.indexOf('{');
            const jsonEnd   = refineReply.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd > jsonStart) {
              refinedChange = JSON.parse(refineReply.slice(jsonStart, jsonEnd + 1));
            }
          } catch { /* parse failure handled below */ }

          if (refinedChange && refinedChange.deploySql) {
            // Merge meta: use refined metaJson if provided, otherwise carry forward prior
            const finalMetaJson = refinedChange.metaJson || priorSql.meta_json || null;
            // Persist the refined SQL for subsequent refine calls
            saveConversationSql({
              conversation_id: conversationId,
              change_name: refinedChange.changeName || priorSql.change_name,
              deploy_sql: refinedChange.deploySql,
              verify_sql: refinedChange.verifySql || '',
              revert_sql: refinedChange.revertSql || '',
              meta_json: finalMetaJson,
            });
            insertAudit({ conversation_id: conversationId, stage: 'SQL_REFINE_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: refinePrompt.slice(0, 500), user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: refinePrompt.slice(0, 2000) }, { role: 'user', content: refineUserMsg.slice(0, 2000) }], temperature: 0.2 }), response_payload: JSON.stringify({ raw: refineReply.slice(0, 4000) }), duration_ms: Date.now() - t0r, meta: JSON.stringify({ userInput: userText, priorChangeName: priorSql.change_name }) });
            const dmcrPayload = { type: "DmcrChange" as const, changeName: refinedChange.changeName || priorSql.change_name, deploySql: refinedChange.deploySql, verifySql: refinedChange.verifySql || '', revertSql: refinedChange.revertSql || '', metaJson: finalMetaJson ?? undefined };
            webview.postMessage({ type: "reply", msgId, text: JSON.stringify(dmcrPayload) });
          } else {
            // Refine failed to return valid JSON — send as text
            insertAudit({ conversation_id: conversationId, stage: 'SQL_REFINE_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: refinePrompt.slice(0, 500), user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: refinePrompt.slice(0, 2000) }, { role: 'user', content: refineUserMsg.slice(0, 2000) }], temperature: 0.2 }), response_payload: JSON.stringify({ text: refineReply }), duration_ms: Date.now() - t0r, error: 'Failed to parse refined SQL JSON', meta: JSON.stringify({ userInput: userText }) });
            webview.postMessage({ type: "reply", msgId, text: JSON.stringify({ type: "text", rawText: refineReply }) });
          }

        } else if (agentType === 'MCP_TOOL') {
          // ─── MCP Tool Agent — discover tools, call them, synthesize answer ───
          progress2(`${getAgentName('MCP_TOOL_AGENT')} discovering tools…`);
          const t0mcp = Date.now();

          // Configured connections for second_conn — as references only. The model never sees
          // the URL (which usually contains a password); DMCR substitutes it when calling the tool.
          const configuredServers = getConfiguredMcpServers() as McpServerConfig[];
          const connLines: string[] = [];
          for (const srv of configuredServers) {
            if (hasServerConn(srv)) connLines.push(`  ${srv.name}: ${connRef(srv.id)}`);
          }
          const configuredConnsSection = connLines.length > 0
            ? `\n\n━━━ CONFIGURED CONNECTIONS (use for second_conn) ━━━\nPass the reference exactly as shown (e.g. "second_conn": "${connRef(configuredServers[0]?.id ?? 'server-id')}"); DMCR replaces it with the real connection.\n${connLines.join('\n')}`
            : '';

          const toolsPrompt = await buildMcpToolsPrompt();
          const mcpToolAgentPrompt = getResolvedPrompt('MCP_TOOL_AGENT', { toolList: toolsPrompt }) + configuredConnsSection;
          const mcpToolAgentUserMsg = getResolvedUserPrompt('MCP_TOOL_AGENT', chatVars);

          const firstReply = await callLlm(mcpToolAgentPrompt, mcpToolAgentUserMsg, 0.1);

          // Check for SchemaServerPicker — agent signals it needs user to pick a server
          let schemaPickerPayload: { type: string; question: string; servers: { id: string; name: string; connAvailable: boolean }[] } | null = null;
          let toolCallsToExecute: Array<{ tool: string; args: Record<string, unknown> }> = [];
          try {
            const jsonStart = firstReply.indexOf('{');
            const jsonEnd   = firstReply.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd > jsonStart) {
              const parsed = JSON.parse(firstReply.slice(jsonStart, jsonEnd + 1));
              if (parsed.type === 'SchemaServerPicker') {
                // Populate servers from config — agent leaves them empty
                schemaPickerPayload = {
                  type: 'SchemaServerPicker',
                  question: parsed.question ?? 'Which database would you like to compare against?',
                  servers: configuredServers.map(s => ({
                    id: s.id,
                    name: s.name,
                    connAvailable: hasServerConn(s),
                  })),
                };
              } else if (parsed.mcpToolCalls && Array.isArray(parsed.mcpToolCalls)) {
                toolCallsToExecute = parsed.mcpToolCalls;
              }
            }
          } catch { /* no tool calls */ }

          if (schemaPickerPayload) {
            // Return interactive picker — no LLM synthesis needed
            insertAudit({ conversation_id: conversationId, stage: 'MCP_TOOL_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: mcpToolAgentPrompt.slice(0, 500), user_prompt: resolvedUserText, request_payload: JSON.stringify({ type: 'SchemaServerPicker' }), response_payload: JSON.stringify(schemaPickerPayload), duration_ms: Date.now() - t0mcp, meta: JSON.stringify({ userInput: userText, interactivePicker: true }) });
            webview.postMessage({ type: 'reply', msgId, text: JSON.stringify(schemaPickerPayload) });
          } else {
            let finalReply = '';
            if (toolCallsToExecute.length > 0) {
              progress2(`Executing ${toolCallsToExecute.length} MCP tool call(s)…`);
              const toolResults = await executeMcpToolCalls(toolCallsToExecute, conversationId);
              const resultsContext = buildMcpResultsPrompt(toolResults);
              const synthesisPrompt = mcpToolAgentPrompt + '\n\n' + resultsContext;
              const synthesisUserMsg = `Based on the MCP tool results above, provide a clear human-readable markdown answer to:\n\n${resolvedUserText}`;
              progress2('Synthesizing results…');
              finalReply = await callLlm(synthesisPrompt, synthesisUserMsg, 0.3);
            } else {
              finalReply = firstReply;
            }
            insertAudit({ conversation_id: conversationId, stage: 'MCP_TOOL_AGENT_OUTPUT', model: activeFamily2 || 'copilot', system_prompt: mcpToolAgentPrompt.slice(0, 500), user_prompt: resolvedUserText, request_payload: JSON.stringify({ messages: [{ role: 'system', content: mcpToolAgentPrompt.slice(0, 2000) }, { role: 'user', content: mcpToolAgentUserMsg.slice(0, 2000) }], temperature: 0.1 }), response_payload: JSON.stringify({ text: finalReply.slice(0, 4000) }), duration_ms: Date.now() - t0mcp, meta: JSON.stringify({ userInput: userText, toolCallsExecuted: toolCallsToExecute.map(t => t.tool) }) });
            webview.postMessage({ type: 'reply', msgId, text: JSON.stringify({ type: 'text', rawText: finalReply }) });
          }

        } else {
          // ─── DMCR Agent — ask for metadata FIRST, then generate ───
          progress2(`${getAgentName('DMCR_RULES')} preparing metadata\u2026`);

          const metaTags: string[] = [];
          // Guess from the user's words only, not the schema / name-hint context appended above
          // ("...unqualified table/function/sequence names" would tag every request 'function').
          const reqText = resolvedUserText.replace(schemaContext, '').replace(changeNameContext, '').trim();
          const upperReq = reqText.toUpperCase();
          if (/\bCREATE\s+TABLE\b/.test(upperReq)) metaTags.push('ddl', 'create-table');
          else if (/\bALTER\s+TABLE\b/.test(upperReq)) metaTags.push('ddl', 'alter-table');
          if (/\bADD\s+COLUMN\b/.test(upperReq) || /\bADD\b/.test(upperReq)) metaTags.push('schema');
          if (/\bINSERT\b/.test(upperReq)) metaTags.push('data-migration');
          if (/\bGRANT\b/.test(upperReq)) metaTags.push('permissions');
          if (/\bDROP\b/.test(upperReq)) metaTags.push('destructive');
          if (/\bINDEX\b/.test(upperReq)) metaTags.push('index');
          if (/\bFUNCTION\b/.test(upperReq)) metaTags.push('function');
          if (/\bVIEW\b/.test(upperReq)) metaTags.push('view');
          const uniqueTags = [...new Set(metaTags)];

          const metaAuthor = process.env.USER || process.env.USERNAME || '';

          const existingChanges: string[] = [];
          if (ws2) {
            const { resolveChangesDir } = await import('../../../storage/changes-dir.js');
            try {
              const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(resolveChangesDir()));
              for (const [name, kind] of entries) {
                if (kind === vscode.FileType.Directory && /^\d+_/.test(name)) existingChanges.push(name);
              }
              existingChanges.sort(compareChangeIds);
            } catch { /* no changes dir yet */ }
          }

          // Requires: only what the request points at. Guessing "the latest changes" would tie
          // unrelated work together (project B's change requiring project A's blocks deploying B alone).
          const suggestedRequires = existingChanges.filter(id => reqText.includes(id));
          const tableNames = new Set((reqText.toLowerCase().match(/\b[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?\b/g) ?? [])
            .filter(w => w.includes('_') || w.includes('.'))
            .map(w => w.split('.').pop()!));
          if (ws2 && tableNames.size) {
            const { resolveChangesDir } = await import('../../../storage/changes-dir.js');
            for (const id of existingChanges) {
              if (suggestedRequires.includes(id)) continue;
              try {
                const sql = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(resolveChangesDir(), id, 'deploy.sql')))).toString('utf8');
                // the schema may be the ${schema} placeholder
                const created = [...sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?[a-z_][a-z0-9_]*"?|\$\{[a-z_][a-z0-9_]*\})\.)?"?([a-z_][a-z0-9_]*)"?/gi)].map(m => m[1].toLowerCase());
                if (created.some(t => tableNames.has(t))) suggestedRequires.push(id);
              } catch { /* no deploy.sql */ }
            }
            suggestedRequires.sort(compareChangeIds);
          }
          const firstSentence = reqText.split(/(?<=[.!?])\s/)[0];
          const suggestedDescription = firstSentence.length <= 200 ? firstSentence : firstSentence.slice(0, 200).replace(/\s+\S*$/, '') + '…';

          const pendingId = `${conversationId}:${msgId ?? Date.now()}`;
          const metaFormPayload = {
            type: "DmcrMetadataForm" as const,
            pendingId,
            changeName: '(will be generated)',
            suggestedTags: uniqueTags,
            suggestedRequires,
            suggestedAuthor: metaAuthor,
            suggestedDescription,
            existingChanges,
          };

          ctx.state.pendingGenerations[pendingId] = {
            msgId: msgId!,
            contextualUserText: historyCtx + resolvedUserText,
            dmcrContext: dmcrCtx2,
            conversationId,
            fullUserText,
            changeNameHint,
          };

          webview.postMessage({ type: "reply", msgId, text: JSON.stringify(metaFormPayload) });
        }

        webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
      } catch (err2: unknown) {
        const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
        webview.postMessage({ type: "error", msgId, text: errMsg2 });
        webview.postMessage({ type: 'sseEvent', stage: 'ENGINE_RETURN', data: '{}' });
      }
      return true;
    }

    default:
      return false;
  }
}
