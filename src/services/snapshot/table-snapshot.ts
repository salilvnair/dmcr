/**
 * Table snapshot: a DMCR change that copies a table into <table>_backup_DD_MM_YYYY.
 *
 * The change is an ordinary change folder, so it goes through the same pipeline as any other:
 * deploy in test, promote to prod, `dmcr test` round-trips it, revert drops the copy.
 *
 *   deploy.sql  CREATE TABLE <backup> (same columns, exact types, NOT NULL, primary key)
 *               INSERT INTO <backup> SELECT … FROM <source> [WHERE …]   (skipped for structure only)
 *               COMMENT ON TABLE <backup> with the number of rows copied
 *   verify.sql  applied: the copy exists, has the source's columns, and holds the recorded row count
 *               reverted: the copy is gone
 *   revert.sql  DROP TABLE <backup>
 *
 * Deliberately NOT copied: defaults (a nextval() default would tie the copy to the source's
 * sequence), foreign keys, other constraints, indexes, triggers and grants — the copy is data
 * to restore from, not a second live table. Generated columns are copied as plain values.
 *
 * Pure functions — no VS Code, no MCP — so they are unit-tested and reused by DMCR Web.
 */

export interface SnapshotColumn {
  name: string;
  /** pg_catalog.format_type() — keeps typmods such as varchar(40) and numeric(12,2) */
  type: string;
  notNull: boolean;
}

export type SnapshotRows = 'all' | 'where' | 'none';

export interface SnapshotSpec {
  schema: string;
  table: string;
  columns: SnapshotColumn[];
  primaryKey: string[];
  rows: SnapshotRows;
  /** SQL condition for rows = 'where' (without the WHERE keyword) */
  where?: string;
  backupName: string;
  /** Schema for the copy; defaults to the source schema */
  backupSchema?: string;
  /** Where the structure was read from, for the header comment */
  sourceLabel?: string;
  /** Rows matched when the change was generated (informational) */
  rowsAtGeneration?: number;
  generatedAt?: Date;
}

export interface SnapshotChange {
  changeName: string;
  deploySql: string;
  verifySql: string;
  revertSql: string;
  metaJson: string;
}

// PostgreSQL reserved key words (SQL Key Words appendix, "reserved" in the PostgreSQL column)
const RESERVED = new Set(('all analyse analyze and any array as asc asymmetric authorization binary both case cast check ' +
  'collate collation column concurrently constraint create cross current_catalog current_date current_role ' +
  'current_schema current_time current_timestamp current_user default deferrable desc distinct do else end ' +
  'except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into ' +
  'is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on ' +
  'only or order outer overlaps placing primary references returning right select session_user similar some ' +
  'symmetric system_user table tablesample then to trailing true union unique user using variadic verbose ' +
  'when where window with').split(' '));

/** Quote an identifier only when it needs it (keeps generated SQL readable). */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)) { return name; }
  return `"${name.replace(/"/g, '""')}"`;
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const MAX_IDENT = 63; // NAMEDATALEN - 1

/** <table>_backup_DD_MM_YYYY, shortened so it fits in 63 bytes. */
export function snapshotName(table: string, date = new Date()): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const suffix = `_backup_${dd}_${mm}_${date.getFullYear()}`;
  let base = table;
  while (Buffer.byteLength(base + suffix, 'utf8') > MAX_IDENT) { base = base.slice(0, -1); }
  return base + suffix;
}

/** First of name, name_2, name_3 … not in `taken` (still within 63 bytes). */
export function uniqueSnapshotName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) { return name; }
  for (let i = 2; ; i++) {
    const tail = `_${i}`;
    let base = name;
    while (Buffer.byteLength(base + tail, 'utf8') > MAX_IDENT) { base = base.slice(0, -1); }
    if (!used.has(base + tail)) { return base + tail; }
  }
}

/** Rejects a WHERE condition that could end the statement or hide SQL in comments. */
export function checkWhere(where: string): string | null {
  const w = where.trim();
  if (!w) { return 'Enter a condition, or choose all rows'; }
  if (/;/.test(w.replace(/'(?:[^']|'')*'/g, "''"))) { return 'The condition must not contain ";"'; }
  if (/--|\/\*/.test(w.replace(/'(?:[^']|'')*'/g, "''"))) { return 'The condition must not contain comments'; }
  return null;
}

/** Change folder name part: snapshot_<table> (lowercase letters, digits and _). */
function changeNameFor(table: string): string {
  const slug = table.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'table';
  return `snapshot_${slug}`.slice(0, 60);
}

export function buildTableSnapshot(spec: SnapshotSpec): SnapshotChange {
  if (!spec.columns.length) { throw new Error(`${spec.schema}.${spec.table} has no columns to copy`); }
  if (spec.rows === 'where') {
    const problem = checkWhere(spec.where ?? '');
    if (problem) { throw new Error(problem); }
  }
  if (Buffer.byteLength(spec.backupName, 'utf8') > MAX_IDENT) { throw new Error(`Backup name is longer than ${MAX_IDENT} bytes`); }

  const src = `${quoteIdent(spec.schema)}.${quoteIdent(spec.table)}`;
  const bschema = spec.backupSchema || spec.schema;
  const dst = `${quoteIdent(bschema)}.${quoteIdent(spec.backupName)}`;
  const dstLit = sqlLiteral(`${quoteIdent(bschema)}.${quoteIdent(spec.backupName)}`);
  const dstText = `${bschema}.${spec.backupName}`.replace(/'/g, "''");
  const cols = spec.columns.map(c => quoteIdent(c.name));
  const when = (spec.generatedAt ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const rowsLabel = spec.rows === 'all' ? 'all rows' : spec.rows === 'where' ? `rows WHERE ${spec.where!.trim()}` : 'structure only (no rows)';

  const colDefs = spec.columns.map(c => `    ${quoteIdent(c.name)} ${c.type}${c.notNull ? ' NOT NULL' : ''}`);
  if (spec.primaryKey.length) { colDefs.push(`    PRIMARY KEY (${spec.primaryKey.map(quoteIdent).join(', ')})`); }

  const header = [
    `-- Snapshot of ${spec.schema}.${spec.table} into ${bschema}.${spec.backupName}`,
    `-- Rows: ${rowsLabel}`,
    `-- Structure read from ${spec.sourceLabel ?? 'the database'} at ${when}` +
      (spec.rowsAtGeneration !== undefined ? ` (${spec.rowsAtGeneration} matching rows then; the copy is taken when this change deploys)` : ''),
    `-- Copied: column names, exact types, NOT NULL, primary key. Not copied: defaults, other constraints, indexes, triggers, grants.`,
  ];

  // The copy has exactly the columns reviewed here. If the table changed since (a column added
  // by an earlier change in the same release, say), stop rather than silently leave it out.
  const expectedCols = spec.columns.map(c => `${c.name} ${c.type}`).join(', ');
  const srcLit = sqlLiteral(src);
  const deploy = [
    ...header,
    '',
    '-- Stop if the table is no longer what this script was generated from',
    'DO $$',
    'DECLARE cols text;',
    'BEGIN',
    '  SELECT string_agg(a.attname || \' \' || pg_catalog.format_type(a.atttypid, a.atttypmod), \', \' ORDER BY a.attnum) INTO cols',
    `  FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass(${srcLit}) AND a.attnum > 0 AND NOT a.attisdropped;`,
    `  IF cols IS DISTINCT FROM ${sqlLiteral(expectedCols)} THEN`,
    `    RAISE EXCEPTION 'snapshot of %: the table has changed since this change was generated (columns now: %) — generate the snapshot again', ${srcLit}, coalesce(cols, 'table missing');`,
    '  END IF;',
    'END $$;',
    '',
    `CREATE TABLE ${dst} (`,
    colDefs.join(',\n'),
    ');',
    '',
  ];
  if (spec.rows !== 'none') {
    deploy.push(
      `INSERT INTO ${dst} (${cols.join(', ')})`,
      `SELECT ${cols.join(', ')}`,
      `FROM ${src}${spec.rows === 'where' ? `\nWHERE ${spec.where!.trim()}` : ''};`,
      '',
    );
  }
  deploy.push(
    '-- The row count is recorded on the copy; verify.sql checks it',
    'DO $$',
    'DECLARE n bigint;',
    'BEGIN',
    `  SELECT count(*) INTO n FROM ${dst};`,
    `  EXECUTE format('COMMENT ON TABLE ${dst.replace(/'/g, "''")} IS %L',`,
    `    'DMCR snapshot of ${`${spec.schema}.${spec.table}`.replace(/'/g, "''")}: ' || n || ' rows (change __DMCR_CHANGE_ID__)');`,
    'END $$;',
    '',
  );

  const verify = [
    `-- ${bschema}.${spec.backupName}: present with the recorded row count when applied, gone when reverted`,
    'DO $$',
    'DECLARE',
    '  n bigint;',
    '  recorded text;',
    '  cols int;',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN",
    `    IF to_regclass(${dstLit}) IS NULL THEN`,
    `      RAISE EXCEPTION 'snapshot table ${dstText} is missing';`,
    '    END IF;',
    `    SELECT count(*) INTO cols FROM pg_attribute WHERE attrelid = to_regclass(${dstLit}) AND attnum > 0 AND NOT attisdropped;`,
    `    IF cols <> ${spec.columns.length} THEN`,
    `      RAISE EXCEPTION 'snapshot table has % columns, expected ${spec.columns.length}', cols;`,
    '    END IF;',
    `    EXECUTE 'SELECT count(*) FROM ' || ${dstLit} INTO n;`,
    `    recorded := substring(obj_description(to_regclass(${dstLit}), 'pg_class') FROM ': ([0-9]+) rows');`,
    '    IF recorded IS NULL OR n <> recorded::bigint THEN',
    "      RAISE EXCEPTION 'snapshot table has % rows, but % were copied', n, coalesce(recorded, '(no record)');",
    '    END IF;',
    '  ELSE',
    `    IF to_regclass(${dstLit}) IS NOT NULL THEN`,
    "      RAISE EXCEPTION 'snapshot table still exists after revert';",
    '    END IF;',
    '  END IF;',
    'END $$;',
    '',
  ];

  const revert = [
    `-- Drops the snapshot copy only; ${spec.schema}.${spec.table} is never touched`,
    `DROP TABLE IF EXISTS ${dst};`,
    '',
  ];

  const meta = {
    description: `Snapshot of ${spec.schema}.${spec.table} (${rowsLabel}) into ${bschema}.${spec.backupName}`,
    snapshot: {
      source: `${spec.schema}.${spec.table}`,
      target: `${bschema}.${spec.backupName}`,
      rows: spec.rows,
      ...(spec.rows === 'where' ? { where: spec.where!.trim() } : {}),
      read_from: spec.sourceLabel ?? null,
      rows_at_generation: spec.rowsAtGeneration ?? null,
      generated_at: when,
    },
  };

  return {
    changeName: changeNameFor(spec.table),
    deploySql: deploy.join('\n'),
    verifySql: verify.join('\n'),
    revertSql: revert.join('\n'),
    metaJson: JSON.stringify(meta, null, 2) + '\n',
  };
}

/** Catalog query for the columns, exact types and NOT NULL of one table (one read-only statement). */
export function columnsQuery(schema: string, table: string): string {
  return `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${sqlLiteral(schema)} AND c.relname = ${sqlLiteral(table)} AND c.relkind IN ('r', 'p')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;
}

export function primaryKeyQuery(schema: string, table: string): string {
  return `SELECT a.attname AS name
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE n.nspname = ${sqlLiteral(schema)} AND c.relname = ${sqlLiteral(table)} AND con.contype = 'p'
ORDER BY k.ord`;
}

/** Existing relation names in the schema that start with the backup name (for _2, _3 …). */
export function takenNamesQuery(schema: string, prefix: string): string {
  return `SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${sqlLiteral(schema)} AND left(c.relname, ${prefix.length}) = ${sqlLiteral(prefix)}`;
}

export function countQuery(schema: string, table: string, where?: string): string {
  return `SELECT count(*) AS n FROM ${quoteIdent(schema)}.${quoteIdent(table)}${where ? ` WHERE ${where.trim()}` : ''}`;
}
