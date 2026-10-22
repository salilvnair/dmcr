import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  identityArgs, definedObject, replacedObjects, replacedObjectsInText, repoPreviousDefinition,
  previousDefinitionsFor, exactRevertFromPrevious, pinPreviousDefinitions, type LiveDdl,
} from '../../src/forms/llm/generation/previous-definition';
import { exactRoutineRevert } from '../../src/forms/utils/sql-utils';

const V1 = `CREATE OR REPLACE FUNCTION \${schema}.zap_score(p_zap_id bigint)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
    SELECT 1::numeric; -- v1
$$;`;
const V2 = `CREATE OR REPLACE FUNCTION \${schema}.zap_score(p_zap_id bigint)
RETURNS numeric
LANGUAGE sql
STABLE
AS $zap_score$
    SELECT 2::numeric;
$zap_score$;`;
const VIEW1 = `CREATE OR REPLACE VIEW \${schema}.zap_scores AS
SELECT z.id, \${schema}.zap_score(z.id) AS score
FROM \${schema}.zaps z;`;

/** A changes folder: 009 creates v1 + the view (with comments in front), 010 replaces the function with v2. */
function changesDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-prev-'));
  const put = (name: string, sql: string) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'deploy.sql'), sql); };
  put('009_a_add_zap_score', `-- DMCR deploy: Project A health score.\n-- Creates zap_score and zap_scores.\n\n${V1}\n\nCOMMENT ON FUNCTION \${schema}.zap_score(bigint) IS 'score';\n\n${VIEW1}\n`);
  put('010_a_zap_score_v2', `-- Project A: v2\n${V2}\n`);
  put('011_b_insert_typed_zap_runs', `INSERT INTO \${schema}.zap_runs (zap_id) VALUES (1);\n`);
  return dir;
}

test('identity argument types: names, modes, defaults, typmods and OUT arguments left out; aliases unified', () => {
  assert.deepEqual(identityArgs('p_zap_id bigint'), ['bigint']);
  assert.deepEqual(identityArgs('IN a int4, OUT b text, c numeric(10,2) DEFAULT 0, d double precision'), ['integer', 'numeric', 'double precision']);
  assert.deepEqual(identityArgs('s ${schema}.run_status, character varying'), ['${schema}.run_status', 'varchar']);
});

test('the object a CREATE / DROP names, with its signature', () => {
  const o = definedObject(`-- comment\n${V2}`)!;
  assert.equal(o.kind, 'function'); assert.equal(o.name, 'zap_score'); assert.deepEqual(o.args, ['bigint']);
  assert.equal(o.display, '${schema}.zap_score(bigint)');
  assert.equal(definedObject(VIEW1)!.display, '${schema}.zap_scores');
  assert.equal(definedObject('DROP FUNCTION IF EXISTS ${schema}.zap_score(bigint);')!.name, 'zap_score');
  assert.equal(definedObject('INSERT INTO ${schema}.zaps VALUES (1);'), null);
});

test('replaced objects in a deploy.sql and in a request with SQL inside prose', () => {
  assert.deepEqual(replacedObjects(`${V2}\nGRANT EXECUTE ON FUNCTION \${schema}.zap_score(bigint) TO app;`).map(o => o.display), ['${schema}.zap_score(bigint)']);
  assert.deepEqual(replacedObjectsInText(`Please weight recent runs:\n\nDEPLOY_SQL_START\n${V2}\nDEPLOY_SQL_END`).map(o => o.display), ['${schema}.zap_score(bigint)']);
});

test('the repository gives the newest definition word for word, without the comments in front', () => {
  const dir = changesDir();
  const hotfix = definedObject(V1)!;
  const r = repoPreviousDefinition(dir, hotfix)!;
  assert.equal(r.change, '010_a_zap_score_v2');
  assert.equal(r.sql, V2);
  const v = repoPreviousDefinition(dir, definedObject(VIEW1)!)!;
  assert.equal(v.change, '009_a_add_zap_score');
  assert.equal(v.sql, VIEW1);
  // another overload or another name is not this object
  assert.equal(repoPreviousDefinition(dir, definedObject(V1.replace('p_zap_id bigint', 'p_zap_id bigint, p_n int'))!), null);
  assert.equal(repoPreviousDefinition(dir, definedObject(V1.replace('zap_score', 'zap_rank'))!), null);
});

test('a later DROP forgets the definition', () => {
  const dir = changesDir();
  fs.mkdirSync(path.join(dir, '012_danger_drop_zap_score'));
  fs.writeFileSync(path.join(dir, '012_danger_drop_zap_score', 'deploy.sql'), 'DROP FUNCTION IF EXISTS ${schema}.zap_score(bigint);\n');
  assert.equal(repoPreviousDefinition(dir, definedObject(V1)!), null);
});

test('the live database is used when no change defines the object; its schema is written back as ${schema}', async () => {
  const live: LiveDdl = {
    label: 'shop-test',
    async ddl(schema, name) {
      return name === 'legacy_fn' ? `CREATE OR REPLACE FUNCTION ${schema}.legacy_fn(p integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT p + 1 FROM zp_st.zaps LIMIT 1 $function$\n` : '';
    },
  };
  const toPlaceholder = (s: string) => s.replace(/\bzp_st\./g, '${schema}.');
  const deploy = 'CREATE OR REPLACE FUNCTION ${schema}.legacy_fn(p integer) RETURNS integer LANGUAGE sql AS $$ SELECT p + 2 $$;';
  const prev = await previousDefinitionsFor(deploy, { changesDir: changesDir(), live, envSchema: 'zp_st', toPlaceholder });
  assert.equal(prev.length, 1);
  assert.deepEqual(prev[0].source, { kind: 'live', server: 'shop-test' });
  assert.match(prev[0].sql!, /^CREATE OR REPLACE FUNCTION \$\{schema\}\.legacy_fn\(p integer\)/);
  assert.match(prev[0].sql!, /FROM \$\{schema\}\.zaps/);
  // a new function: nowhere
  const fresh = await previousDefinitionsFor(deploy.replace(/legacy_fn/g, 'brand_new'), { changesDir: changesDir(), live, envSchema: 'zp_st', toPlaceholder });
  assert.equal(fresh[0].sql, null); assert.equal(fresh[0].source, null);
});

test('exact revert: only replacements whose previous definitions are all known, newest first', async () => {
  const dir = changesDir();
  const deploy = `-- v3 of the score and its view\n${V1.replace('v1', 'v3')}\n\n${VIEW1.replace('AS score', 'AS score2')}`;
  const prev = await previousDefinitionsFor(deploy, { changesDir: dir });
  const r = exactRevertFromPrevious(deploy, prev)!;
  assert.ok(r, 'exact revert');
  assert.ok(r.indexOf(VIEW1) < r.indexOf(V2), 'the view is put back before the function');
  assert.match(r, /from 010_a_zap_score_v2\/deploy\.sql/);
  // a change that does more: no exact revert, but the AI's revert gets the exact previous text pinned in
  const more = `${V1.replace('v1', 'v3')}\nUPDATE \${schema}.zaps SET name = name;`;
  const prev2 = await previousDefinitionsFor(more, { changesDir: dir });
  assert.equal(exactRevertFromPrevious(more, prev2), null);
  const aiRevert = `UPDATE \${schema}.zaps SET name = name;\nCREATE OR REPLACE FUNCTION \${schema}.zap_score(p_zap_id bigint) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT 9::numeric $$;`;
  const pinned = pinPreviousDefinitions(aiRevert, prev2);
  assert.ok(pinned.includes(V2.replace(/;$/, '')), 'previous definition pinned word for word');
  assert.ok(!pinned.includes('SELECT 9::numeric'));
});

test('Previous version pasted for a view also reverts word for word', () => {
  const r = exactRoutineRevert(VIEW1.replace('AS score', 'AS score2'), VIEW1);
  assert.ok(r && r.includes(VIEW1));
  assert.equal(exactRoutineRevert(VIEW1, VIEW1.replace('zap_scores', 'other_view')), null);
});

test('a pinned previous definition keeps its $$ body word for word', () => {
  const old = `CREATE OR REPLACE FUNCTION order_card_for(p_code varchar)
RETURNS order_card
LANGUAGE sql STABLE
AS $$
    SELECT code, name FROM orders WHERE code = p_code;
$$;`;
  const aiRevert = `CREATE OR REPLACE FUNCTION order_card_for(p_code varchar) RETURNS order_card LANGUAGE sql STABLE AS $$ SELECT 'x', 'y' $$;
DROP FUNCTION IF EXISTS order_card_for(varchar, varchar);`;
  const prev = [{ object: replacedObjects(old)[0], sql: old, source: { kind: 'repo', changeId: '004_a' } }] as never;
  const pinned = pinPreviousDefinitions(aiRevert, prev);
  assert.ok(pinned.includes('AS $$\n    SELECT code, name FROM orders WHERE code = p_code;\n$$'), pinned);
});

test('a previous definition made with a plain CREATE FUNCTION is restored as CREATE OR REPLACE (the object exists when a revert runs)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-prev-'));
  try {
    fs.mkdirSync(path.join(dir, '009_b_card_for_product'));
    fs.writeFileSync(path.join(dir, '009_b_card_for_product', 'deploy.sql'),
      '-- B: a product-aware variant\nCREATE FUNCTION lookup_card_for(p_code varchar, p_product varchar)\nRETURNS text LANGUAGE sql AS $$ SELECT p_code || p_product $$;\n');
    const next = 'CREATE OR REPLACE FUNCTION lookup_card_for(p_code varchar, p_product varchar)\nRETURNS text LANGUAGE sql AS $$ SELECT p_product $$;';
    const r = repoPreviousDefinition(dir, definedObject(next)!)!;
    assert.match(r.sql, /^CREATE OR REPLACE FUNCTION lookup_card_for\(p_code varchar, p_product varchar\)/);
    assert.match(r.sql, /SELECT p_code \|\| p_product/);
    // pinned into an AI revert, it replaces the function in place instead of failing with "already exists"
    const pinned = pinPreviousDefinitions(`ALTER TYPE lookup_card DROP ATTRIBUTE product;\n${next.replace('SELECT p_product', 'SELECT 1')}`, [{ object: definedObject(next)!, sql: r.sql, source: { kind: 'repo', change: r.change } }]);
    assert.match(pinned, /CREATE OR REPLACE FUNCTION lookup_card_for\(p_code varchar, p_product varchar\)\nRETURNS text LANGUAGE sql AS \$\$ SELECT p_code \|\| p_product \$\$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
