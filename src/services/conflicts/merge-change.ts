/**
 * A merge change resolves a conflict the way a merge commit does in git: one new change, after both
 * sides, that puts the merged result in place. It keeps what it replaced in a dmcr.bak_* table so
 * revert.sql restores exactly that, and verify.sql checks both states.
 *
 *  - definition (function / view): the merged definition from the merge editor
 *  - data: per conflicting row, the value of the side picked; with rows that cannot be listed,
 *    one side's expression for the rows both sides write
 */
import { createHash } from 'crypto';
import type { Conflict } from './analyze';

export interface MergeInput {
  /** definition conflicts: the resolved definition (no conflict markers left) */
  result?: string;
  /** data conflicts: row key -> side whose value wins; '*' for every row */
  picks?: Record<string, 'ours' | 'theirs'>;
}

export interface MergeSql { changeName: string; deploySql: string; verifySql: string; revertSql: string; description: string }

const BAK = 'dmcr.bak___DMCR_CHANGE_ID__';
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const slug = (s: string) => s.toLowerCase().replace(/\(.*$/, '').replace(/^public\./, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export function hasMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})( |$)/m.test(text);
}

/** The $tag$ body of a function definition (what pg_proc.prosrc stores). */
function functionBody(def: string): string | null {
  const m = /\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/i.exec(def);
  return m ? m[2] : null;
}

export function buildMergeChange(c: Conflict, input: MergeInput): MergeSql {
  const sides = `${c.ours.changeId} (${c.ours.project}) and ${c.theirs.changeId} (${c.theirs.project})`;
  if (c.kind === 'definition') return definitionMerge(c, input, sides);
  if (c.kind === 'data') return dataMerge(c, input, sides);
  throw new Error(`A ${c.kind} conflict is resolved by changing one side or by recording the decision; a merge change cannot fix it.`);
}

function definitionMerge(c: Conflict, input: MergeInput, sides: string): MergeSql {
  const result = (input.result ?? '').trim();
  if (!result) throw new Error('The merged definition is empty.');
  if (hasMarkers(result)) throw new Error('Resolve every conflict first: the result still has <<<<<<< / ======= / >>>>>>> markers.');
  const isFn = c.key.startsWith('function:');
  const isView = c.key.startsWith('view:');
  if (!isFn && !isView) throw new Error('Merge changes are built for functions and views; resolve a trigger by editing one side.');
  const obj = c.object;
  const def = /;\s*$/.test(result) ? result : `${result};`;
  const getDef = isFn
    ? `SELECT CASE WHEN to_regprocedure(${lit(obj)}) IS NULL THEN NULL ELSE pg_get_functiondef(to_regprocedure(${lit(obj)})) END AS def`
    : `SELECT CASE WHEN to_regclass(${lit(obj)}) IS NULL THEN NULL ELSE 'CREATE OR REPLACE VIEW ${obj} AS ' || pg_get_viewdef(to_regclass(${lit(obj)})) END AS def`;
  const deploySql = [
    `-- DMCR merge change: ${obj}`,
    `-- Merges ${sides}: both change ${obj}, and whichever deployed last`,
    `-- would drop the other's lines. This puts the merged definition in place, after both.`,
    `-- The definition it replaces is kept in ${BAK} so revert restores it exactly.`,
    '',
    `CREATE TABLE IF NOT EXISTS ${BAK} AS`,
    `${getDef};`,
    '',
    def,
    '',
  ].join('\n');
  const body = isFn ? functionBody(def) : null;
  const md5 = body !== null ? createHash('md5').update(body, 'utf8').digest('hex') : null;
  const appliedCheck = isFn
    ? (md5
      ? `    IF to_regprocedure(${lit(obj)}) IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(${lit(obj)})) <> '${md5}' THEN\n      RAISE EXCEPTION '${obj} is not the merged definition';\n    END IF;`
      : `    IF to_regprocedure(${lit(obj)}) IS NULL THEN\n      RAISE EXCEPTION '${obj} is missing';\n    END IF;`)
    : `    IF to_regclass(${lit(obj)}) IS NULL THEN\n      RAISE EXCEPTION '${obj} is missing';\n    END IF;`;
  const verifySql = [
    `-- Verify: merge of ${obj}`,
    '-- Applied: the merged definition is in place and the backup exists. Reverted: the backup is gone.',
    'DO $verify$',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN",
    appliedCheck,
    `    IF to_regclass('${BAK}') IS NULL THEN`,
    `      RAISE EXCEPTION 'merge of ${obj} is applied but ${BAK} is missing';`,
    '    END IF;',
    '  ELSE',
    `    IF to_regclass('${BAK}') IS NOT NULL THEN`,
    `      RAISE EXCEPTION 'merge of ${obj} is not applied but ${BAK} still exists';`,
    '    END IF;',
    '  END IF;',
    'END',
    '$verify$;',
    '',
  ].join('\n');
  const dropIt = isFn ? `DROP FUNCTION IF EXISTS ${obj}` : `DROP VIEW IF EXISTS ${obj}`;
  const revertSql = [
    `-- Revert: merge of ${obj}`,
    `-- Puts back the definition kept in ${BAK} (the one in place before the merge). Safe to re-run.`,
    'DO $revert$',
    'DECLARE d text;',
    'BEGIN',
    `  IF to_regclass('${BAK}') IS NOT NULL THEN`,
    `    SELECT def INTO d FROM ${BAK};`,
    `    IF d IS NULL THEN EXECUTE ${lit(dropIt)}; ELSE EXECUTE d; END IF;`,
    '  END IF;',
    'END',
    '$revert$;',
    '',
    `DROP TABLE IF EXISTS ${BAK};`,
    '',
  ].join('\n');
  return { changeName: `merge_${slug(obj)}`, deploySql, verifySql, revertSql, description: `Merges ${sides}: both change ${obj}.` };
}

function dataMerge(c: Conflict, input: MergeInput, sides: string): MergeSql {
  const table = c.table!; const col = c.column!; const keyCol = c.keyColumn;
  const picks = input.picks ?? {};
  const pickOf = (k: string) => picks[k] ?? picks['*'];
  const head = [
    `-- DMCR merge change: ${table}.${col}`,
    `-- Merges ${sides}: both set ${col} on the same rows, and whichever deployed last`,
    `-- would overwrite the other. This sets the values picked in the merge editor, after both.`,
    `-- The values it replaces are kept in ${BAK} so revert restores them exactly.`,
    '',
  ];
  if (c.rows?.length && keyCol) {
    const rows = c.rows.map(r => {
      const p = pickOf(r.key);
      if (!p) throw new Error(`Pick a side for ${keyCol} ${r.key}.`);
      const v = p === 'ours' ? r.ours : r.theirs;
      if (v === undefined) throw new Error(`The value ${p === 'ours' ? c.ours.project : c.theirs.project} sets for ${r.key} could not be worked out; pick the other side or edit the change.`);
      return { key: r.key, value: v };
    });
    const keys = rows.map(r => lit(r.key)).join(', ');
    const caseSql = `CASE ${keyCol}\n${rows.map(r => `        WHEN ${lit(r.key)} THEN ${r.value}`).join('\n')}\n      END`;
    const deploySql = [...head,
      `CREATE TABLE IF NOT EXISTS ${BAK} AS`,
      `SELECT ${keyCol}, ${col} FROM ${table} WHERE ${keyCol} IN (${keys});`,
      '',
      `UPDATE ${table}`,
      `   SET ${col} = ${caseSql}`,
      ` WHERE ${keyCol} IN (${keys});`,
      ''].join('\n');
    const verifySql = [
      `-- Verify: merge of ${table}.${col}`,
      'DO $verify$',
      'BEGIN',
      "  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN",
      `    IF EXISTS (SELECT 1 FROM ${table} WHERE ${keyCol} IN (${keys}) AND ${col} IS DISTINCT FROM (${caseSql})) THEN`,
      `      RAISE EXCEPTION 'merge of ${table}.${col}: some rows do not have the merged values';`,
      '    END IF;',
      `    IF to_regclass('${BAK}') IS NULL THEN`,
      `      RAISE EXCEPTION 'merge of ${table}.${col} is applied but ${BAK} is missing';`,
      '    END IF;',
      '  ELSE',
      `    IF to_regclass('${BAK}') IS NOT NULL THEN`,
      `      RAISE EXCEPTION 'merge of ${table}.${col} is not applied but ${BAK} still exists';`,
      '    END IF;',
      '  END IF;',
      'END',
      '$verify$;',
      ''].join('\n');
    const revertSql = [
      `-- Revert: merge of ${table}.${col}`,
      `-- Restores the ${col} values kept in ${BAK}. Safe to re-run.`,
      'DO $revert$',
      'BEGIN',
      `  IF to_regclass('${BAK}') IS NOT NULL THEN`,
      `    UPDATE ${table} t SET ${col} = b.${col} FROM ${BAK} b WHERE t.${keyCol} = b.${keyCol};`,
      '  END IF;',
      'END',
      '$revert$;',
      '',
      `DROP TABLE IF EXISTS ${BAK};`,
      ''].join('\n');
    return { changeName: `merge_${slug(table)}_${col}`, deploySql, verifySql, revertSql, description: `Merges ${sides}: ${rows.length} rows of ${table}.${col}.` };
  }
  // rows not listed: one side's expression for the rows both sides write
  const p = pickOf('*');
  if (!p) throw new Error('Pick the side whose values win.');
  if ((c.alias?.ours ?? '') !== (c.alias?.theirs ?? '')) throw new Error('The two changes name the table differently; edit one side instead.');
  if (!keyCol) throw new Error('The rows have no key column DMCR can back up; edit one side instead.');
  const alias = c.alias?.ours ? ` AS ${c.alias.ours}` : '';
  const pred = `(${c.where?.ours || 'true'}) AND (${c.where?.theirs || 'true'})`;
  const expr = p === 'ours' ? c.oursExpr! : c.theirsExpr!;
  const deploySql = [...head,
    `CREATE TABLE IF NOT EXISTS ${BAK} AS`,
    `SELECT ${keyCol}, ${col} FROM ${table}${alias} WHERE ${pred};`,
    '',
    `UPDATE ${table}${alias}`,
    `   SET ${col} = ${expr}`,
    ` WHERE ${pred};`,
    ''].join('\n');
  const verifySql = [
    `-- Verify: merge of ${table}.${col}`,
    'DO $verify$',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN",
    `    IF to_regclass('${BAK}') IS NULL THEN RAISE EXCEPTION 'merge of ${table}.${col} is applied but ${BAK} is missing'; END IF;`,
    `  ELSIF to_regclass('${BAK}') IS NOT NULL THEN`,
    `    RAISE EXCEPTION 'merge of ${table}.${col} is not applied but ${BAK} still exists';`,
    '  END IF;',
    'END',
    '$verify$;',
    ''].join('\n');
  const revertSql = [
    `-- Revert: merge of ${table}.${col}`,
    'DO $revert$',
    'BEGIN',
    `  IF to_regclass('${BAK}') IS NOT NULL THEN`,
    `    UPDATE ${table} t SET ${col} = b.${col} FROM ${BAK} b WHERE t.${keyCol} = b.${keyCol};`,
    '  END IF;',
    'END',
    '$revert$;',
    '',
    `DROP TABLE IF EXISTS ${BAK};`,
    ''].join('\n');
  return { changeName: `merge_${slug(table)}_${col}`, deploySql, verifySql, revertSql, description: `Merges ${sides}: ${table}.${col}, ${p === 'ours' ? c.ours.project : c.theirs.project} wins.` };
}
