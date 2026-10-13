/**
 * The tables a deploy.sql changes, for checks that look them up in the database (Perf, Blast Radius,
 * Canary): ALTER TABLE [IF EXISTS] [ONLY] t, DROP TABLE [IF EXISTS] t, and
 * CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] t. Names come back as written
 * (schema.table or table, quotes removed), in order, without repeats. Fill in ${schema} first.
 */
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const PATTERNS = [
  new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?` + QNAME, 'gi'),
  new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?` + QNAME, 'gi'),
  new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s+)?ON\s+(?:ONLY\s+)?` + QNAME, 'gi'),
];

export function tablesInSql(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const found: { at: number; name: string }[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) found.push({ at: m.index, name: m[1].replace(/\s+/g, '').replace(/"/g, '') });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map(f => f.name))];
}

/** The bare table name (no schema), as pg_class.relname stores it. */
export const relName = (qualified: string) => qualified.split('.').pop() ?? qualified;
