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

const PG_URL = /^(postgresql|postgres):\/\//;
const ENV_KEYS = ['DATABASE_URL', 'PG_CONN', 'PG_DSN', 'POSTGRES_URL', 'DB_URL'];

/** Find an embedded PostgreSQL connection URL in a server's args or env. */
export function extractServerConnUrl(server: { args?: string[]; env?: Record<string, string> }): string | null {
  for (const arg of server.args ?? []) {
    if (PG_URL.test(arg)) { return arg; }
  }
  for (const key of ENV_KEYS) {
    const val = server.env?.[key];
    if (val && PG_URL.test(val)) { return val; }
  }
  return null;
}

/** The placeholder an LLM sees instead of a server's connection URL. */
export function connRef(serverId: string): string {
  return `@conn:${serverId}`;
}

/**
 * Replace `@conn:<server id or name>` string values (at any depth) with the real connection
 * URL of that server. Unknown references are left as-is so the tool reports a clear error.
 */
export function resolveConnRefs<T>(value: T): T {
  if (typeof value === 'string') {
    const m = /^@conn:(.+)$/.exec(value.trim());
    if (!m) { return value; }
    const ref = m[1].trim();
    const server = listServers().find(s => s.id === ref || s.name === ref);
    return ((server && extractServerConnUrl(server)) || value) as unknown as T;
  }
  if (Array.isArray(value)) { return value.map(v => resolveConnRefs(v)) as unknown as T; }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out[k] = resolveConnRefs(v); }
    return out as T;
  }
  return value;
}
