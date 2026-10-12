import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { neutralizePlaceholders, resolvePlaceholders, schemaToPlaceholder } from '../../src/services/schema/placeholders';
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

test('zero-downtime templates take ${schema}.table', () => {
  const r = buildZeroDowntime('not-null', { table: '${schema}.zaps', column: 'owner' });
  const all = JSON.stringify(r);
  assert.match(all, /\$\{schema\}\.zaps/);
  assert.match(all, /table_schema = '\$\{schema\}'/);
});
