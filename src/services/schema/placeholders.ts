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
