/**
 * Zero-downtime change templates (expand / contract, as pgroll and the "parallel change" pattern do).
 * Each template is one or two DMCR changes with deploy, verify and revert; the second (contract)
 * requires the first and ships after the application has switched over.
 *
 *   dual-write   rename a column or change its type: add the new column, backfill it, keep both in
 *                sync with a trigger; contract drops the trigger and the old column (danger_: the DBA runs it)
 *   not-null     NOT NULL without the long ACCESS EXCLUSIVE scan: CHECK (col IS NOT NULL) NOT VALID,
 *                then VALIDATE (no write lock) and SET NOT NULL (instant once a valid check exists)
 *   foreign-key  FOREIGN KEY ... NOT VALID, then VALIDATE CONSTRAINT (no write lock)
 *   index        CREATE INDEX CONCURRENTLY IF NOT EXISTS outside a transaction ("transaction": false)
 *
 * Verify scripts are DMCR guards: when the change is applied its objects exist; when it is not, they don't.
 */

export type ZdPattern = 'dual-write' | 'not-null' | 'foreign-key' | 'index';

export interface ZdParams {
  table: string;           // schema.table (public. when no schema)
  column?: string;         // dual-write: the old column; not-null / foreign-key: the column
  newColumn?: string;      // dual-write
  newType?: string;        // dual-write: type of the new column
  oldType?: string;        // dual-write: type of the old column (the contract's revert adds it back); default newType
  oldNotNull?: boolean;    // dual-write: the old column is NOT NULL (the contract's revert sets it again)
  toNew?: string;          // dual-write: expression for the new value from {old}  (default {old})
  toOld?: string;          // dual-write: expression for the old value from {new}  (default {new})
  refTable?: string;       // foreign-key
  refColumn?: string;      // foreign-key
  columns?: string;        // index: column list
  unique?: boolean;        // index
  name?: string;           // constraint / index name (optional)
}

export interface ZdPhase {
  phase: 'expand' | 'contract' | 'single';
  changeName: string;
  kind: string;
  deploySql: string; verifySql: string; revertSql: string;
  meta: Record<string, unknown>;
  /** What has to happen between this phase and the next one (shown to the DBA) */
  next?: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** schema.table split and validated; identifiers are lower-case snake case (quoted output is not needed). */
function tableRef(t: string): { schema: string; table: string; full: string } {
  const parts = t.trim().toLowerCase().split('.');
  const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];
  // the schema may be the ${schema} placeholder (each environment's own schema, substituted by the runner)
  for (const p of [schema, table]) if (!p || !(IDENT.test(p) || (p === schema && p === '${schema}'))) throw new Error(`Not a table name: ${t} (use schema.table or ${'${schema}'}.table, lower-case letters, digits and _)`);
  return { schema, table, full: `${schema}.${table}` };
}
function ident(v: string | undefined, what: string): string {
  const x = (v ?? '').trim().toLowerCase();
  if (!IDENT.test(x)) throw new Error(`Not a ${what}: ${v ?? ''} (lower-case letters, digits and _)`);
  return x;
}
function sqlFragment(v: string | undefined, what: string): string {
  const x = (v ?? '').trim();
  if (!x) throw new Error(`${what} is required`);
  if (/;|--|\/\*|\$\$/.test(x)) throw new Error(`${what} must be a single expression (no ;, comments or $$)`);
  return x;
}
/** PostgreSQL truncates identifiers to 63 bytes: keep generated names inside that. */
const cap = (s: string) => s.slice(0, 63);
const lit = (s: string) => s.replace(/'/g, "''");

/** DMCR guard verify: applied => `whenApplied` holds, not applied => `whenNot` holds. */
function guard(whenApplied: string, whenNot: string, msgApplied: string, msgNot: string): string {
  return `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
    IF NOT (${whenApplied}) THEN RAISE EXCEPTION '${lit(msgApplied)}'; END IF;
  ELSE
    IF NOT (${whenNot}) THEN RAISE EXCEPTION '${lit(msgNot)}'; END IF;
  END IF;
END $$;
`;
}
const colExists = (s: string, t: string, c: string) =>
  `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${s}' AND table_name = '${t}' AND column_name = '${c}')`;
const conExists = (s: string, t: string, n: string, validated?: boolean) =>
  `EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${s}' AND r.relname = '${t}' AND c.conname = '${n}'${validated === undefined ? '' : ` AND c.convalidated = ${validated}`})`;
const trgExists = (s: string, t: string, n: string) =>
  `EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${s}' AND r.relname = '${t}' AND g.tgname = '${n}' AND NOT g.tgisinternal)`;
const notNull = (s: string, t: string, c: string) =>
  `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${s}' AND table_name = '${t}' AND column_name = '${c}' AND is_nullable = 'NO')`;

function dualWrite(p: ZdParams): ZdPhase[] {
  const { schema, table, full } = tableRef(p.table);
  const oldC = ident(p.column, 'column');
  const newC = ident(p.newColumn, 'new column name');
  if (oldC === newC) throw new Error('The new column needs another name than the old one');
  const type = sqlFragment(p.newType, 'Type of the new column');
  const toNew = (p.toNew?.trim() || '{old}'); const toOld = (p.toOld?.trim() || '{new}');
  sqlFragment(toNew, 'Old to new expression'); sqlFragment(toOld, 'New to old expression');
  const rename = toNew === '{old}' && toOld === '{new}';
  const oldType = p.oldType?.trim() ? sqlFragment(p.oldType, 'Type of the old column') : type;
  const fx = (e: string, oldRef: string, newRef: string) => e.split('{old}').join(oldRef).split('{new}').join(newRef);
  const fn = `${schema}.${cap(`dmcr_sync_${table}_${newC}`)}`;
  const trg = cap(`dmcr_sync_${newC}`);
  const fnBody = `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- both columns stay in sync while old and new application versions run side by side
  IF TG_OP = 'INSERT' THEN
    IF NEW.${newC} IS NULL AND NEW.${oldC} IS NOT NULL THEN NEW.${newC} := ${fx(toNew, `NEW.${oldC}`, `NEW.${newC}`)};
    ELSIF NEW.${oldC} IS NULL AND NEW.${newC} IS NOT NULL THEN NEW.${oldC} := ${fx(toOld, `NEW.${oldC}`, `NEW.${newC}`)};
    END IF;
  ELSIF NEW.${newC} IS DISTINCT FROM OLD.${newC} THEN
    NEW.${oldC} := ${fx(toOld, `NEW.${oldC}`, `NEW.${newC}`)};
  ELSIF NEW.${oldC} IS DISTINCT FROM OLD.${oldC} THEN
    NEW.${newC} := ${fx(toNew, `NEW.${oldC}`, `NEW.${newC}`)};
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ${trg} BEFORE INSERT OR UPDATE ON ${full} FOR EACH ROW EXECUTE FUNCTION ${fn}();`;
  const what = rename ? `rename ${full}.${oldC} to ${newC}` : `change ${full}.${oldC} to ${type} as ${newC}`;
  const expand: ZdPhase = {
    phase: 'expand', kind: 'ddl',
    changeName: cap(`${rename ? 'rename' : 'retype'}_${table}_${oldC}_expand`),
    deploySql: `-- Expand (zero downtime): ${what}. Old and new application versions both work after this.
-- Copy what ${oldC} has to ${newC} here if it needs it: NOT NULL (see the not-null template), default, indexes, constraints.
ALTER TABLE ${full} ADD COLUMN IF NOT EXISTS ${newC} ${type};
-- backfill before the sync trigger, with the table's own triggers off (an updated_at trigger must not
-- see a schema migration as an edit). This transaction holds the table lock, so no write slips in between.
-- On a large table backfill in batches (WHERE id BETWEEN ...) in changes before this one.
ALTER TABLE ${full} DISABLE TRIGGER USER;
UPDATE ${full} SET ${newC} = ${fx(toNew, oldC, newC)} WHERE ${newC} IS NULL AND ${oldC} IS NOT NULL;
ALTER TABLE ${full} ENABLE TRIGGER USER;
${fnBody}
`,
    verifySql: guard(`${colExists(schema, table, newC)} AND ${trgExists(schema, table, trg)}`, `NOT ${colExists(schema, table, newC)}`,
      `${newC} or its sync trigger is missing`, `${newC} is still there after the revert`),
    revertSql: `DROP TRIGGER IF EXISTS ${trg} ON ${full};
DROP FUNCTION IF EXISTS ${fn}();
ALTER TABLE ${full} DROP COLUMN IF EXISTS ${newC};
`,
    meta: { description: `Expand: ${what}. Adds ${newC}, backfills it and keeps ${oldC} and ${newC} in sync with a trigger, so the old and the new application version both work.`, tags: ['zero-downtime', 'expand'] },
    next: `Deploy the application version that reads and writes ${newC}, and move views and functions that use ${oldC} to ${newC}. When no running version uses ${oldC} any more, ship the contract change.`,
  };
  const contract: ZdPhase = {
    phase: 'contract', kind: 'ddl',
    changeName: cap(`${rename ? 'rename' : 'retype'}_${table}_${oldC}_contract`),
    deploySql: `-- Contract (zero downtime): ${what}. Only after every running application version uses ${newC}.
-- Views on ${oldC} would block the drop: name them, so they are moved to ${newC} first (in their own change).
DO $$ DECLARE v text; BEGIN
  SELECT string_agg(DISTINCT r.ev_class::regclass::text, ', ') INTO v
    FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refobjid = '${full}'::regclass AND a.attname = '${oldC}' AND r.ev_class <> d.refobjid;
  IF v IS NOT NULL THEN RAISE EXCEPTION 'DMCR: views still use ${full}.${oldC}: %. Recreate them on ${newC} first.', v; END IF;
END $$;
DROP TRIGGER IF EXISTS ${trg} ON ${full};
DROP FUNCTION IF EXISTS ${fn}();
ALTER TABLE ${full} DROP COLUMN IF EXISTS ${oldC};
`,
    verifySql: guard(`NOT ${colExists(schema, table, oldC)} AND NOT ${trgExists(schema, table, trg)}`, `${colExists(schema, table, oldC)} AND ${trgExists(schema, table, trg)}`,
      `${oldC} or the sync trigger is still there`, `${oldC} or its sync trigger is missing after the revert`),
    revertSql: `ALTER TABLE ${full} ADD COLUMN IF NOT EXISTS ${oldC} ${oldType};
UPDATE ${full} SET ${oldC} = ${fx(toOld, oldC, newC)};
${p.oldNotNull ? `ALTER TABLE ${full} ALTER COLUMN ${oldC} SET NOT NULL;
` : ''}${fnBody}
`,
    meta: { description: `Contract: ${what}. Drops the sync trigger and ${oldC}. Run it only when no running application version uses ${oldC}.`, tags: ['zero-downtime', 'contract'] },
  };
  return [expand, contract];
}

function notNullTpl(p: ZdParams): ZdPhase[] {
  const { schema, table, full } = tableRef(p.table);
  const c = ident(p.column, 'column');
  const name = p.name?.trim() ? ident(p.name, 'constraint name') : cap(`${table}_${c}_not_null`);
  return [{
    phase: 'expand', kind: 'ddl', changeName: cap(`not_null_${table}_${c}_check`),
    deploySql: `-- NOT NULL without the long lock, step 1: a NOT VALID check is instant and holds for every new or updated row.
ALTER TABLE ${full} ADD CONSTRAINT ${name} CHECK (${c} IS NOT NULL) NOT VALID;
`,
    verifySql: guard(conExists(schema, table, name), `NOT ${conExists(schema, table, name)}`, `${name} is missing`, `${name} is still there after the revert`),
    revertSql: `ALTER TABLE ${full} DROP CONSTRAINT IF EXISTS ${name};\n`,
    meta: { description: `Step 1 of NOT NULL on ${full}.${c}: CHECK (${c} IS NOT NULL) NOT VALID.`, tags: ['zero-downtime', 'expand'] },
    // a backfill is a data change of its own: a revert cannot give rows their NULLs back
    next: `Rows that are NULL today fail step 2: fill them in a data change of their own (UPDATE ${full} SET ${c} = ... WHERE ${c} IS NULL, in batches on a large table). Then ship step 2.`,
  }, {
    phase: 'contract', kind: 'ddl', changeName: cap(`not_null_${table}_${c}_set`),
    deploySql: `-- NOT NULL without the long lock, step 2: VALIDATE scans without blocking writes; SET NOT NULL then uses the valid check (PostgreSQL 12+).
ALTER TABLE ${full} VALIDATE CONSTRAINT ${name};
ALTER TABLE ${full} ALTER COLUMN ${c} SET NOT NULL;
ALTER TABLE ${full} DROP CONSTRAINT ${name};
`,
    verifySql: guard(`${notNull(schema, table, c)} AND NOT ${conExists(schema, table, name)}`, `NOT ${notNull(schema, table, c)} AND ${conExists(schema, table, name)}`,
      `${c} is not NOT NULL`, `${c} is still NOT NULL after the revert`),
    revertSql: `ALTER TABLE ${full} ALTER COLUMN ${c} DROP NOT NULL;
ALTER TABLE ${full} ADD CONSTRAINT ${name} CHECK (${c} IS NOT NULL) NOT VALID;
`,
    meta: { description: `Step 2 of NOT NULL on ${full}.${c}: VALIDATE the check, SET NOT NULL, drop the check.`, tags: ['zero-downtime', 'contract'] },
  }];
}

function foreignKey(p: ZdParams): ZdPhase[] {
  const { schema, table, full } = tableRef(p.table);
  const c = ident(p.column, 'column');
  const ref = tableRef(p.refTable ?? '');
  const rc = ident(p.refColumn || 'id', 'referenced column');
  const name = p.name?.trim() ? ident(p.name, 'constraint name') : cap(`${table}_${c}_fkey`);
  return [{
    phase: 'expand', kind: 'ddl', changeName: cap(`fk_${table}_${c}_add`),
    deploySql: `-- Foreign key without the long lock, step 1: NOT VALID is instant; new and updated rows are checked from now on.
ALTER TABLE ${full} ADD CONSTRAINT ${name} FOREIGN KEY (${c}) REFERENCES ${ref.full} (${rc}) NOT VALID;
`,
    verifySql: guard(conExists(schema, table, name), `NOT ${conExists(schema, table, name)}`, `${name} is missing`, `${name} is still there after the revert`),
    revertSql: `ALTER TABLE ${full} DROP CONSTRAINT IF EXISTS ${name};\n`,
    meta: { description: `Step 1 of the foreign key ${full}.${c} -> ${ref.full}.${rc}: added NOT VALID.`, tags: ['zero-downtime', 'expand'] },
    next: `Fix rows whose ${c} has no match in ${ref.full} (the validation fails on them). Then ship step 2.`,
  }, {
    phase: 'contract', kind: 'ddl', changeName: cap(`fk_${table}_${c}_validate`),
    deploySql: `-- Foreign key without the long lock, step 2: VALIDATE scans existing rows without blocking writes.
ALTER TABLE ${full} VALIDATE CONSTRAINT ${name};
`,
    verifySql: guard(conExists(schema, table, name, true), conExists(schema, table, name, false), `${name} is not validated`, `${name} should be NOT VALID again after the revert`),
    revertSql: `-- A validated constraint cannot be marked NOT VALID again: drop it and add it back NOT VALID
ALTER TABLE ${full} DROP CONSTRAINT IF EXISTS ${name};
ALTER TABLE ${full} ADD CONSTRAINT ${name} FOREIGN KEY (${c}) REFERENCES ${ref.full} (${rc}) NOT VALID;
`,
    meta: { description: `Step 2 of the foreign key ${full}.${c} -> ${ref.full}.${rc}: VALIDATE CONSTRAINT.`, tags: ['zero-downtime', 'contract'] },
  }];
}

function indexTpl(p: ZdParams): ZdPhase[] {
  const { schema, table, full } = tableRef(p.table);
  const cols = (p.columns ?? '').split(',').map(x => ident(x, 'column'));
  if (!cols.length) throw new Error('Name at least one column');
  const name = p.name?.trim() ? ident(p.name, 'index name') : cap(`${table}_${cols.join('_')}_${p.unique ? 'key' : 'idx'}`);
  return [{
    phase: 'single', kind: 'ddl', changeName: cap(`index_${table}_${cols.join('_')}`),
    deploySql: `-- Built CONCURRENTLY: reads and writes go on while it builds. Runs outside a transaction ("transaction": false).
CREATE ${p.unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${full} (${cols.join(', ')});
`,
    verifySql: guard(
      `EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_namespace n ON n.oid = x.relnamespace WHERE n.nspname = '${schema}' AND x.relname = '${name}' AND i.indisvalid)`,
      `to_regclass('${schema}.${name}') IS NULL`,
      `${name} is missing or INVALID (a failed CONCURRENTLY build: drop it and deploy again)`, `${name} is still there after the revert`),
    revertSql: `DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${name};\n`,
    meta: { description: `${p.unique ? 'Unique index' : 'Index'} ${name} on ${full} (${cols.join(', ')}), built CONCURRENTLY.`, transaction: false, tags: ['zero-downtime'] },
  }];
}

export function buildZeroDowntime(pattern: ZdPattern, p: ZdParams): ZdPhase[] {
  switch (pattern) {
    case 'dual-write': return dualWrite(p);
    case 'not-null': return notNullTpl(p);
    case 'foreign-key': return foreignKey(p);
    case 'index': return indexTpl(p);
    default: throw new Error(`Unknown pattern: ${pattern as string}`);
  }
}
