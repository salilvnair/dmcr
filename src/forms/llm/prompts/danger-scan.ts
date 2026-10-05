/**
 * Statement-level danger checks shared by the save step (danger_ prefix) — the runners
 * (dmcr.ps1 / dmcr.sh) implement the same rules for deploy.
 *
 * "DELETE without WHERE" means a DELETE FROM statement with no WHERE, not the word DELETE:
 * `ON DELETE CASCADE`, `GRANT DELETE ON t` and `REVOKE DELETE ON t FROM r` are not deletes.
 * "UPDATE without WHERE" means UPDATE <table> SET with no WHERE: `ON CONFLICT … DO UPDATE SET`
 * and `ON UPDATE CASCADE` are not.
 */

export interface DangerRule { label: string; regex?: string; enabled?: boolean }

/** SQL without line (--) and block comments (string literals are left alone). */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const DELETE_STMT = /\bDELETE\s+FROM\b/i;
const UPDATE_STMT = /\bUPDATE\s+(?:ONLY\s+)?(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+SET\b/i;

/** Statements (split on ;) that delete or update every row. */
export function whereLessFindings(sql: string, opts: { deleteWithoutWhere: boolean; updateWithoutWhere: boolean }): string[] {
  const found = new Set<string>();
  for (const stmt of stripSqlComments(sql).split(';')) {
    const del = DELETE_STMT.exec(stmt);
    if (opts.deleteWithoutWhere && del && !/\bWHERE\b/i.test(stmt.slice(del.index))) found.add('DELETE without WHERE');
    const upd = UPDATE_STMT.exec(stmt);
    if (opts.updateWithoutWhere && upd && !/\bWHERE\b/i.test(stmt.slice(upd.index))) found.add('UPDATE without WHERE');
  }
  return [...found];
}

/** A rule's regex (PCRE-style "(?i)…" from dmcr_danger.json) as a JS RegExp; the label otherwise. */
export function ruleMatches(rule: DangerRule, strippedSql: string): boolean {
  if (rule.regex) {
    const src = rule.regex.replace(/^\(\?i\)/, '');
    try { return new RegExp(src, 'i').test(strippedSql); } catch { /* fall back to the label */ }
  }
  return strippedSql.toUpperCase().includes(rule.label.toUpperCase());
}
