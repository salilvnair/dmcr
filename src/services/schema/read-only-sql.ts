// A query the AI wrote is only run when it can only read.

/** Words that write, run code or change the session: refused anywhere in an AI-written query (strings and quoted names are ignored). */
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|PREPARE|VACUUM|ANALYZE|ANALYSE|CLUSTER|REINDEX|REFRESH|LOCK|LISTEN|NOTIFY|SET|RESET|DISCARD|COMMENT|INTO|NEXTVAL|SETVAL|SET_CONFIG|DBLINK\w*|LO_\w+|PG_(?:TERMINATE|CANCEL|RELOAD|ROTATE|SLEEP|ADVISORY|READ_FILE|READ_BINARY_FILE|WRITE|LS_DIR|STAT_FILE|PROMOTE|SWITCH_WAL|CREATE)\w*|FOR\s+(?:UPDATE|SHARE|NO\s+KEY|KEY))\b/i;

/** True for one SELECT / WITH / EXPLAIN statement that only reads: no second statement, no writing CTE, no EXPLAIN ANALYZE, no writing function. */
export function isSingleReadOnlyStatement(sql: unknown): boolean {
  if (typeof sql !== 'string') { return false; }
  const s = sql
    .replace(/'(?:[^']|'')*'/g, "''")                    // string literals
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''")  // dollar-quoted strings
    .replace(/"(?:[^"]|"")*"/g, 'x')                    // quoted names
    .replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim().replace(/;\s*$/, '');
  return /^(SELECT|WITH|EXPLAIN)\b/i.test(s) && !s.includes(';') && !s.includes('$') && !WRITE_WORDS.test(s);
}
