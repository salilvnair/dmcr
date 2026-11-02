import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseDmcrIni, buildDmcrCfg, cfgEnvList, cfgActiveEnv, cfgProduction, defaultPromoteFrom, guessProduction } from '../../src/panel/main/handlers/dmcr-cfg';

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


const ini = (...lines: string[]) => parseDmcrIni(lines.join('\n') + '\n');

test('production: read from the names until it is chosen', () => {
  assert.equal(guessProduction(['test', 'prod']), 'prod');
  assert.equal(guessProduction(['dev', 'production']), 'production');
  assert.equal(guessProduction(['qa', 'trunk']), 'trunk');
  assert.equal(guessProduction(['dev', 'zp_prd']), 'zp_prd');
  assert.equal(guessProduction(['dev', 'main']), 'main');
  assert.equal(guessProduction(['dev', 'staging']), '');
  assert.equal(cfgProduction(ini('[envs]', 'names = test, prod', '[test]', 'conn = x', '[prod]', 'conn = y')), 'prod');
});

test('production: chosen in [envs] wins, none means no production, a stale name falls back to the guess', () => {
  const base = ['[test]', 'conn = x', '[live]', 'conn = y', '[envs]', 'names = test, live'];
  assert.equal(cfgProduction(ini(...base, 'production = test')), 'test');
  assert.equal(cfgProduction(ini(...base, 'production = none')), '');
  assert.equal(cfgProduction(ini(...base, 'production = gone')), 'live');
});

test('production is written under [envs], kept when not given, dropped when its environment goes', () => {
  const envs = [{ name: 'test', connUrl: 'a' }, { name: 'trunk', connUrl: 'b' }];
  const base = { env: 'test', changesDir: 'db/changes', psqlPath: '', lockTimeout: '30s', statementTimeout: '5min' };
  const out = buildDmcrCfg({ ...base, envs, production: 'trunk' });
  assert.equal(parseDmcrIni(out)['envs']['production'], 'trunk');
  assert.equal(parseDmcrIni(buildDmcrCfg({ ...base, envs, production: '' }))['envs']['production'], 'none');
  const kept = buildDmcrCfg({ ...base, envs, existing: parseDmcrIni(out) });
  assert.equal(parseDmcrIni(kept)['envs']['production'], 'trunk');
  const gone = buildDmcrCfg({ ...base, envs: [envs[0]], existing: parseDmcrIni(out) });
  assert.equal(parseDmcrIni(gone)['envs']?.['production'], undefined);
});

test('production starts on the environment before it', () => {
  assert.equal(defaultPromoteFrom(['dev', 'st', 'prod'], 'prod'), 'st');
  assert.equal(defaultPromoteFrom(['prod', 'test'], 'prod'), 'test');
  assert.equal(defaultPromoteFrom(['prod'], 'prod'), '');
  assert.equal(defaultPromoteFrom(['test', 'qa'], ''), '');
  const envs = [{ name: 'test', connUrl: 'a' }, { name: 'prod', connUrl: 'b' }];
  const first = parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs, production: 'prod' }));
  assert.equal(first['prod']['promote_from'], 'test');
  assert.equal(first['test']['promote_from'], undefined, 'only production gets it');
  assert.equal(parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs, production: '' }))['prod']['promote_from'], undefined, 'no production: no default');
});

test('production added after the others, or the others after it, gets the default too', () => {
  const test1 = [{ name: 'test', connUrl: 'a' }];
  const prod1 = [{ name: 'prod', connUrl: 'b' }];
  const both = [...test1, ...prod1];
  const onlyTest = parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs: test1 }));
  assert.equal(parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs: both, production: 'prod', existing: onlyTest }))['prod']['promote_from'], 'test');
  const onlyProd = parseDmcrIni(buildDmcrCfg({ ...base, env: 'prod', envs: prod1, production: 'prod' }));
  assert.equal(onlyProd['prod']['promote_from'], undefined);
  assert.equal(parseDmcrIni(buildDmcrCfg({ ...base, env: 'prod', envs: both, production: 'prod', existing: onlyProd }))['prod']['promote_from'], 'test');
});

test('a fresh install: the starter cfg has empty dev and prod, and production gets the default once the databases are filled in', () => {
  const starter = parseDmcrIni('[dmcr]\nenv = dev\n\n[dev]\nconn =\n\n[prod]\nconn =\n');
  // the wizard saves the folder before any database: nothing to name yet
  const folder = parseDmcrIni(buildDmcrCfg({ ...base, env: 'dev', existing: starter, production: 'prod', envs: [{ name: 'dev', connUrl: '' }, { name: 'prod', connUrl: '' }] }));
  assert.equal(folder['prod']['promote_from'], undefined);
  const dbs = parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', existing: folder, production: 'prod', envs: [{ name: 'test', connUrl: 'a' }, { name: 'prod', connUrl: 'b' }] }));
  assert.equal(dbs['prod']['promote_from'], 'test');
});

test('once saved, "anything" on production stays the choice, and an existing cfg is not changed', () => {
  const envs = [{ name: 'test', connUrl: 'a' }, { name: 'prod', connUrl: 'b' }];
  const first = parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs, production: 'prod' }));
  const anything = parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs, production: 'prod', existing: first, envRules: { prod: { promoteFrom: '' } } }));
  assert.equal(anything['prod']['promote_from'], undefined);
  const again = parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs, production: 'prod', existing: anything, envRules: { prod: { promoteFrom: '' } } }));
  assert.equal(again['prod']['promote_from'], undefined);
  const kept = parseDmcrIni(buildDmcrCfg({ ...base, env: 'test', envs, production: 'prod', existing: first, envRules: { prod: { promoteFrom: 'test' } } }));
  assert.equal(kept['prod']['promote_from'], 'test');
});
