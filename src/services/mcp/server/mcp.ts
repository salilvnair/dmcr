/**
 * MCP (Model Context Protocol) service.
 *
 * Stores server configs in SQLite. Supports two transports:
 *   • HTTP  — JSON-RPC POST to a remote/local endpoint
 *   • STDIO — spawns a subprocess (e.g. `python -m app_mcp.server`)
 *             and speaks MCP JSON-RPC over stdin/stdout.
 *
 * Ported from ck8t's working MCP implementation.
 */
import { redactText } from '../../security/redact';
import { spawn, ChildProcess } from 'child_process';
import { upsert, remove, findById, findAll } from '../../../storage/db';

// ── Types ────────────────────────────────────────────────────────────────────

/** Server capability category — determines which UI surfaces are enabled. */
export type McpServerCategory = 'database' | 'general' | 'docs' | 'code';

export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  url: string;
  /** Canonical transport stored internally */
  type: 'http' | 'sse' | 'stdio';
  /** Alias used by the React UI (STDIO | HTTP | SSE). Mapped to/from `type` at the boundary. */
  transport?: 'STDIO' | 'HTTP' | 'SSE';
  /** Capability category — controls which UI features are exposed for this server.
   * 'database' → enables Schema Explorer tree view
   * 'general'  → tool-calling only
   * 'docs'     → documentation retrieval
   * 'code'     → code analysis tools
   */
  category?: McpServerCategory;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for stdio subprocess. If set, the server is launched from this path so it can find config files (e.g. app_mcp.yml) relative to its project root. */
  cwd?: string;
  headers?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export function initMcpService(_storagePath: string) {
  // db is already initialised by initDb() in extension.ts activate()
}

/* ── Tool cache (per server, evicted on refresh) ── */
const _toolCache = new Map<string, McpTool[]>();

/* ── Transport type helpers ── */

/** Normalise the UI field (`transport: 'STDIO'`) to the internal `type` field. */
function uiTransportToType(transport: string | undefined): McpServerConfig['type'] {
  if (!transport) return 'http';
  switch (transport.toUpperCase()) {
    case 'STDIO': return 'stdio';
    case 'SSE':   return 'sse';
    default:      return 'http';
  }
}

/** Expose both `type` and `transport` on outbound objects so the React UI works. */
function withTransport(server: McpServerConfig): McpServerConfig {
  const map: Record<string, McpServerConfig['transport']> = {
    stdio: 'STDIO', sse: 'SSE', http: 'HTTP',
  };
  return { ...server, transport: map[server.type] ?? 'HTTP' };
}

/* ── CRUD ── */

export function listServers(): McpServerConfig[] {
  return findAll<McpServerConfig>('mcpServers').map(withTransport);
}

export function upsertServer(cfg: Record<string, unknown>): McpServerConfig {
  const id  = (cfg.id as string) || `mcp_${Date.now()}`;
  const now = new Date().toISOString();
  const existing = findById<McpServerConfig>('mcpServers', id);

  // Accept either `type` (internal) or `transport` (from React UI)
  const resolvedType = (cfg.type as McpServerConfig['type']) ?? ((cfg.transport as string) ? uiTransportToType(cfg.transport as string) : existing?.type ?? 'http');

  const server: McpServerConfig = {
    id,
    name:        (cfg.name as string)    ?? existing?.name    ?? 'Unnamed',
    description: (cfg.description as string) ?? existing?.description,
    url:         (cfg.url as string)     ?? existing?.url     ?? '',
    type:        resolvedType,
    category:    (cfg.category as McpServerCategory) ?? existing?.category,
    command:     (cfg.command as string)   ?? existing?.command,
    args:        (cfg.args as string[])    ?? existing?.args,
    env:         (cfg.env as Record<string, string>)     ?? existing?.env,
    cwd:         (cfg.cwd as string)       ?? existing?.cwd,
    headers:     (cfg.headers as Record<string, string>) ?? existing?.headers,
    createdAt:   existing?.createdAt ?? now,
    updatedAt:   now,
  };
  upsert<McpServerConfig>('mcpServers', id, server);
  _toolCache.delete(id);
  // Kill any running stdio process so next call re-spawns with new config
  killStdioProcess(id);
  return withTransport(server);
}

/** List only servers tagged with category='database'. */
export function listDatabaseServers(): McpServerConfig[] {
  return listServers().filter(s => s.category === 'database');
}

/**
 * Auto-detect server category by inspecting discovered tool descriptions.
 * Returns 'database' if schema/table/column-related tools are found.
 */
export async function detectServerCategory(id: string): Promise<McpServerCategory> {
  try {
    const tools = await mcpListTools(id);
    const hasDbTools = tools.some(t => {
      const desc = (t.description || '').toLowerCase();
      const name = t.name.toLowerCase();
      return (
        (/schema|table|column|database|pg_|postgres|mysql|sql/i.test(desc) &&
         /list|discover|describe|query|introspect/i.test(desc)) ||
        /list_schemas|list_tables|describe_table|query|pg_|get_schema/i.test(name)
      );
    });
    return hasDbTools ? 'database' : 'general';
  } catch {
    return 'general';
  }
}

export function deleteServer(id: string): { ok: boolean } {
  remove('mcpServers', id);
  _toolCache.delete(id);
  killStdioProcess(id);
  return { ok: true };
}

/** Kill the running process (if any) and clear the tool cache, then re-fetch tools.
 *  Use this after editing app_mcp.yml or any external config the server reads at startup. */
export async function restartServer(id: string): Promise<McpTool[]> {
  _toolCache.delete(id);
  killStdioProcess(id);
  return mcpListTools(id, true);
}

/* ── Tool discovery ── */

export async function mcpListTools(serverId: string, refresh = false): Promise<McpTool[]> {
  if (!refresh && _toolCache.has(serverId)) {
    return _toolCache.get(serverId)!;
  }
  const server = getServerOrThrow(serverId);
  const tools = await mcpListToolsFromServer(server);
  _toolCache.set(serverId, tools);
  return tools;
}

/* ── Tool invocation ── */

export async function mcpCallTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const server = getServerOrThrow(serverId);
  return mcpCallToolOnServer(server, toolName, args);
}

/* ── Helpers ── */

function getServerOrThrow(serverId: string): McpServerConfig {
  const server = findById<McpServerConfig>('mcpServers', serverId);
  if (!server) throw new Error(`MCP server "${serverId}" not found`);
  return server;
}

/* ════════════════════════════════════════════════════════════════
   HTTP JSON-RPC transport
   ════════════════════════════════════════════════════════════════ */

let _rpcId = 1;

interface McpRpcResponse {
  id?: number;
  result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
  error?: { message: string };
  [k: string]: unknown;
}

async function httpRpc(
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<McpRpcResponse> {
  const id   = _rpcId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(server.headers ?? {}),
  };
  const res = await fetch(server.url, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP server "${server.name}" HTTP ${res.status}: ${text}`);
  }
  const data = (await res.json()) as McpRpcResponse;
  if (data.error) throw new Error(`MCP error from "${server.name}": ${data.error.message}`);
  return data;
}

/* ════════════════════════════════════════════════════════════════
   STDIO transport  (child_process — persistent session per server)
   ════════════════════════════════════════════════════════════════ */

interface StdioSession {
  proc:     ChildProcess;
  pending:  Map<number, { resolve(v: McpRpcResponse): void; reject(e: Error): void }>;
  buf:      string;
  ready:    boolean;
}

const _stdioSessions = new Map<string, StdioSession>();

function killStdioProcess(serverId: string) {
  const s = _stdioSessions.get(serverId);
  if (!s) return;
  try { s.proc.kill(); } catch { /* ignore */ }
  for (const p of s.pending.values()) p.reject(new Error('MCP process killed'));
  s.pending.clear();
  _stdioSessions.delete(serverId);
}

async function getOrCreateStdioSession(server: McpServerConfig): Promise<StdioSession> {
  const existing = _stdioSessions.get(server.id);
  if (existing && existing.proc.exitCode === null) {
    console.log(`[mcp-stdio] reusing existing session for "${server.name}" (pid ${existing.proc.pid})`);
    return existing;
  }

  if (!server.command) throw new Error(`MCP server "${server.name}" has no command configured`);

  const env  = { ...process.env, ...(server.env ?? {}) };
  const spawnOpts: import('child_process').SpawnOptions = { env, stdio: ['pipe', 'pipe', 'pipe'] };
  if (server.cwd) spawnOpts.cwd = server.cwd;
  const proc = spawn(server.command, server.args ?? [], spawnOpts);

  const session: StdioSession = { proc, pending: new Map(), buf: '', ready: false };
  _stdioSessions.set(server.id, session);

  proc.stdout!.on('data', (chunk: Buffer) => {
    session.buf += chunk.toString();
    // MCP messages are newline-delimited JSON
    const lines = session.buf.split('\n');
    session.buf = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: McpRpcResponse;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (msg.id != null) {
        const p = session.pending.get(msg.id as number);
        if (p) { session.pending.delete(msg.id as number); p.resolve(msg); }
      }
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    console.warn(`[mcp-stdio] "${server.name}" stderr:`, redactText(chunk.toString().trim()));
  });

  proc.on('exit', (code) => {
    console.log(`[mcp-stdio] "${server.name}" exited (code ${code})`);
    for (const p of session.pending.values()) p.reject(new Error(`MCP process "${server.name}" exited`));
    session.pending.clear();
    _stdioSessions.delete(server.id);
  });

  // MCP handshake: initialize → initialized notification
  await stdioRpc(session, server, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dmcr', version: '1.1.0' },
  });
  // Send the required 'notifications/initialized' notification (no response expected)
  proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  session.ready = true;
  return session;
}

function stdioRpc(
  session: StdioSession,
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<McpRpcResponse> {
  const id  = _rpcId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`MCP STDIO timeout for "${method}" on "${server.name}"`));
    }, 30_000);
    session.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    session.proc.stdin!.write(msg);
  });
}

/* ════════════════════════════════════════════════════════════════
   Unified dispatch — picks transport based on server.type
   ════════════════════════════════════════════════════════════════ */

async function mcpRpc(
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<McpRpcResponse> {
  if (server.type === 'stdio') {
    const session = await getOrCreateStdioSession(server);
    return stdioRpc(session, server, method, params);
  }
  return httpRpc(server, method, params);
}

async function mcpListToolsFromServer(server: McpServerConfig): Promise<McpTool[]> {
  try {
    const res   = await mcpRpc(server, 'tools/list', {});
    const tools = (res.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> })?.tools ?? [];
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  } catch (err: unknown) {
    console.warn(`[mcp] listTools failed for "${server.name}":`, err);
    return [];
  }
}

async function mcpCallToolOnServer(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await mcpRpc(server, 'tools/call', { name: toolName, arguments: args });
  return res.result ?? res;
}

/* ── Cleanup (called from extension.ts deactivate) ── */
export function disposeMcpService() {
  for (const id of [..._stdioSessions.keys()]) killStdioProcess(id);
}
