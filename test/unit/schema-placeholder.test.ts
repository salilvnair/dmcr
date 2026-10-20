import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { neutralizePlaceholders, resolvePlaceholders, schemaToPlaceholder, stripSchema, pinSearchPathFromCurrent } from '../../src/services/schema/placeholders';
import { lintDeploySql } from '../../src/services/lint/lock-lint';
import { whereLessFindings } from '../../src/forms/llm/prompts/danger-scan';
import { touchesOf } from '../../src/services/conflicts/sql-touches';
import { parseDmcrIni, buildDmcrCfg, cfgEnvList } from '../../src/panel/main/handlers/dmcr-cfg';
import { buildZeroDowntime } from '../../src/forms/zero-downtime/templates';

test('placeholders resolve per environment and live SQL is written back with ${schema}', () => {
  const sql = "CREATE TABLE ${schema}.zaps (id int); SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}';";
  assert.equal(resolvePlaceholders(sql, { schema: 'zp_st' }), "CREATE TABLE zp_st.zaps (id int); SELECT 1 FROM information_schema.tables WHERE table_schema = 'zp_st';");
  assert.equal(resolvePlaceholders('${other}.x', { schema: 'zp' }), '${other}.x', 'unknown placeholders stay');
  assert.equal(neutralizePlaceholders('UPDATE ${schema}.zaps SET a = 1'), 'UPDATE schema.zaps SET a = 1');
  assert.equal(schemaToPlaceholder('ALTER TABLE zp_st.zaps ADD x int REFERENCES "zp_st".zp_lookup(id); -- not my_zp_st.x', 'zp_st'),
    'ALTER TABLE ${schema}.zaps ADD x int REFERENCES ${schema}.zp_lookup(id); -- not my_zp_st.x');
  assert.equal(schemaToPlaceholder('CREATE INDEX i ON zp.zaps (a)', 'zp'), 'CREATE INDEX i ON ${schema}.zaps (a)');
});

test('each environment keeps its own schema in dmcr.cfg', () => {
  const cfg = buildDmcrCfg({ env: 'test', changesDir: 'db/changes', psqlPath: '', lockTimeout: '30s', statementTimeout: '5min',
    envs: [{ name: 'test', connUrl: 'postgresql://h/shop_test', schema: 'zp_st' }, { name: 'prod', connUrl: 'postgresql://h/shop_prod', schema: 'zp' }] });
  const p = parseDmcrIni(cfg);
  assert.equal(p['test']['schema'], 'zp_st');
  assert.equal(p['prod']['schema'], 'zp');
  assert.deepEqual(cfgEnvList(p).map(e => [e.name, e.schema]), [['test', 'zp_st'], ['prod', 'zp']]);
  assert.throws(() => buildDmcrCfg({ env: 'test', changesDir: '', psqlPath: '', lockTimeout: '', statementTimeout: '',
    envs: [{ name: 'test', connUrl: '', schema: 'zp st; drop' }] }), /schema name/);
});

test('lint, danger scan and conflict touches read ${schema}.table as a name and report it as written', () => {
  const lint = lintDeploySql('ALTER TABLE ${schema}.zaps ALTER COLUMN name TYPE text;');
  assert.ok(lint.length > 0, 'ALTER on ${schema}.zaps is linted');
  assert.ok(lint.every(f => !/dmcr_ph__/.test(JSON.stringify(f))), 'no internal names leak');
  assert.ok(lint.some(f => f.statement.includes('${schema}.zaps')));
  assert.deepEqual(whereLessFindings('UPDATE ${schema}.zaps SET status = 1', { deleteWithoutWhere: true, updateWithoutWhere: true }), ['UPDATE without WHERE']);
  const t = touchesOf("CREATE OR REPLACE FUNCTION ${schema}.zap_score(p bigint) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;");
  assert.ok(t.length > 0, 'function touch found');
  assert.match(JSON.stringify(t), /\$\{schema\}\.zap_score/);
});

test('zero-downtime templates write no schema (each environment schema is the search_path)', () => {
  for (const table of ['zaps', '${schema}.zaps']) {
    const all = JSON.stringify(buildZeroDowntime('not-null', { table, column: 'owner' }));
    assert.match(all, /ALTER TABLE zaps ADD CONSTRAINT/);
    assert.doesNotMatch(all, /\$\{schema\}|public\./);
    assert.match(all, /table_schema = current_schema\(\)/);
  }
});

test('stripSchema drops the schema DMCR no longer writes', () => {
  assert.equal(stripSchema('CREATE TABLE zp_st.zaps (id int REFERENCES "zp_st".users(id)); SELECT * FROM ${schema}.runs, dmcr.change_log', 'zp_st'),
    'CREATE TABLE zaps (id int REFERENCES users(id)); SELECT * FROM runs, dmcr.change_log');
});

test("a function read from a live database binds to the environment it runs on, not the one it came from", () => {
  const fromTest = "CREATE OR REPLACE FUNCTION zp_st.zap_score(p int)\n RETURNS int\n LANGUAGE sql\n SET search_path TO 'zp_st', 'public'\nAS $$ SELECT 1 FROM zp_st.zaps $$;";
  const out = stripSchema(fromTest, 'zp_st');
  assert.ok(out.includes('SET search_path FROM CURRENT'), out);
  assert.ok(!/zp_st/.test(out), out);
  // a search_path that does not name the environment's schema is the author's: kept
  assert.equal(pinSearchPathFromCurrent("SET search_path TO 'audit', public", 'zp_st'), "SET search_path TO 'audit', public");
  assert.equal(pinSearchPathFromCurrent("SET search_path TO 'zp_staging'", 'zp_st'), "SET search_path TO 'zp_staging'");
  assert.equal(pinSearchPathFromCurrent('SET search_path = zp_st, public', 'zp_st'), 'SET search_path FROM CURRENT');
});
