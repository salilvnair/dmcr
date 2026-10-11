import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseDmcrIni, buildDmcrCfg, cfgEnvList, cfgActiveEnv } from '../../src/panel/main/handlers/dmcr-cfg';

// The cfg the user had: dev (a dead database), prod with gates, test, plus settings the form does not manage
const OLD = `[dmcr]
env = test
changes_dir = db/changes
run_history_limit = 80

[envs]
names = dev, prod, test

[dev]
conn = postgresql://postgres@localhost:5432/zapper_st

[prod]
conn = postgresql://postgres@localhost:5432/shop_prod
promote_from = test
out_of_order = block

[test]
conn = postgresql://postgres@localhost:5432/shop_test

[compare]
conn =

[placeholders]
app_role = app_rw
`;
const base = { changesDir: 'db/changes', psqlPath: '', lockTimeout: '30s', statementTimeout: '5min' };

test('the env list is whatever the cfg names, in order', () => {
  const p = parseDmcrIni(OLD);
  assert.deepEqual(cfgEnvList(p).map(e => e.name), ['dev', 'prod', 'test']);
  assert.equal(cfgActiveEnv(p), 'test');
  // no [envs]: every section with a conn
  assert.deepEqual(cfgEnvList(parseDmcrIni('[qa]\nconn = x\n[compare]\nconn = y\n')).map(e => e.name), ['qa']);
  assert.equal(cfgActiveEnv(parseDmcrIni('[qa]\nconn = x\n')), 'qa');
});

test('removing dev drops its section; test and prod keep their gates; unmanaged settings stay', () => {
  const existing = parseDmcrIni(OLD);
  const out = parseDmcrIni(buildDmcrCfg({
    ...base, env: 'test', existing,
    envs: [{ name: 'test', connUrl: 'postgresql://postgres@localhost:5432/shop_test' }, { name: 'prod', connUrl: 'postgresql://postgres@localhost:5432/shop_prod' }],
    envRules: { prod: { promoteFrom: 'test', outOfOrder: 'block' } },
  }));
  assert.equal(out['envs']['names'], 'test, prod');
  assert.equal(out['dev'], undefined, '[dev] removed');
  assert.equal(out['prod']['promote_from'], 'test');
  assert.equal(out['prod']['out_of_order'], 'block');
  assert.equal(out['dmcr']['env'], 'test');
  assert.equal(out['dmcr']['run_history_limit'], '80');
  assert.equal(out['placeholders']['app_role'], 'app_rw');
});

test('any number of environments, any names; the active one falls back to the first', () => {
  const envs = Array.from({ length: 10 }, (_, i) => ({ name: `env${i + 1}`, connUrl: `postgresql://h/db${i + 1}` }));
  const out = parseDmcrIni(buildDmcrCfg({ ...base, env: 'gone', envs }));
  assert.equal(out['envs']['names'].split(', ').length, 10);
  assert.equal(out['env10']['conn'], 'postgresql://h/db10');
  assert.equal(out['dmcr']['env'], 'env1');
});

test('bad lists are refused', () => {
  assert.throws(() => buildDmcrCfg({ ...base, env: 'a', envs: [] }), /at least one/);
  assert.throws(() => buildDmcrCfg({ ...base, env: 'a', envs: [{ name: 'a', connUrl: '' }, { name: 'a', connUrl: '' }] }), /same name/);
  assert.throws(() => buildDmcrCfg({ ...base, env: 'a', envs: [{ name: 'compare', connUrl: '' }] }), /Not a valid/);
  assert.throws(() => buildDmcrCfg({ ...base, env: 'a', envs: [{ name: 'my env', connUrl: '' }] }), /Not a valid/);
});

test('the old dev / prod payload still writes dev and prod', () => {
  const out = parseDmcrIni(buildDmcrCfg({ ...base, env: 'dev', devConnUrl: 'postgresql://h/d', prodConnUrl: 'postgresql://h/p' }));
  assert.equal(out['envs']['names'], 'dev, prod');
  assert.equal(out['dev']['conn'], 'postgresql://h/d');
});
