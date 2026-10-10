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
    .replace(/^CREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS\b)/i, 'CREATE SEQUENCE IF NOT EXISTS ')
    .replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i, 'CREATE TABLE IF NOT EXISTS ');
}

/** SQL lines that create an object missing in the target, from the source DDL, re-runnable. */
export function missingObjectMigration(leftDdl: string): string[] {
  const stmts = splitDdlStatements(leftDdl);
  return stmts.length ? stmts.map(s => makeRerunnable(s) + ';') : ['-- No source DDL available; create it by hand.'];
}

/**
 * A drifted sequence already exists in the target, so CREATE SEQUENCE would fail with "already
 * exists": the same options as ALTER SEQUENCE (INCREMENT, MIN/MAX, START, CACHE, CYCLE all exist there).
 */
export function sequenceDriftMigration(leftDdl: string): string[] {
  return splitDdlStatements(leftDdl).map(s => s.replace(/^CREATE\s+SEQUENCE\s+(IF\s+NOT\s+EXISTS\s+)?/i, 'ALTER SEQUENCE ') + ';');
}

/** SQL lines for one drifted table: missing statements, plus notes for what needs a person. */
export function tableDriftMigration(leftDdl: string, rightDdl: string): string[] {
  const left = splitDdlStatements(leftDdl);
  const right = splitDdlStatements(rightDdl);
  const rightSet = new Set(right.map(norm));
  const leftSet = new Set(left.map(norm));
  const out: string[] = [];
  const rightTable = right.find(s => /^CREATE\s+TABLE\b/i.test(s));
  for (const s of left) {
    if (rightSet.has(norm(s))) continue;
    if (/^CREATE\s+TABLE\b/i.test(s)) {
      // columns and constraints: the ALTER TABLE statements that bring the target to the source
      const alters = rightTable ? tableAlterStatements(s, rightTable) : null;
      if (alters) { out.push(...alters); continue; }
      out.push('-- The CREATE TABLE definitions differ and could not be compared column by column. Write the', '-- ALTER TABLE statements yourself. Source definition, for reference:');
      out.push(...s.split('\n').map(l => `--   ${l}`));
      continue;
    }
    out.push(makeRerunnable(s) + ';');
  }
  for (const s of right) {
    if (leftSet.has(norm(s)) || /^CREATE\s+TABLE\b/i.test(s)) continue;
    // an index only in the target: drop it (no data is lost; it makes the change danger_, so the DBA runs it)
    const idx = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?[\w$]+"?)\s+ON\s+(?:ONLY\s+)?("?[\w$]+"?)\./i.exec(s);
    if (idx) { out.push(`-- Only in the target: ${s.replace(/\s+/g, ' ').slice(0, 160)}`, `DROP INDEX IF EXISTS ${idx[2]}.${idx[1]};`); continue; }
    out.push(`-- Only in the target (not dropped automatically): ${s.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return out.length ? out : ['-- No statement-level difference found; compare the DDL side by side.'];
}

/* ── CREATE TABLE, column by column ─────────────────────────────────────────── */

type Column = { name: string; type: string; notNull: boolean; def: string | null; raw: string };
type ParsedTable = { name: string; columns: Map<string, Column>; constraints: Map<string, string>; unnamed: string[] };

/** Split on commas at depth 0 (outside parentheses and quotes). */
function splitTop(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote: string | null = null, cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map(p => p.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const COLUMN_STOP = /\s(?:NOT\s+NULL|NULL|DEFAULT|CONSTRAINT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|GENERATED|COLLATE)\b/i;

function parseColumn(item: string): Column {
  const m = /^("(?:[^"]|"")+"|[\w$]+)\s+([\s\S]*)$/.exec(item)!;
  const name = m[1], rest = m[2];
  const stop = COLUMN_STOP.exec(' ' + rest);
  const type = (stop ? rest.slice(0, stop.index) : rest).trim();
  const tail = stop ? rest.slice(stop.index) : '';
  // DEFAULT <expr> runs to the next column keyword at depth 0
  let def: string | null = null;
  const d = /\bDEFAULT\s+/i.exec(tail);
  if (d) {
    const after = tail.slice(d.index + d[0].length);
    let depth = 0, end = after.length;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === '(') depth++;
      else if (after[i] === ')') depth--;
      else if (depth === 0 && /^\s(?:NOT\s+NULL|NULL|CONSTRAINT|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|GENERATED|COLLATE)\b/i.test(after.slice(i))) { end = i; break; }
    }
    def = after.slice(0, end).trim();
  }
  return { name, type, notNull: /\bNOT\s+NULL\b/i.test(tail) || /\bPRIMARY\s+KEY\b/i.test(tail), def, raw: item };
}

export function parseCreateTable(stmt: string): ParsedTable | null {
  const head = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s*\(/i.exec(stmt.trim());
  if (!head) return null;
  // the column list: from the first '(' to its matching ')'
  const start = head[0].length;
  let depth = 1, i = start;
  for (; i < stmt.trim().length && depth > 0; i++) { const ch = stmt.trim()[i]; if (ch === '(') depth++; else if (ch === ')') depth--; }
  if (depth !== 0) return null;
  const body = stmt.trim().slice(start, i - 1);
  const columns = new Map<string, Column>(), constraints = new Map<string, string>(), unnamed: string[] = [];
  for (const item of splitTop(body)) {
    const named = /^CONSTRAINT\s+("?[\w$]+"?)\s+([\s\S]+)$/i.exec(item);
    if (named) { constraints.set(named[1].toLowerCase(), named[2]); continue; }
    if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE|LIKE)\b/i.test(item)) { unnamed.push(item); continue; }
    const c = parseColumn(item);
    columns.set(c.name.toLowerCase(), c);
  }
  return { name: head[1], columns, constraints, unnamed };
}

const same = (a: string | null, b: string | null) => (a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === (b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The ALTER TABLE statements that turn the target's table into the source's: added columns, type,
 * NOT NULL and default changes, named constraints added or replaced. What would lose data (a column
 * only in the target) is written out commented, for a person to decide. Null when either side cannot be parsed.
 */
export function tableAlterStatements(sourceCreate: string, targetCreate: string): string[] | null {
  const src = parseCreateTable(sourceCreate), tgt = parseCreateTable(targetCreate);
  if (!src || !tgt) return null;
  const t = src.name;
  const out: string[] = [];
  for (const [key, c] of src.columns) {
    const o = tgt.columns.get(key);
    if (!o) { out.push(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c.raw};`); continue; }
    if (!same(c.type, o.type)) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c.name} TYPE ${c.type} USING ${c.name}::${c.type};`);
    if (!same(c.def, o.def)) out.push(c.def ? `ALTER TABLE ${t} ALTER COLUMN ${c.name} SET DEFAULT ${c.def};` : `ALTER TABLE ${t} ALTER COLUMN ${c.name} DROP DEFAULT;`);
    if (c.notNull !== o.notNull) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c.name} ${c.notNull ? 'SET' : 'DROP'} NOT NULL;`);
  }
  for (const [key, o] of tgt.columns) {
    if (!src.columns.has(key)) out.push(`-- Only in the target: column ${o.name} (${o.type}). Dropping it deletes its data; uncomment if you mean it (a danger_ change):`, `-- ALTER TABLE ${t} DROP COLUMN ${o.name};`);
  }
  for (const [name, def] of src.constraints) {
    const o = tgt.constraints.get(name);
    if (o === undefined) out.push(`ALTER TABLE ${t} ADD CONSTRAINT ${name} ${def};`);
    else if (!same(def, o)) out.push(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${name};`, `ALTER TABLE ${t} ADD CONSTRAINT ${name} ${def};`);
  }
  for (const [name, def] of tgt.constraints) {
    if (!src.constraints.has(name)) out.push(`-- Only in the target: constraint ${name} ${def}`, `-- ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${name};`);
  }
  return out.length ? out : ['-- The table definitions differ only in formatting.'];
}
