/**
 * Lock and safety lint for a change's deploy.sql (PostgreSQL), in the spirit of Squawk / Atlas lint:
 * statements that take a long lock or rewrite a table on a live database, each with the safer way to
 * write it. Advisory, never blocking: a small table, or a maintenance window, makes most of them fine.
 *
 * Tables created earlier in the same deploy.sql are exempt: nobody is using them yet.
 */
import { placeholdersToIdent, identToPlaceholdersDeep } from '../schema/placeholders';

export type LintSeverity = 'warning' | 'notice';
export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  /** the statement, shortened */
  statement: string;
  /** 1-based line in deploy.sql where the statement starts */
  line: number;
  why: string;
  fix: string;
}

/** Statements with their starting line, comments stripped (dollar-quoted bodies kept whole). */
function statements(sql: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let cur = '', startLine = 1, line = 1, i = 0, dollar: string | null = null, quote = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (!dollar && !quote && ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (!dollar && !quote && ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); const chunk = sql.slice(i, e < 0 ? sql.length : e + 2); line += (chunk.match(/\n/g) ?? []).length; i = e < 0 ? sql.length : e + 2; continue; }
    if (!quote && ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { if (dollar === m[0]) dollar = null; else if (!dollar) dollar = m[0]; cur += m[0]; i += m[0].length; continue; }
    }
    if (!dollar && ch === "'") quote = !quote;
    if (!dollar && !quote && ch === ';') { if (cur.trim()) out.push({ text: cur.trim(), line: startLine }); cur = ''; i++; continue; }
    if (!cur.trim() && ch.trim()) startLine = line;
    if (ch === '\n') line++;
    cur += ch; i++;
  }
  if (cur.trim()) out.push({ text: cur.trim(), line: startLine });
  return out;
}

const VOLATILE = /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|random|gen_random_uuid|uuid_generate_v[1-4]|timeofday|nextval)\s*\(|\bcurrent_timestamp\b|\blocaltimestamp\b/i;
const ident = '((?:"[^"]+"|[\\w$]+)(?:\\.(?:"[^"]+"|[\\w$]+))?)';
const bare = (name: string) => name.replace(/"/g, '').split('.').pop()!.toLowerCase();

/** ${schema}.zaps is linted as a name and reported as written. */
export function lintDeploySql(sql: string): LintFinding[] {
  return identToPlaceholdersDeep(lintPlainSql(placeholdersToIdent(sql)));
}

function lintPlainSql(sql: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const created = new Set<string>();
  const validated = new Set<string>();   // tables with a VALIDATE CONSTRAINT earlier in the file
  const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 140);
  const add = (st: { text: string; line: number }, rule: string, severity: LintSeverity, why: string, fix: string) =>
    findings.push({ rule, severity, statement: short(st.text), line: st.line, why, fix });

  for (const st of statements(sql)) {
    const s = st.text;
    const createTable = new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ident}`, 'i').exec(s);
    if (createTable) { created.add(bare(createTable[1])); continue; }

    const idx = new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:[\\w$"]+\\s+)?ON\\s+(?:ONLY\\s+)?${ident}`, 'i').exec(s);
    if (idx) {
      if (!idx[2] && !created.has(bare(idx[3])))
        add(st, 'index-without-concurrently', 'warning', 'CREATE INDEX blocks every write to the table (SHARE lock) until the index is built.', 'Use CREATE INDEX CONCURRENTLY IF NOT EXISTS, with "transaction": false in meta.json (DMCR then runs it outside a transaction).');
      continue;
    }

    const alter = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${ident}\\s+([\\s\\S]*)$`, 'i').exec(s);
    if (alter) {
      if (created.has(bare(alter[1]))) continue;
      const body = alter[2];
      const typeTo = /\bALTER\s+(?:COLUMN\s+)?[\w$"]+\s+(?:SET\s+DATA\s+)?TYPE\s+([a-z ]+?)\s*(?:\(|\bUSING\b|,|$)/i.exec(body);
      if (typeTo) {
        // to text / varchar: no rewrite when the column is already varchar; the SQL alone does not say
        if (/^(text|varchar|character varying)$/i.test(typeTo[1].trim()))
          add(st, 'alter-column-type', 'notice', 'Changing a column to text / varchar is instant when it is already varchar (no rewrite); from another type it rewrites the table under an ACCESS EXCLUSIVE lock.', 'Check the current type: varchar to text is fine; otherwise use expand / contract (new column, backfill, switch, drop).');
        else
          add(st, 'alter-column-type', 'warning', 'Changing a column type rewrites the table and its indexes under an ACCESS EXCLUSIVE lock.', 'Add a new column, backfill it in batches, switch the application, then drop the old one (expand / contract).');
      }
      if (/\bVALIDATE\s+CONSTRAINT\b/i.test(body)) validated.add(bare(alter[1]));
      if (/\bALTER\s+(?:COLUMN\s+)?[\w$"]+\s+SET\s+NOT\s+NULL\b/i.test(body) && validated.has(bare(alter[1])))
        add(st, 'set-not-null', 'notice', 'SET NOT NULL is instant when a validated CHECK (col IS NOT NULL) exists (validated above); otherwise it scans the table under an ACCESS EXCLUSIVE lock.', 'Keep the validated CHECK (col IS NOT NULL) until after SET NOT NULL, as here.');
      else if (/\bALTER\s+(?:COLUMN\s+)?[\w$"]+\s+SET\s+NOT\s+NULL\b/i.test(body))
        add(st, 'set-not-null', 'warning', 'SET NOT NULL scans the whole table under an ACCESS EXCLUSIVE lock.', 'ADD CONSTRAINT x CHECK (col IS NOT NULL) NOT VALID; then VALIDATE CONSTRAINT x (no exclusive lock); then SET NOT NULL is instant (PostgreSQL 12+).');
      if (/\bADD\s+(?:CONSTRAINT\s+[\w$"]+\s+)?(?:FOREIGN\s+KEY|CHECK)\b/i.test(body) && !/\bNOT\s+VALID\b/i.test(body))
        add(st, 'constraint-without-not-valid', 'warning', 'Adding a FOREIGN KEY or CHECK validates every row while holding a lock that blocks writes.', 'Add it NOT VALID, then ALTER TABLE ... VALIDATE CONSTRAINT x in a later statement (validation takes a weaker lock).');
      if (/\bADD\s+(?:CONSTRAINT\s+[\w$"]+\s+)?(?:PRIMARY\s+KEY|UNIQUE)\b/i.test(body) && !/\bUSING\s+INDEX\b/i.test(body))
        add(st, 'unique-without-index', 'warning', 'Adding a PRIMARY KEY or UNIQUE constraint builds its index under an ACCESS EXCLUSIVE lock.', 'CREATE UNIQUE INDEX CONCURRENTLY first, then ADD CONSTRAINT x UNIQUE USING INDEX that_index.');
      const addCol = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[\w$"]+\s+[\s\S]*?\bDEFAULT\s+([\s\S]+)/i.exec(body);
      if (addCol && VOLATILE.test(addCol[1]))
        add(st, 'volatile-default', 'warning', 'A new column with a volatile default (now(), random(), gen_random_uuid(), nextval ...) rewrites the whole table under an ACCESS EXCLUSIVE lock.', 'Add the column without the default (or with a constant), backfill in batches, then SET DEFAULT.');
      if (/\bRENAME\s+(?:COLUMN\s+)?[\w$"]+\s+TO\b/i.test(body) || /^\s*RENAME\s+TO\b/i.test(body))
        add(st, 'rename', 'notice', 'A rename is instant, but every running query and deployed application that uses the old name breaks at once.', 'Expand / contract: add the new name (column or view), move the application, then drop the old one.');
      continue;
    }

    if (/^VACUUM\s+(?:\(\s*)?FULL\b/i.test(s) || /^CLUSTER\b/i.test(s))
      add(st, 'table-rewrite', 'warning', 'VACUUM FULL and CLUSTER rewrite the table under an ACCESS EXCLUSIVE lock.', 'Use pg_repack, or run it in a maintenance window.');
    else if (/^REINDEX\b/i.test(s) && !/\bCONCURRENTLY\b/i.test(s))
      add(st, 'reindex-without-concurrently', 'warning', 'REINDEX locks out writes (and reads that use the index) until it finishes.', 'REINDEX ... CONCURRENTLY (PostgreSQL 12+), with "transaction": false in meta.json.');
  }
  return findings;
}
