import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildZeroDowntime } from '../../src/forms/zero-downtime/templates';
import { lintDeploySql } from '../../src/services/lint/lock-lint';

const warnings = (sql: string) => lintDeploySql(sql).filter(f => f.severity === 'warning').map(f => f.rule);

test('dual-write rename: expand adds, backfills and syncs; contract drops the old column', () => {
  const [e, c] = buildZeroDowntime('dual-write', { table: 'public.zaps', column: 'owner', newColumn: 'owner_email', newType: 'text' });
  assert.equal(e.phase, 'expand'); assert.equal(c.phase, 'contract');
  assert.match(e.changeName, /^rename_zaps_owner_expand$/);
  assert.match(e.deploySql, /ADD COLUMN IF NOT EXISTS owner_email text/);
  assert.ok(e.deploySql.indexOf('UPDATE public.zaps') < e.deploySql.indexOf('CREATE TRIGGER'), 'backfill before the trigger');
  assert.match(c.deploySql, /DROP COLUMN IF EXISTS owner;/);
  assert.match(c.revertSql, /ADD COLUMN IF NOT EXISTS owner text/);
  assert.deepEqual(warnings(e.deploySql), []);
});

test('dual-write type change uses the expressions both ways and the old type in the revert', () => {
  const [e, c] = buildZeroDowntime('dual-write', { table: 'zaps', column: 'score', newColumn: 'score_big', newType: 'bigint', oldType: 'integer', toNew: '{old}::bigint', toOld: '{new}::integer' });
  assert.match(e.changeName, /^retype_/);
  assert.match(e.deploySql, /NEW\.score_big := NEW\.score::bigint/);
  assert.match(e.deploySql, /NEW\.score := NEW\.score_big::integer/);
  assert.match(c.revertSql, /ADD COLUMN IF NOT EXISTS score integer/);
});

test('not-null and foreign-key are lock-safe; index runs CONCURRENTLY outside a transaction', () => {
  const [a, b] = buildZeroDowntime('not-null', { table: 'zaps', column: 'owner' });
  assert.deepEqual(warnings(a.deploySql), []);
  assert.deepEqual(warnings(b.deploySql), [], 'SET NOT NULL after VALIDATE is a notice');
  const [f1, f2] = buildZeroDowntime('foreign-key', { table: 'zap_runs', column: 'zap_id', refTable: 'zaps' });
  assert.match(f1.deploySql, /NOT VALID/); assert.match(f2.deploySql, /VALIDATE CONSTRAINT zap_runs_zap_id_fkey/);
  assert.deepEqual(warnings(f1.deploySql), []);
  const [i] = buildZeroDowntime('index', { table: 'zap_runs', columns: 'zap_id, status' });
  assert.equal(i.meta.transaction, false);
  assert.match(i.deploySql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS zap_runs_zap_id_status_idx/);
  assert.deepEqual(warnings(i.deploySql), []);
});

test('bad names and multi-statement expressions are refused', () => {
  assert.throws(() => buildZeroDowntime('dual-write', { table: 'zaps; drop table x', column: 'a', newColumn: 'b', newType: 'text' }));
  assert.throws(() => buildZeroDowntime('dual-write', { table: 'zaps', column: 'a', newColumn: 'b', newType: 'text; drop table x' }));
  assert.throws(() => buildZeroDowntime('dual-write', { table: 'zaps', column: 'a', newColumn: 'a', newType: 'text' }));
});
