/**
 * Schema Diff → Generate Migration: what a drifted table actually needs in the target.
 *
 * get_ddl returns a table as `CREATE TABLE …;` followed by its index statements. Pasting the
 * source's whole DDL into a migration fails on the target ("relation already exists"); the
 * migration needs only the statements the target lacks, written so they can run where the
 * object already exists (the source, e.g. prod after a hand-made hotfix).
 */

/** Statements of a DDL script (split on ';' at line ends), without the trailing ';'. */
export function splitDdlStatements(ddl: string): string[] {
  return ddl
    .split(/;\s*(?:\r?\n|$)/)
    .map(s => s.trim())
    .filter(s => s.replace(/--[^\n]*/g, '').trim().length > 0);   // drop comment-only pieces
}

const norm = (s: string) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** Make a statement safe to run where its object may already exist. */
export function makeRerunnable(stmt: string): string {
  return stmt
    .replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)(CONCURRENTLY\s+)?/i, (_m, u = '', c = '') => `CREATE ${u}INDEX ${c}IF NOT EXISTS `)
    .replace(/^CREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS\b)/i, 'CREATE SEQUENCE IF NOT EXISTS ');
}

/** SQL lines for one drifted table: missing statements, plus notes for what needs a person. */
export function tableDriftMigration(leftDdl: string, rightDdl: string): string[] {
  const left = splitDdlStatements(leftDdl);
  const right = splitDdlStatements(rightDdl);
  const rightSet = new Set(right.map(norm));
  const leftSet = new Set(left.map(norm));
  const out: string[] = [];
  for (const s of left) {
    if (rightSet.has(norm(s))) continue;
    if (/^CREATE\s+TABLE\b/i.test(s)) {
      out.push('-- The CREATE TABLE definitions differ (columns or constraints). Write the ALTER TABLE', '-- statements for the difference yourself. Source definition, for reference:');
      out.push(...s.split('\n').map(l => `--   ${l}`));
      continue;
    }
    out.push(makeRerunnable(s) + ';');
  }
  for (const s of right) {
    if (leftSet.has(norm(s)) || /^CREATE\s+TABLE\b/i.test(s)) continue;
    out.push(`-- Only in the target (not dropped automatically): ${s.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return out.length ? out : ['-- No statement-level difference found; compare the DDL side by side.'];
}
