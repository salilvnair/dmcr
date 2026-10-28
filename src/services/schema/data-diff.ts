/**
 * Data Diff: the rows of one table on two databases (test vs prod), matched by primary key.
 *
 * Both sides are read through their database servers' read-only query (1000 rows per call), so the
 * compare goes in two passes: first every row's key and an md5 of its values (cheap, paged by key),
 * then the full rows only for the keys that differ. A table with no primary key (or NOT NULL unique
 * key) is compared as a bag of rows: only added and removed, by row hash.
 */

export type QueryResult = { columns: string[]; rows: (string | null)[][] };
export type Query = (sql: string) => Promise<QueryResult>;

export type DataRow = Record<string, string | null>;
export type ChangedRow = { key: DataRow; source: DataRow; target: DataRow; columns: string[] };

export type DataDiffResult = {
  table: string;
  sourceSchema: string;
  targetSchema: string;
  /** the columns the rows are matched by; empty: no key, the rows are compared whole */
  keyColumns: string[];
  keyKind: 'primary' | 'unique' | 'chosen' | 'none';
  /** the table's own key (what Match by offers first) */
  tableKey: string[];
  /** the columns compared (on both sides, less the ignored ones), source order */
  columns: string[];
  onlyInSourceColumns: string[];
  onlyInTargetColumns: string[];
  ignored: string[];
  sourceRows: number;
  targetRows: number;
  same: number;
  /** counts of every difference; the lists below hold at most DETAIL_CAP of each */
  counts: { added: number; removed: number; changed: number };
  added: DataRow[];      // in the source, not in the target
  removed: DataRow[];    // in the target, not in the source
  changed: ChangedRow[];
  /** true when every differing row is in the lists (so a sync change can be written) */
  complete: boolean;
  /** stopped reading at MAX_ROWS on a side */
  truncated: boolean;
  ms: number;
};

export const PAGE = 1000;
export const MAX_ROWS = 200_000;
export const DETAIL_CAP = 1000;
const IN_BATCH = 200;

export const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const lit = (v: string | null) => (v == null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const rel = (schema: string, table: string) => (schema ? `${qi(schema)}.${qi(table)}` : qi(table));

/** The table's columns in order ('' schema: the search path) */
async function columnsOf(q: Query, schema: string, table: string): Promise<string[]> {
  const r = await q(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid = to_regclass(${lit(rel(schema, table))}) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
  return r.rows.map(x => String(x[0]));
}

/** The primary key, else the first unique index whose columns are all NOT NULL */
async function keyOf(q: Query, schema: string, table: string): Promise<{ cols: string[]; kind: DataDiffResult['keyKind'] }> {
  const r = await q(`SELECT i.indisprimary, array_to_string(array_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)), ',') AS cols, bool_and(a.attnotnull) AS notnull
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey::int2[])
    WHERE i.indrelid = to_regclass(${lit(rel(schema, table))}) AND (i.indisprimary OR (i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL))
    GROUP BY i.indexrelid, i.indisprimary ORDER BY i.indisprimary DESC, i.indexrelid`);
  for (const [prim, cols, notnull] of r.rows) {
    if (prim === 'True' || prim === 't' || prim === 'true') return { cols: String(cols).split(','), kind: 'primary' };
    if (notnull === 'True' || notnull === 't' || notnull === 'true') return { cols: String(cols).split(','), kind: 'unique' };
  }
  return { cols: [], kind: 'none' };
}

const rowHash = (cols: string[]) => `md5(ROW(${cols.map(qi).join(', ')})::text)`;
const keyTuple = (cols: string[]) => `(${cols.map(qi).join(', ')})`;
const keyOfRow = (vals: (string | null)[]) => JSON.stringify(vals);

/** key → row hash for every row, paged by key (keyset paging: no OFFSET) */
async function scanKeyed(q: Query, from: string, keys: string[], cols: string[], onPage: (n: number) => void, side: string): Promise<{ map: Map<string, string>; truncated: boolean }> {
  const map = new Map<string, string>();
  let after: (string | null)[] | null = null;
  for (;;) {
    const where = after ? `WHERE ${keyTuple(keys)} > (${after.map(lit).join(', ')})` : '';
    // the text copies get their own names: ORDER BY "id" would otherwise sort the text ("1899" after "1000")
    const r = await q(`SELECT ${keys.map((k, i) => `${qi(k)}::text AS _k${i}`).join(', ')}, ${rowHash(cols)} AS _h FROM ${from} ${where} ORDER BY ${keys.map(qi).join(', ')} LIMIT ${PAGE}`);
    for (const row of r.rows) {
      const k = keyOfRow(row.slice(0, keys.length));
      // a chosen column that repeats cannot match rows one to one
      if (map.has(k)) throw new Error(`${keys.join(', ')} is not unique on ${side} (${row.slice(0, keys.length).map(v => v ?? 'NULL').join(', ')} repeats): match by another column`);
      map.set(k, String(row[keys.length]));
    }
    onPage(map.size);
    if (r.rows.length < PAGE) return { map, truncated: false };
    if (map.size >= MAX_ROWS) return { map, truncated: true };
    after = r.rows[r.rows.length - 1].slice(0, keys.length);
  }
}

/** row hash → how many rows have it (tables with no key) */
async function scanBag(q: Query, from: string, cols: string[], onPage: (n: number) => void): Promise<{ map: Map<string, number>; truncated: boolean }> {
  const map = new Map<string, number>();
  let after: string | null = null, seen = 0;
  for (;;) {
    const h = rowHash(cols);
    const r = await q(`SELECT h, count(*) FROM (SELECT ${h} AS h FROM ${from}) t ${after ? `WHERE h > ${lit(after)}` : ''} GROUP BY h ORDER BY h LIMIT ${PAGE}`);
    for (const [hash, n] of r.rows) { map.set(String(hash), Number(n)); seen += Number(n); }
    onPage(seen);
    if (r.rows.length < PAGE) return { map, truncated: false };
    if (seen >= MAX_ROWS) return { map, truncated: true };
    after = String(r.rows[r.rows.length - 1][0]);
  }
}

const toRow = (columns: string[], vals: (string | null)[]): DataRow => Object.fromEntries(columns.map((c, i) => [c, vals[i] ?? null]));

/** The full rows (as Postgres text) for these keys */
async function rowsByKey(q: Query, from: string, keys: string[], cols: string[], keyJsons: string[]): Promise<Map<string, DataRow>> {
  const out = new Map<string, DataRow>();
  for (let i = 0; i < keyJsons.length; i += IN_BATCH) {
    const batch = keyJsons.slice(i, i + IN_BATCH).map(k => JSON.parse(k) as (string | null)[]);
    const inList = batch.map(vals => `(${vals.map(lit).join(', ')})`).join(', ');
    const sel = [...keys, ...cols.filter(c => !keys.includes(c))];
    const r = await q(`SELECT ${sel.map(c => `${qi(c)}::text`).join(', ')} FROM ${from} WHERE ${keyTuple(keys)} IN (${inList})`);
    for (const row of r.rows) out.set(keyOfRow(row.slice(0, keys.length)), toRow(sel, row));
  }
  return out;
}

/** Some rows (as text) with these hashes, `n` of each */
async function rowsByHash(q: Query, from: string, cols: string[], want: Map<string, number>): Promise<DataRow[]> {
  const out: DataRow[] = [];
  const hashes = [...want.keys()];
  for (let i = 0; i < hashes.length; i += IN_BATCH) {
    const batch = hashes.slice(i, i + IN_BATCH);
    const r = await q(`SELECT ${rowHash(cols)}, ${cols.map(c => `${qi(c)}::text`).join(', ')} FROM ${from} WHERE ${rowHash(cols)} IN (${batch.map(lit).join(', ')})`);
    const taken = new Map<string, number>();
    for (const row of r.rows) {
      const h = String(row[0]);
      const n = taken.get(h) ?? 0;
      if (n >= (want.get(h) ?? 0)) continue;
      taken.set(h, n + 1);
      out.push(toRow(cols, row.slice(1)));
    }
  }
  return out;
}

export async function diffTableData(opts: {
  source: Query; target: Query;
  sourceSchema: string; targetSchema: string; table: string;
  ignore?: string[];
  /** match rows by these columns instead of the table's key */
  key?: string[];
  progress?: (text: string) => void;
}): Promise<DataDiffResult> {
  const t0 = Date.now();
  const { source, target, sourceSchema, targetSchema, table } = opts;
  const say = opts.progress ?? (() => {});
  const ignore = new Set(opts.ignore ?? []);
  const srcFrom = rel(sourceSchema, table), tgtFrom = rel(targetSchema, table);

  say(`Reading ${table}'s columns and key`);
  const [srcCols, tgtCols, key] = await Promise.all([columnsOf(source, sourceSchema, table), columnsOf(target, targetSchema, table), keyOf(source, sourceSchema, table)]);
  if (!srcCols.length) throw new Error(`${sourceSchema ? sourceSchema + '.' : ''}${table} does not exist on the source`);
  if (!tgtCols.length) throw new Error(`${targetSchema ? targetSchema + '.' : ''}${table} does not exist on the target`);
  const both = srcCols.filter(c => tgtCols.includes(c));
  // the key is matched on even when it is "ignored", and must be on both sides
  const chosen = (opts.key ?? []).filter(c => both.includes(c));
  const keys = chosen.length ? chosen : key.cols.every(c => both.includes(c)) ? key.cols : [];
  const keyKind = chosen.length ? (chosen.join() === key.cols.join() ? key.kind : 'chosen') : keys.length ? key.kind : 'none';
  const columns = both.filter(c => !ignore.has(c) || keys.includes(c));
  const base = {
    table, sourceSchema, targetSchema, keyColumns: keys, keyKind, tableKey: key.cols, columns,
    onlyInSourceColumns: srcCols.filter(c => !tgtCols.includes(c)), onlyInTargetColumns: tgtCols.filter(c => !srcCols.includes(c)),
    ignored: both.filter(c => ignore.has(c) && !keys.includes(c)),
  };

  if (keys.length) {
    // a chosen column must be unique on both sides (paging by it would skip its repeats)
    if (keyKind === 'chosen') {
      for (const [q, from, side] of [[source, srcFrom, 'the source'], [target, tgtFrom, 'the target']] as const) {
        const dup = await q(`SELECT ${keys.map(k => `${qi(k)}::text`).join(', ')} FROM ${from} GROUP BY ${keys.map(qi).join(', ')} HAVING count(*) > 1 LIMIT 1`);
        if (dup.rows.length) throw new Error(`${keys.join(', ')} is not unique on ${side} (${dup.rows[0].map(v => v ?? 'NULL').join(', ')} repeats): match by another column`);
      }
    }
    const [s, t] = await Promise.all([
      scanKeyed(source, srcFrom, keys, columns, n => say(`Hashing rows: source ${n.toLocaleString()}`), 'the source'),
      scanKeyed(target, tgtFrom, keys, columns, n => say(`Hashing rows: target ${n.toLocaleString()}`), 'the target'),
    ]);
    const added: string[] = [], removed: string[] = [], changed: string[] = [];
    let same = 0;
    for (const [k, h] of s.map) { const th = t.map.get(k); if (th == null) added.push(k); else if (th !== h) changed.push(k); else same++; }
    for (const k of t.map.keys()) if (!s.map.has(k)) removed.push(k);

    say(`Reading the ${(added.length + removed.length + changed.length).toLocaleString()} rows that differ`);
    const take = (a: string[]) => a.slice(0, DETAIL_CAP);
    const [sRows, tRows] = await Promise.all([
      rowsByKey(source, srcFrom, keys, columns, [...take(added), ...take(changed)]),
      rowsByKey(target, tgtFrom, keys, columns, [...take(removed), ...take(changed)]),
    ]);
    const keyRow = (k: string) => toRow(keys, JSON.parse(k));
    return {
      ...base,
      sourceRows: s.map.size, targetRows: t.map.size, same,
      counts: { added: added.length, removed: removed.length, changed: changed.length },
      added: take(added).map(k => sRows.get(k)).filter((r): r is DataRow => !!r),
      removed: take(removed).map(k => tRows.get(k)).filter((r): r is DataRow => !!r),
      changed: take(changed).flatMap(k => {
        const a = sRows.get(k), b = tRows.get(k);
        return a && b ? [{ key: keyRow(k), source: a, target: b, columns: columns.filter(c => a[c] !== b[c]) }] : [];
      }),
      complete: !s.truncated && !t.truncated && [added, removed, changed].every(a => a.length <= DETAIL_CAP),
      truncated: s.truncated || t.truncated,
      ms: Date.now() - t0,
    };
  }

  // no key: the rows are a bag; what one side has more of is added / removed
  const [s, t] = await Promise.all([
    scanBag(source, srcFrom, columns, n => say(`Hashing rows: source ${n.toLocaleString()}`)),
    scanBag(target, tgtFrom, columns, n => say(`Hashing rows: target ${n.toLocaleString()}`)),
  ]);
  const more = (a: Map<string, number>, b: Map<string, number>) => new Map([...a].map(([h, n]) => [h, n - (b.get(h) ?? 0)] as [string, number]).filter(([, n]) => n > 0));
  const addH = more(s.map, t.map), remH = more(t.map, s.map);
  const sum = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
  const capped = (m: Map<string, number>) => { const o = new Map<string, number>(); let n = 0; for (const [h, c] of m) { if (n >= DETAIL_CAP) break; const k = Math.min(c, DETAIL_CAP - n); o.set(h, k); n += k; } return o; };
  say('Reading the rows that differ');
  const [added, removed] = await Promise.all([rowsByHash(source, srcFrom, columns, capped(addH)), rowsByHash(target, tgtFrom, columns, capped(remH))]);
  const sourceRows = sum(s.map), targetRows = sum(t.map), nAdd = sum(addH), nRem = sum(remH);
  return {
    ...base,
    sourceRows, targetRows, same: sourceRows - nAdd,
    counts: { added: nAdd, removed: nRem, changed: 0 },
    added, removed, changed: [],
    complete: !s.truncated && !t.truncated && nAdd <= DETAIL_CAP && nRem <= DETAIL_CAP,
    truncated: s.truncated || t.truncated,
    ms: Date.now() - t0,
  };
}

/**
 * The change that makes the target's rows match the source's: deploy (insert / update / delete), its exact
 * revert, and a verify that checks one row of each kind. Plain table name: each environment runs in its own schema.
 */
export function syncChangeSql(d: DataDiffResult, opts: { deletes: boolean; sourceName?: string }): { deploy: string; revert: string; verify: string } {
  const t = qi(d.table);
  const where = (key: DataRow) => d.keyColumns.length
    ? d.keyColumns.map(k => `${qi(k)} = ${lit(key[k])}`).join(' AND ')
    : d.columns.map(c => (key[c] == null ? `${qi(c)} IS NULL` : `${qi(c)} = ${lit(key[c])}`)).join(' AND ');
  const insert = (rows: DataRow[]) => rows.length
    ? [`INSERT INTO ${t} (${d.columns.map(qi).join(', ')}) VALUES`, rows.map(r => `  (${d.columns.map(c => lit(r[c])).join(', ')})`).join(',\n') + ';']
    : [];
  // a keyless row is deleted one at a time (ctid: only that one, not its twins)
  const del = (r: DataRow) => d.keyColumns.length
    ? `DELETE FROM ${t} WHERE ${where(r)};`
    : `DELETE FROM ${t} WHERE ctid = (SELECT ctid FROM ${t} WHERE ${where(r)} LIMIT 1);`;
  const update = (key: DataRow, from: DataRow, cols: string[]) => `UPDATE ${t} SET ${cols.map(c => `${qi(c)} = ${lit(from[c])}`).join(', ')} WHERE ${where(key)};`;

  const removed = opts.deletes ? d.removed : [];
  const head = `-- ${d.table}: make the rows match ${opts.sourceName || 'the source'} (${d.counts.added} insert, ${d.counts.changed} update, ${removed.length} delete)`;
  const deploy = [head,
    ...insert(d.added),
    ...d.changed.map(c => update(c.key, c.source, c.columns)),
    ...removed.map(del),
  ].join('\n') + '\n';
  const revert = [`-- ${d.table}: put the rows back as they were`,
    ...insert(removed),
    ...d.changed.map(c => update(c.key, c.target, c.columns)),
    ...d.added.map(del),
  ].join('\n') + '\n';

  // verify: one row of each kind is as the change left it (applied) or as it was (reverted)
  const exists = (r: DataRow) => `EXISTS (SELECT 1 FROM ${t} WHERE ${where(r)})`;
  const same = (key: DataRow, row: DataRow, cols: string[]) => `EXISTS (SELECT 1 FROM ${t} WHERE ${where(key)} AND ${cols.map(c => `${qi(c)}::text IS NOT DISTINCT FROM ${lit(row[c])}`).join(' AND ')})`;
  const applied: string[] = [], reverted: string[] = [];
  const a = d.added[0], r = removed[0], c = d.changed[0];
  if (a) { applied.push(`IF NOT ${exists(a)} THEN RAISE EXCEPTION 'an inserted ${d.table} row is missing'; END IF;`); if (d.keyColumns.length) reverted.push(`IF ${exists(a)} THEN RAISE EXCEPTION 'an inserted ${d.table} row is still there'; END IF;`); }
  if (r && d.keyColumns.length) { applied.push(`IF ${exists(r)} THEN RAISE EXCEPTION 'a deleted ${d.table} row is still there'; END IF;`); reverted.push(`IF NOT ${exists(r)} THEN RAISE EXCEPTION 'a deleted ${d.table} row did not come back'; END IF;`); }
  if (c) { applied.push(`IF NOT ${same(c.key, c.source, c.columns)} THEN RAISE EXCEPTION 'an updated ${d.table} row has the old values'; END IF;`); reverted.push(`IF NOT ${same(c.key, c.target, c.columns)} THEN RAISE EXCEPTION 'an updated ${d.table} row was not put back'; END IF;`); }
  const block = (cond: string, lines: string[]) => lines.length ? [`  IF ${cond} (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN`, ...lines.map(l => `    ${l}`), '  END IF;'] : [];
  const verify = ['-- verify: the rows are as the change left them (applied) or as they were (reverted)', 'DO $$', 'BEGIN',
    ...block('EXISTS', applied), ...block('NOT EXISTS', reverted), applied.length || reverted.length ? '' : '  NULL;', 'END $$;'].filter(l => l !== '').join('\n') + '\n';
  return { deploy, revert, verify };
}

/** A sequence's state on one side: where it is, and how it counts */
export type SequenceState = { last_value: string; is_called: boolean; start_value: string; increment_by: string; min_value: string; max_value: string; cycle: boolean };
export type SequenceDiffResult = {
  kind: 'sequence'; sequence: string; sourceSchema: string; targetSchema: string;
  source: SequenceState; target: SequenceState;
  /** the properties that differ (last_value included) */
  differs: (keyof SequenceState)[];
  /** the source is ahead of the target: moving the target up is safe; moving it back could hand out values already used */
  sourceAhead: boolean;
  ms: number;
};

async function sequenceOf(q: Query, schema: string, seq: string): Promise<SequenceState> {
  const r = await q(`SELECT s.last_value::text, s.is_called::text, p.start_value::text, p.increment_by::text, p.min_value::text, p.max_value::text, p.cycle::text
    FROM ${rel(schema, seq)} s, pg_sequences p WHERE p.schemaname = ${lit(schema || 'public')} AND p.sequencename = ${lit(seq)}`);
  const v = r.rows[0];
  if (!v) throw new Error(`${schema ? schema + '.' : ''}${seq} is not a sequence there`);
  return { last_value: String(v[0]), is_called: v[1] === 'true', start_value: String(v[2]), increment_by: String(v[3]), min_value: String(v[4]), max_value: String(v[5]), cycle: v[6] === 'true' };
}

/** Where a sequence is on the source and on the target */
export async function diffSequence(opts: { source: Query; target: Query; sourceSchema: string; targetSchema: string; sequence: string }): Promise<SequenceDiffResult> {
  const t0 = Date.now();
  const [source, target] = await Promise.all([sequenceOf(opts.source, opts.sourceSchema, opts.sequence), sequenceOf(opts.target, opts.targetSchema, opts.sequence)]);
  const differs = (Object.keys(source) as (keyof SequenceState)[]).filter(k => String(source[k]) !== String(target[k]));
  // the next value each side hands out, compared as numbers (bigint)
  const next = (s: SequenceState) => BigInt(s.last_value) + (s.is_called ? BigInt(s.increment_by) : 0n);
  const up = BigInt(source.increment_by) >= 0n;
  const sourceAhead = up ? next(source) > next(target) : next(source) < next(target);
  return { kind: 'sequence', sequence: opts.sequence, sourceSchema: opts.sourceSchema, targetSchema: opts.targetSchema, source, target, differs, sourceAhead, ms: Date.now() - t0 };
}

/** The change that moves the target's sequence to where the source's is (only offered when the source is ahead) */
export function syncSequenceSql(d: SequenceDiffResult, opts: { sourceName?: string } = {}): { deploy: string; revert: string; verify: string } {
  const name = lit(qi(d.sequence));
  const deploy = `-- ${d.sequence}: move it to where it is on ${opts.sourceName || 'the source'}\nSELECT setval(${name}, ${d.source.last_value}, ${d.source.is_called});\n`;
  const revert = `-- ${d.sequence}: put it back where it was\nSELECT setval(${name}, ${d.target.last_value}, ${d.target.is_called});\n`;
  const verify = ['-- verify: the sequence is at least where the change moved it (it only moves on from there)', 'DO $$', 'BEGIN',
    `  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN`,
    `    IF (SELECT last_value FROM ${qi(d.sequence)}) ${BigInt(d.source.increment_by) >= 0n ? '<' : '>'} ${d.source.last_value} THEN RAISE EXCEPTION '${d.sequence} is behind where the change moved it'; END IF;`,
    '  END IF;', 'END $$;'].join('\n') + '\n';
  return { deploy, revert, verify };
}

/** A function's definition on one side ('' = not there), without its schema (each environment runs in its own) */
export type FunctionState = { definition: string; result: string; srcMd5: string };
export type FunctionDiffResult = {
  kind: 'function'; function: string; sourceSchema: string; targetSchema: string;
  source: FunctionState; target: FunctionState;
  /** the definitions are the same, schema aside */
  same: boolean;
  /** it returns another type: CREATE OR REPLACE cannot change that, the change drops it first */
  resultDiffers: boolean;
  ms: number;
};

/** name(argument types): how a function is told from its overloads, and what to_regprocedure takes */
export const FUNCTION_SIGNATURE = `p.proname || '(' || oidvectortypes(p.proargtypes) || ')'`;

async function functionOf(q: Query, schema: string, signature: string): Promise<FunctionState> {
  const r = await q(`SELECT pg_get_functiondef(p.oid), pg_get_function_result(p.oid), md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ${lit(schema || 'public')} AND ${FUNCTION_SIGNATURE} = ${lit(signature)}`);
  const v = r.rows[0];
  if (!v) throw new Error(`${schema ? schema + '.' : ''}${signature} is not a function there`);
  // CREATE OR REPLACE FUNCTION zp_st.calc(...) → CREATE OR REPLACE FUNCTION calc(...)
  const s = schema || 'public';
  const re = (x: string) => x.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  const definition = String(v[0]).replace(new RegExp('^(CREATE OR REPLACE (?:FUNCTION|PROCEDURE) )(?:' + re(s) + '|' + re(qi(s)) + ')\\.'), '$1')
    // SET search_path FROM CURRENT is stored as the path it ran with ('zp_st', 'public'): read back as written, so test and prod match
    .replace(new RegExp(`^( SET search_path TO )'?${re(s)}'?(?:, '?public'?)?$`, 'm'), ' SET search_path FROM CURRENT').trimEnd();
  return { definition, result: String(v[1] ?? ''), srcMd5: String(v[2]) };
}

/** One function's definition on the source and on the target */
export async function diffFunction(opts: { source: Query; target: Query; sourceSchema: string; targetSchema: string; signature: string }): Promise<FunctionDiffResult> {
  const t0 = Date.now();
  const [source, target] = await Promise.all([functionOf(opts.source, opts.sourceSchema, opts.signature), functionOf(opts.target, opts.targetSchema, opts.signature)]);
  return {
    kind: 'function', function: opts.signature, sourceSchema: opts.sourceSchema, targetSchema: opts.targetSchema, source, target,
    same: source.definition === target.definition, resultDiffers: source.result !== target.result, ms: Date.now() - t0,
  };
}

/** The change that puts the source's definition on the target; the revert puts the target's back */
export function syncFunctionSql(d: FunctionDiffResult, opts: { sourceName?: string } = {}): { deploy: string; revert: string; verify: string } {
  const isProc = /^CREATE OR REPLACE PROCEDURE/.test(d.source.definition);
  const name = d.function.replace(/^([^(]+)/, (_, n: string) => qi(n));
  const drop = d.resultDiffers ? `DROP ${isProc ? 'PROCEDURE' : 'FUNCTION'} ${name};\n` : '';
  const deploy = `-- ${d.function}: the definition on ${opts.sourceName || 'the source'}\n${drop}${d.source.definition};\n`;
  const revert = `-- ${d.function}: put the definition back as it was\n${drop}${d.target.definition};\n`;
  const body = `(SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(${lit(name)}))`;
  const verify = ['-- verify: the body is the one the change put there (applied) or the one it had (reverted)', 'DO $$', 'BEGIN',
    `  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN`,
    `    IF ${body} IS DISTINCT FROM ${lit(d.source.srcMd5)} THEN RAISE EXCEPTION '${d.function} does not have the new body'; END IF;`,
    '  ELSE',
    `    IF ${body} IS DISTINCT FROM ${lit(d.target.srcMd5)} THEN RAISE EXCEPTION '${d.function} was not put back'; END IF;`,
    '  END IF;', 'END $$;'].join('\n') + '\n';
  return { deploy, revert, verify };
}
