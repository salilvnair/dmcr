/**
 * conn-url.ts
 * ───────────
 * Connection URLs embedded in database MCP server configs, and the `@conn:` references
 * that stand in for them anywhere an LLM can see them.
 *
 * Prompts only ever contain `@conn:<server id>`; the real URL (which usually includes a
 * password) is substituted into tool arguments just before the tool is called.
 */

import { listServers } from './mcp';
import { ENV_REF, dmcrEnvConnUrl } from './env-ref';

const PG_URL = /^(postgresql|postgres):\/\//;
// APP_PG_CONN is what the bundled pgsql_mcp reads; the others are common conventions
const ENV_KEYS = ['APP_PG_CONN', 'DATABASE_URL', 'PG_CONN', 'PG_DSN', 'POSTGRES_URL', 'DB_URL'];

/** Find an embedded PostgreSQL connection URL in a server's args or env. */
export function extractServerConnUrl(server: { args?: string[]; env?: Record<string, string> }): string | null {
  for (const arg of server.args ?? []) {
    if (PG_URL.test(arg)) { return arg; }
    const flag = /^--?[\w-]+=(.+)$/.exec(arg);          // --conn=postgresql://…
    if (flag && PG_URL.test(flag[1])) { return flag[1]; }
  }
  for (const key of ENV_KEYS) {
    const val = server.env?.[key];
    if (val && PG_URL.test(val)) { return val; }
  }
  // Any other env var holding a PostgreSQL URL
  for (const val of Object.values(server.env ?? {})) {
    if (val && PG_URL.test(val)) { return val; }
  }
  return null;
}

/** The DMCR Config environment a server's env points at (`@env:<name>`), if any. */
function serverEnvRef(server: { env?: Record<string, string> }): string | undefined {
  for (const v of Object.values(server.env ?? {})) {
    const m = ENV_REF.exec(String(v ?? '').trim());
    if (m) { return m[1]; }
  }
  return undefined;
}

/** Whether a server has a connection: a typed URL or a DMCR Config environment (`@env:<name>`). */
export function hasServerConn(server: { args?: string[]; env?: Record<string, string> }): boolean {
  return !!extractServerConnUrl(server) || !!serverEnvRef(server);
}

/** A server's real connection URL: the typed one, else its DMCR Config environment's (URL + keychain password). */
export async function serverConnUrl(server: { args?: string[]; env?: Record<string, string> }): Promise<string | null> {
  const typed = extractServerConnUrl(server);
  if (typed) { return typed; }
  const env = serverEnvRef(server);
  return env ? (await dmcrEnvConnUrl(env)) ?? null : null;
}

/** The placeholder an LLM sees instead of a server's connection URL. */
export function connRef(serverId: string): string {
  return `@conn:${serverId}`;
}

/**
 * Replace `@conn:<server id or name>` string values (at any depth) with the real connection
 * URL of that server. Unknown references are left as-is so the tool reports a clear error.
 */
export async function resolveConnRefs<T>(value: T): Promise<T> {
  if (typeof value === 'string') {
    const m = /^@conn:(.+)$/.exec(value.trim());
    if (!m) { return value; }
    const ref = m[1].trim();
    const server = listServers().find(s => s.id === ref || s.name === ref);
    return ((server && await serverConnUrl(server)) || value) as unknown as T;
  }
  if (Array.isArray(value)) { return await Promise.all(value.map(v => resolveConnRefs(v))) as unknown as T; }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out[k] = await resolveConnRefs(v); }
    return out as T;
  }
  return value;
}
