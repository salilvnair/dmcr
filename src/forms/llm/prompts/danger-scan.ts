/**
 * Statement-level danger checks shared by the save step (danger_ prefix) — the runners
 * (dmcr.ps1 / dmcr.sh) implement the same rules for deploy.
 *
 * "DELETE without WHERE" means a DELETE FROM statement with no WHERE, not the word DELETE:
 * `ON DELETE CASCADE`, `GRANT DELETE ON t` and `REVOKE DELETE ON t FROM r` are not deletes.
 * "UPDATE without WHERE" means UPDATE <table> SET with no WHERE: `ON CONFLICT … DO UPDATE SET`
 * and `ON UPDATE CASCADE` are not.
 */
import { neutralizePlaceholders } from '../../../services/schema/placeholders';

export interface DangerRule { label: string; regex?: string; enabled?: boolean }

/** SQL without line (--) and block comments (string literals are left alone). */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const DELETE_STMT = /\bDELETE\s+FROM\b/i;
const UPDATE_STMT = /\bUPDATE\s+(?:ONLY\s+)?(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+SET\b/i;

/**
 * A WHERE that is always true filters nothing: `WHERE true`, `WHERE 1=1`, `WHERE 2 = 2`, `WHERE 'a'='a'`,
 * `WHERE NOT false`, `WHERE 1` (in brackets too), up to the end of the statement or RETURNING.
 */
const ALWAYS_TRUE = /\bWHERE\s+\(?\s*(?:true|not\s+false|(\d+)\s*=\s*\1|'([^']*)'\s*=\s*'\2'|1)\s*\)?\s*(?:returning\b|$)/i;

/** The rest of a DELETE / UPDATE statement limits the rows: it has a WHERE, and not one that is always true. */
export function limitsRows(rest: string): boolean {
  return /\bWHERE\b/i.test(rest) && !ALWAYS_TRUE.test(rest.trim());
}

/** Statements (split on ;) that delete or update every row. */
export function whereLessFindings(sql: string, opts: { deleteWithoutWhere: boolean; updateWithoutWhere: boolean }): string[] {
  const found = new Set<string>();
  for (const stmt of stripSqlComments(neutralizePlaceholders(sql)).split(';')) {
    const del = DELETE_STMT.exec(stmt);
    if (opts.deleteWithoutWhere && del && !limitsRows(stmt.slice(del.index))) found.add('DELETE without WHERE');
    const upd = UPDATE_STMT.exec(stmt);
    if (opts.updateWithoutWhere && upd && !limitsRows(stmt.slice(upd.index))) found.add('UPDATE without WHERE');
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
