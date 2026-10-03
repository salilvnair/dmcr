/**
 * redact.ts
 * ─────────
 * Keep credentials out of logs, audit rows, prompts and process arguments.
 */

// postgresql://user:SECRET@host — password part of any scheme://user:pass@ URL
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@"']+:)([^@\s/"']+)(@)/gi;
// libpq key=value form: password=SECRET or password='SECRET'
const KV_PASSWORD = /(\bpassword\s*=\s*)('(?:[^'\\]|\\.)*'|[^\s"',;]+)/gi;
// "Authorization": "Bearer x", "x-api-key": "x", api_key=x  (JSON or header text)
const HEADER_SECRET = /("?(?:authorization|x-api-key|api[-_]?key|apikey|access[-_]?token)"?\s*[:=]\s*"?)(?:bearer\s+)?([^"\s,}]+)/gi;
const SECRET_KEY = /^(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|access[-_]?token)$/i;

/** Mask passwords and API keys inside free text (prompts, JSON payloads, log lines). */
export function redactText(text: string): string {
  if (!text) { return text; }
  return text
    .replace(URL_PASSWORD, '$1****$3')
    .replace(KV_PASSWORD, '$1****')
    .replace(HEADER_SECRET, '$1****');
}

/** Deep-copy a value, masking secret-looking keys and passwords inside strings. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') { return redactText(value) as unknown as T; }
  if (Array.isArray(value)) { return value.map(v => redactSecrets(v)) as unknown as T; }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '****' : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Split the password out of a PostgreSQL connection string so it can be passed to psql
 * through PGPASSWORD instead of the command line (where any local user can read it).
 * Handles URL form (postgresql://user:pass@host/db) and key=value form (password=...).
 */
export function splitConnPassword(conn: string): { conn: string; password?: string } {
  const url = /^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):([^@\s]*)@(.*)$/i.exec(conn);
  if (url) {
    let password = url[2];
    try { password = decodeURIComponent(password); } catch { /* keep raw */ }
    return { conn: `${url[1]}@${url[3]}`, password };
  }
  const kv = /(^|\s)password\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/i.exec(conn);
  if (kv) {
    let password = kv[2];
    if (password.startsWith("'")) { password = password.slice(1, -1).replace(/\\(.)/g, '$1'); }
    return { conn: (conn.slice(0, kv.index) + conn.slice(kv.index + kv[0].length)).trim(), password };
  }
  return { conn };
}

// ── Masked secrets in settings (values kept in the OS keychain) ─────────────────

/** Shown in place of a stored secret. Saving it back unchanged keeps the stored value. */
export const SECRET_MASK = '********';
// Names (env vars, headers) whose whole value is treated as a secret.
const SECRET_NAME = /pass|secret|token|auth|api[-_]?key|credential|cookie|private[-_]?key/i;

/** Mask one named value: the whole value for secret-looking names, otherwise any embedded password. */
export function maskSecretValue(name: string, value: string): string {
  if (typeof value !== 'string' || value === '') { return value; }
  return SECRET_NAME.test(name) ? SECRET_MASK : redactText(value);
}

export function maskSecretMap(map?: Record<string, string>): Record<string, string> | undefined {
  if (!map) { return map; }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) { out[k] = maskSecretValue(k, v); }
  return out;
}

/** Put back stored values for entries the UI returned still masked. */
export function unmaskSecretMap(incoming: Record<string, string> | undefined, stored: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!incoming || !stored) { return incoming; }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const prev = stored[k];
    out[k] = prev !== undefined && v === maskSecretValue(k, prev) ? prev : v;
  }
  return out;
}

export function maskArgs(args?: string[]): string[] | undefined {
  return args ? args.map(a => redactText(a)) : args;
}

/** Put back stored arguments the UI returned still masked (e.g. a connection URL). */
export function unmaskArgs(incoming: string[] | undefined, stored: string[] | undefined): string[] | undefined {
  if (!incoming || !stored) { return incoming; }
  return incoming.map(a => stored.find(s => redactText(s) === a) ?? a);
}
