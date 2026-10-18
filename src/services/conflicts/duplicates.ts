/**
 * Objects a change adds that another saved change already adds: the same column, table, type or
 * sequence created twice. Whichever deploys second fails (already exists), or, written to skip when it
 * exists, rolling back either one takes the object away from the other. Shown on the change card
 * before the change is saved, so the second team keeps one owner instead.
 *
 * Read from the whole deploy.sql text, DO blocks included (a guarded ADD COLUMN is still an add).
 * Names are compared without a schema. An object the same file drops first is a rebuild, not an add.
 */

export interface Duplicate {
  /** the saved change that already adds it */
  changeId: string;
  project: string;
  /** column zp_lookup_data.product, table orders, type order_card, sequence order_no_seq */
  object: string;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;
const bare = (q: string) => q.replace(/\$\{[^}]+\}\s*\./g, '').replace(/"/g, '').split('.').pop()!.trim().toLowerCase();
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ');

/** What deploy.sql adds, as 'column t.c' / 'table t' / 'type t' / 'sequence s'. */
export function additions(sql: string): Set<string> {
  const s = stripComments(sql ?? '').replace(/\$\{[^}]+\}\s*\./g, '');
  const out = new Set<string>();
  const dropped = new Set<string>();
  const drop = new RegExp(String.raw`\bDROP\s+(TABLE|TYPE|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, 'gi');
  for (const m of s.matchAll(drop)) dropped.add(`${m[1].toLowerCase()} ${bare(m[2])}`);
  const create = new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?(TABLE|TYPE|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})`, 'gi');
  for (const m of s.matchAll(create)) {
    const k = `${m[1].toLowerCase()} ${bare(m[2])}`;
    if (!dropped.has(k)) out.add(k);
  }
  // every ADD COLUMN of an ALTER TABLE, also in a list of clauses (ADD a ..., ADD b ...)
  const alter = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})\s+([^;]*)`, 'gi');
  for (const m of s.matchAll(alter)) {
    const table = bare(m[1]);
    const add = new RegExp(String.raw`(?:^|,)\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|EXCLUDE\b)(${IDENT})`, 'gi');
    for (const a of m[2].matchAll(add)) out.add(`column ${table}.${a[1].replace(/"/g, '').toLowerCase()}`);
  }
  return out;
}

/** Saved changes that already add what `draftSql` adds. */
export function findDuplicates(draftSql: string, saved: { id: string; project: string; deploySql: string }[]): Duplicate[] {
  const mine = additions(draftSql);
  if (!mine.size) return [];
  const out: Duplicate[] = [];
  for (const c of saved) {
    for (const what of additions(c.deploySql)) {
      if (mine.has(what)) out.push({ changeId: c.id, project: c.project, object: what });
    }
  }
  return out;
}
