/**
 * MCP Agent Service — dynamic tool discovery and invocation for AI agents.
 *
 * Architecture:
 *   Master Agent → DMCR Agent → MCP Agent (this service)
 *                  DDL Agent  → MCP Agent
 *                  DML Agent  → MCP Agent
 *                  Freeform   → MCP Agent
 *
 * The MCP Agent:
 *   1. Connects to configured MCP servers (from Settings)
 *   2. Discovers available tools at runtime (list_tools)
 *   3. Calls tools on demand (call_tool)
 *   4. Returns results to the calling agent
 *   5. Delegates database-specific operations to mcp-db-agent.ts
 *
 * No hardcoded tool names — agents discover capabilities dynamically.
 *
 * Delegates to ./mcp.ts for actual transport (persistent stdio sessions, HTTP).
 * Delegates to ./mcp-db-agent.ts for all database schema/introspection work.
 */

import { listServers, mcpListTools, mcpCallTool as mcpCallToolDirect } from '../server/mcp';
import { resolveConnRefs } from '../server/conn-url';
import { MCP_AGENT_PREAMBLE, MCP_RESULTS_PREAMBLE } from '../../../forms/llm/prompts/prompt-template';
import { insertAudit } from '../../../storage/db';

// ── Re-export DB agent for callers that import from mcp-agent ────────────────
export {
  callSchemaCapability,
  callDbCapability,
  resolveSchemaCapabilities,
  resolveDbCapabilities,
  discoverAllSchemas,
  validateDbServer,
  discoverDbTools,
  REQUIRED_DB_CAPABILITIES,
  type SchemaCapability,
  type DbCapability,
  type DbServerValidation,
} from './mcp-db-agent';

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  transport: 'STDIO' | 'HTTP' | 'SSE';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

export interface McpToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

// ── MCP Agent ────────────────────────────────────────────────────────────────

/**
 * Get all configured MCP servers.
 */
export function getConfiguredMcpServers(): McpServerConfig[] {
  try {
    return listServers() as unknown as McpServerConfig[];
  } catch {
    return [];
  }
}

/**
 * Discover tools from ALL configured MCP servers.
 * Returns a flat list of tools with their server provenance.
 */
export async function discoverAllTools(): Promise<McpToolInfo[]> {
  const servers = listServers();
  if (!servers.length) return [];

  const results: McpToolInfo[] = [];
  for (const srv of servers) {
    try {
      const tools = await mcpListTools(srv.id);
      results.push(...tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        serverId: srv.id,
        serverName: srv.name,
      })));
    } catch {
      // Server unreachable — skip silently
    }
  }
  return results;
}

/**
 * Discover tools from a single MCP server.
 */
export async function discoverToolsFromServer(srv: { id: string; name: string }): Promise<McpToolInfo[]> {
  const tools = await mcpListTools(srv.id);
  return tools.map(t => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    serverId: srv.id,
    serverName: srv.name,
  }));
}

/**
 * Call a tool on an MCP server by tool name.
 * Automatically finds which server provides the tool.
 * Audits tool call + result/error to ce_audit (MCP_TOOL_CALL / MCP_TOOL_RESULT / MCP_TOOL_ERROR).
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  serverId?: string,
  conversationId?: string,
): Promise<McpToolResult> {
  const servers = listServers();
  const convId = conversationId ?? 'mcp-' + Date.now();
  const startMs = Date.now();
  // Audit rows keep the `@conn:` reference; only the outgoing call carries the real URL.
  const auditArgs = args;
  args = resolveConnRefs(args);
  console.log(`[mcp-agent] callMcpTool('${toolName}') — ${servers.length} server(s) configured`);

  // Audit: MCP_TOOL_CALL — record the intent before execution
  insertAudit({
    conversation_id: convId,
    stage: 'MCP_TOOL_CALL',
    request_payload: JSON.stringify({ tool: toolName, args: auditArgs }),
    meta: JSON.stringify({ serverId: serverId ?? 'auto', serverCount: servers.length }),
  });

  if (serverId) {
    try {
      console.log(`[mcp-agent] calling '${toolName}' on server '${serverId}' directly`);
      const result = await mcpCallToolDirect(serverId, toolName, args);
      const parsed = parseToolResult(result);
      const durationMs = Date.now() - startMs;
      // Audit: MCP_TOOL_RESULT
      insertAudit({
        conversation_id: convId,
        stage: 'MCP_TOOL_RESULT',
        request_payload: JSON.stringify({ tool: toolName, args: auditArgs }),
        response_payload: JSON.stringify(parsed.data),
        duration_ms: durationMs,
        meta: JSON.stringify({ serverId, tool: toolName }),
      });
      return parsed;
    } catch (e) {
      console.warn(`[mcp-agent] direct call to '${serverId}' failed:`, e);
      const durationMs = Date.now() - startMs;
      const errorMsg = e instanceof Error ? e.message : String(e);
      // Audit: MCP_TOOL_ERROR
      insertAudit({
        conversation_id: convId,
        stage: 'MCP_TOOL_ERROR',
        request_payload: JSON.stringify({ tool: toolName, args: auditArgs }),
        error: errorMsg,
        duration_ms: durationMs,
        meta: JSON.stringify({ serverId, tool: toolName, errorType: e instanceof Error ? e.constructor.name : typeof e }),
      });
      return { success: false, data: null, error: errorMsg };
    }
  }

  // Find which server has this tool — try each (cached, then refresh)
  for (let pass = 0; pass < 2; pass++) {
    const refresh = pass === 1;
    if (refresh) {
      console.log(`[mcp-agent] retrying with cache refresh for '${toolName}'…`);
    }
    for (const srv of servers) {
      try {
        console.log(`[mcp-agent] checking server '${srv.id}' (${srv.name}) for tool '${toolName}'${refresh ? ' [refresh]' : ''}…`);
        const tools = await mcpListTools(srv.id, refresh);
        console.log(`[mcp-agent]   → server '${srv.id}' has ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
        if (tools.some(t => t.name === toolName)) {
          console.log(`[mcp-agent]   → found '${toolName}' on '${srv.id}', calling…`);
          const result = await mcpCallToolDirect(srv.id, toolName, args);
          console.log(`[mcp-agent]   → call returned`);
          const parsed = parseToolResult(result);
          const durationMs = Date.now() - startMs;
          // Audit: MCP_TOOL_RESULT
          insertAudit({
            conversation_id: convId,
            stage: 'MCP_TOOL_RESULT',
            request_payload: JSON.stringify({ tool: toolName, args: auditArgs }),
            response_payload: JSON.stringify(parsed.data),
            duration_ms: durationMs,
            meta: JSON.stringify({ serverId: srv.id, serverName: srv.name, tool: toolName }),
          });
          return parsed;
        }
      } catch (err) {
        console.warn(`[mcp-agent]   → server '${srv.id}' threw:`, err);
        continue;
      }
    }
    // If first pass found nothing, retry with refresh
    if (pass === 0) continue;
  }

  const durationMs = Date.now() - startMs;
  const errorMsg = `No MCP server found with tool '${toolName}'`;
  console.warn(`[mcp-agent] ${errorMsg}`);
  // Audit: MCP_TOOL_ERROR (tool not found)
  insertAudit({
    conversation_id: convId,
    stage: 'MCP_TOOL_ERROR',
    request_payload: JSON.stringify({ tool: toolName, args: auditArgs }),
    error: errorMsg,
    duration_ms: durationMs,
    meta: JSON.stringify({ tool: toolName, reason: 'no_server_found' }),
  });
  return { success: false, data: null, error: errorMsg };
}

function parseToolResult(result: unknown): McpToolResult {
  // MCP results are in result.content[0].text
  const r = result as Record<string, unknown>;
  if (r?.content && Array.isArray(r.content)) {
    const text = (r.content[0] as Record<string, unknown>)?.text;
    if (typeof text === 'string') {
      try {
        return { success: true, data: JSON.parse(text) };
      } catch {
        return { success: true, data: text };
      }
    }
  }
  return { success: true, data: result };
}

/**
 * Build a prompt fragment describing available MCP tools for AI agents.
 * Uses MCP_AGENT_PREAMBLE from the Prompt Library + dynamic tool list.
 */
export async function buildMcpToolsPrompt(): Promise<string> {
  const tools = await discoverAllTools();
  if (!tools.length) return '';

  // Group tools by server and include server description as context
  const servers = listServers() as unknown as McpServerConfig[];
  const serverDescMap = new Map(servers.map(s => [s.id, { name: s.name, description: s.description }]));
  const byServer = new Map<string, typeof tools>();
  for (const tool of tools) {
    const arr = byServer.get(tool.serverId) ?? [];
    arr.push(tool);
    byServer.set(tool.serverId, arr);
  }

  const toolLines: string[] = ['', 'Available tools:'];

  for (const [serverId, serverTools] of byServer) {
    const info = serverDescMap.get(serverId);
    if (info?.description) {
      toolLines.push(`  [${info.name}]: ${info.description}`);
    }
    for (const tool of serverTools) {
      toolLines.push(`  - ${tool.name}: ${tool.description}`);
      if (tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>;
        const paramParts = Object.entries(props).map(([k, v]) => `${k}: ${v.type ?? 'any'}${v.description ? ` (${v.description})` : ''}`);
        if (paramParts.length) {
          toolLines.push(`    params: { ${paramParts.join(', ')} }`);
        }
      }
    }
  }

  return '\n' + MCP_AGENT_PREAMBLE + '\n' + toolLines.join('\n') + '\n';
}

/**
 * Execute MCP tool calls requested by an AI agent in its response.
 * Returns a map of tool_name → result for injection into a follow-up prompt.
 */
/** Tool names an LLM may not trigger on its own (write/exec/admin verbs). */
const DESTRUCTIVE_TOOL_NAME = /(^|[_\-.])(drop|delete|remove|truncate|insert|update|upsert|write|exec|execute|run_sql|shell|command|kill|terminate|move|rename|create|alter|grant|revoke|migrate|deploy|revert|apply)([_\-.]|$)/i;

export async function executeMcpToolCalls(
  toolCalls: Array<{ tool: string; args?: Record<string, unknown> }>,
  conversationId?: string,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const convId = conversationId ?? 'mcp-batch-' + Date.now();

  for (const call of toolCalls) {
    // Calls here are requested by an LLM: refuse tools whose names say they change things.
    const key = results[call.tool] === undefined ? call.tool : `${call.tool}#${Object.keys(results).length + 1}`;
    if (DESTRUCTIVE_TOOL_NAME.test(call.tool)) {
      insertAudit({ conversation_id: convId, stage: 'MCP_TOOL_BLOCKED', request_payload: JSON.stringify({ tool: call.tool, args: call.args ?? {} }), error: 'Blocked: tool name indicates it modifies data or runs commands' });
      results[key] = { error: `Tool '${call.tool}' was not run: DMCR only lets the AI call read-only tools.` };
      continue;
    }
    const result = await callMcpTool(call.tool, call.args ?? {}, undefined, convId);
    results[key] = result.success ? result.data : { error: result.error };
  }

  return results;
}

/**
 * Build a prompt fragment with MCP tool results for follow-up generation.
 * Uses MCP_RESULTS_PREAMBLE from the Prompt Library.
 */
export function buildMcpResultsPrompt(results: Record<string, unknown>): string {
  if (!Object.keys(results).length) return '';

  const lines = ['\n' + MCP_RESULTS_PREAMBLE];

  for (const [toolName, result] of Object.entries(results)) {
    lines.push(`\n--- ${toolName} ---`);
    lines.push(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  }

  return lines.join('\n');
}
