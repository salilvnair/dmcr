/**
 * The schema a form should show: the saved one when it is offered, else the first offered one.
 * The server offers 'public' first; a restored draft may still hold DMCR's own 'dmcr' registry
 * schema (or one that no longer exists), which must never be preselected.
 */
export function pickSchema(saved: string | undefined | null, offered: string[]): string {
  if (!offered.length) return saved || '';
  return saved && offered.includes(saved) ? saved : offered[0];
}

/** `zp_st.zaps` / `"zp_st".zaps` -> `${schema}.zaps` (same as the backend's services/schema/placeholders.ts). */
export function schemaToPlaceholder(sql: string, schema: string): string {
  if (!schema) return sql;
  const esc = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sql
    .replace(new RegExp(`"${esc}"\\.`, 'g'), '${schema}.')
    .replace(new RegExp(`(?<![\\w$"])${esc}\\.(?=["A-Za-z_])`, 'g'), '${schema}.');
}
