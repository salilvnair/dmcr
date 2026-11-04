/**
 * ${name} placeholders in change SQL (e.g. ${schema}.zaps). The runner substitutes them per environment
 * ([test] schema = zp_st, [prod] schema = zp); DMCR's own analyzers see them through these helpers.
 * No VS Code imports (unit-tested in plain Node).
 */

export const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The token a change writes for the environment's schema. */
export const SCHEMA_PLACEHOLDER = '${schema}';

/** `${schema}.zaps` -> `schema.zaps`: a plain identifier, so SQL analyzers (lint, danger scan, conflicts) parse it. */
export function neutralizePlaceholders(sql: string): string {
  return sql.replace(PLACEHOLDER_RE, (_m, name: string) => name);
}

/** Replace the placeholders that have a value; others stay as written. */
export function resolvePlaceholders(sql: string, values: Record<string, string | undefined>): string {
  return sql.replace(PLACEHOLDER_RE, (m, name: string) => values[name] ?? m);
}

/**
 * `zp_st.zaps` / `"zp_st".zaps` -> `${schema}.zaps`: SQL taken from a live database (Schema Diff, snapshots)
 * written back with the placeholder, so the same file runs on every environment.
 */
export function schemaToPlaceholder(sql: string, schema: string): string {
  if (!schema) return sql;
  const esc = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sql
    .replace(new RegExp(`"${esc}"\\.`, 'g'), `${SCHEMA_PLACEHOLDER}.`)
    .replace(new RegExp(`(?<![\\w$"])${esc}\\.`, 'g'), `${SCHEMA_PLACEHOLDER}.`);
}

/**
 * `zp_st.zaps` / `"zp_st".zaps` / `${schema}.zaps` -> `zaps`: changes are written without a schema (DMCR runs
 * each environment with its schema as search_path), so SQL taken from a live database loses the prefix.
 */
export function stripSchema(sql: string, schema?: string): string {
  let out = sql.replace(/\$\{schema\}\./g, '');
  if (!schema) return out;
  const esc = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  out = out
    .replace(new RegExp(`"${esc}"\\.`, 'g'), '')
    .replace(new RegExp(`(?<![\\w$".])${esc}\\.`, 'g'), '');
  return pinSearchPathFromCurrent(out, schema);
}

/**
 * A function read from a live database stores the schema it was created in: `SET search_path TO 'zp_st', 'public'`
 * (from SET search_path FROM CURRENT). Written back as is, it binds the function to that one environment's schema
 * (test's on prod). Naming the environment's own schema, it goes back to `SET search_path FROM CURRENT`, which
 * takes the schema of whichever environment the change runs on.
 */
export function pinSearchPathFromCurrent(sql: string, schema: string): string {
  const esc = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new RegExp(`(^|[\\s,'"])${esc}(?=$|[\\s,'"])`);
  return sql.replace(/\bSET\s+search_path\s*(?:TO|=)\s*([^\n;]*)/gi, (m, list: string) => (names.test(list) ? 'SET search_path FROM CURRENT' : m));
}

/** Schemas and app roles that differ between environments: a change naming one breaks on the others. */
export type EnvNames = { schemas: string[]; roles: string[] };

const APP_ROLE_PLACEHOLDER = '${app_role}';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Comments gone and strings blanked, $$-bodies kept: as Strip-SqlComments / strip_sql_comments in the runners. */
const plainSql = (sql: string) => sql.replace(/(\/\*[\s\S]*?\*\/)|(--[^\r\n]*)|('(?:[^']|'')*')|(\$([A-Za-z_][A-Za-z_0-9]*|)\$[\s\S]*?\$\5\$)/g,
  (_m, _c, _l, str, body) => (body !== undefined ? body : str !== undefined ? "''" : ' '));
const qualifiedRe = (n: string) => new RegExp(`(?<![\\w$."])"?${n}"?\\s*\\.(?=\\s*["\\w$])`, 'i');
/** The name on its own: a table or alias called zp, so zp.id is not a schema. */
const standaloneRe = (n: string) => new RegExp(`(?<![\\w$."])"?${n}"?(?![\\w$"]|\\s*\\.)`, 'i');
const schemaStringRe = (n: string) => new RegExp(`to_reg\\w+\\s*\\(\\s*'${n}\\.|'${n}\\.[^']*'\\s*::\\s*reg|(?:table_schema|routine_schema|sequence_schema|schemaname|nspname)\\s*=\\s*'${n}'`, 'i');
const roleNameRe = (n: string, flags = 'i') => new RegExp(`(?<![\\w$])"?${n}"?(?![\\w$])`, flags);
const roleStringRe = (n: string, flags = 'i') => new RegExp(`((?:has_\\w+_privilege|pg_has_role)\\s*\\(\\s*|(?:grantee|rolname|usename)\\s*=\\s*)'${n}'`, flags);
const ROLE_TAIL_RE = /(\b(?:GRANT|REVOKE)\b[^;]*\b(?:TO|FROM)\b)([^;]*)|(\bOWNER\s+TO\b)([^;]*)/gi;

/** What this SQL names of one environment. Same rules as the runners' deploy check (Get-EnvNameProblems, env_name_problems). */
export function envNameProblems(sql: string, names: EnvNames): string[] {
  const plain = plainSql(sql);
  const out: string[] = [];
  for (const s of names.schemas) {
    const n = esc(s);
    if ((qualifiedRe(n).test(plain) && !standaloneRe(n).test(plain)) || schemaStringRe(n).test(sql)) out.push(`names schema ${s}: write the name without a schema`);
  }
  for (const r of names.roles) {
    const n = esc(r);
    const tails = [...plain.matchAll(ROLE_TAIL_RE)].map(m => (m[2] ?? '') + (m[4] ?? ''));
    if (roleStringRe(n).test(sql) || tails.some(t => roleNameRe(n).test(t))) out.push(`names role ${r}: write ${APP_ROLE_PLACEHOLDER}`);
  }
  return out;
}

/** The same SQL without an environment's schema or role: what DMCR makes of the AI's output, so one set of files runs everywhere. */
export function makePortable(sql: string, names: EnvNames): string {
  let out = sql;
  for (const s of names.schemas) {
    const n = esc(s);
    if (!standaloneRe(n).test(plainSql(out))) out = stripSchema(out, s);
    out = out.replace(new RegExp(`\\b(table_schema|routine_schema|sequence_schema|schemaname|nspname)\\s*=\\s*'${n}'`, 'gi'), '$1 = current_schema()');
  }
  for (const r of names.roles) {
    const n = esc(r);
    out = out.replace(ROLE_TAIL_RE, (_m, a, b, c, d) => (a !== undefined ? a + b.replace(roleNameRe(n, 'gi'), () => APP_ROLE_PLACEHOLDER) : c + d.replace(roleNameRe(n, 'gi'), () => APP_ROLE_PLACEHOLDER)));
    out = out.replace(roleStringRe(n, 'gi'), (_m, pre) => `${pre}'${APP_ROLE_PLACEHOLDER}'`);
  }
  return out;
}

/** Placeholders as identifiers for SQL analyzers that need names (`${schema}.zaps` -> `dmcr_ph__schema.zaps`), reversible. */
const PH_IDENT = 'dmcr_ph__';
export function placeholdersToIdent(sql: string): string {
  return sql.replace(PLACEHOLDER_RE, (_m, name: string) => PH_IDENT + name);
}
export function identToPlaceholders(text: string): string {
  return text.replace(/dmcr_ph__([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => '${' + name + '}');
}
/** identToPlaceholders over every string in a plain value (objects / arrays); functions and other values are kept. */
export function identToPlaceholdersDeep<T>(v: T): T {
  if (typeof v === 'string') return identToPlaceholders(v) as unknown as T;
  if (Array.isArray(v)) return v.map(identToPlaceholdersDeep) as unknown as T;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = identToPlaceholdersDeep(x);
    return out as T;
  }
  return v;
}
