/**
 * The schema a form should show: the saved one when it is offered, else the first offered one.
 * The server offers 'public' first; a restored draft may still hold DMCR's own 'dmcr' registry
 * schema (or one that no longer exists), which must never be preselected.
 */
export function pickSchema(saved: string | undefined | null, offered: string[]): string {
  if (!offered.length) return saved || '';
  // environments with their own schema: changes are written with ${schema}, so a form starts on it
  // (a draft saved before the schemas were set up still holds 'public')
  if (offered[0] === '${schema}') return offered[0];
  return saved && offered.includes(saved) ? saved : offered[0];
}

/** `zp_st.zaps` / `"zp_st".zaps` -> `${schema}.zaps` (same as the backend's services/schema/placeholders.ts). */
export function schemaToPlaceholder(sql: string, schema: string): string {
  if (!schema) return sql;
  const esc = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sql
    .replace(new RegExp(`"${esc}"\\.`, 'g'), '${schema}.')
    .replace(new RegExp(`(?<![\\w$"])${esc}\\.`, 'g'), '${schema}.');
}

/**
 * `zp_st.zaps` / `"zp_st".zaps` / `${schema}.zaps` -> `zaps` (same as the backend's stripSchema): changes are
 * written without a schema, each environment's schema (DMCR Config) is the session search_path.
 */
export function stripSchema(sql: string, schema?: string): string {
  let out = sql.replace(/\$\{schema\}\./g, '');
  if (!schema) return out;
  const esc = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  out = out
    .replace(new RegExp(`"${esc}"\\.`, 'g'), '')
    .replace(new RegExp(`(?<![\\w$".])${esc}\\.`, 'g'), '');
  return out;
}
