import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createdInSql, touchedInSql, expectedDifferences, annotateCompare, bareName } from '../../src/services/schema/env-only';

test('bare names', () => {
  assert.equal(bareName('zp_st."Zaps"'), 'zaps');
  assert.equal(bareName('lookup_card_for(varchar)'), 'lookup_card_for');
});

test('what a deploy.sql creates and touches; DMCR backups left out', () => {
  const sql = `-- CREATE TABLE commented (id int);
CREATE TABLE IF NOT EXISTS dmcr.bak_x AS SELECT 1;
CREATE OR REPLACE FUNCTION debug_dump(p int) RETURNS int LANGUAGE sql AS $$ SELECT p $$;
CREATE TABLE test_seed (id int);
ALTER TABLE zp_lookup_data ADD COLUMN debug_flag boolean;`;
  assert.deepEqual(createdInSql(sql).sort(), ['debug_dump', 'test_seed']);
  assert.deepEqual(touchedInSql(sql).sort(), ['debug_dump', 'test_seed', 'zp_lookup_data']);
});

const changes = [
  { id: '001_a_lookup', deploySql: 'CREATE TABLE zp_lookup_data (id int);' },
  { id: '002_a_debug', environments: ['test'], deploySql: 'CREATE FUNCTION debug_dump() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; ALTER TABLE zp_lookup_data ADD COLUMN debug_flag boolean;' },
  { id: '003_a_both', environments: ['test', 'prod'], deploySql: 'CREATE TABLE both_envs (id int);' },
];

test('test vs prod: what a test-only change creates is expected, what it alters is noted', () => {
  const n = expectedDifferences(changes, 'test', 'prod');
  assert.deepEqual([...n.created.keys()], ['debug_dump']);
  assert.equal(n.created.get('debug_dump')?.change, '002_a_debug');
  assert.deepEqual([...n.altered.keys()], ['zp_lookup_data']);
});

test('nothing is expected between two environments the change goes to, or neither', () => {
  assert.equal(expectedDifferences(changes, 'test', 'test').created.size, 0);
  // staging vs prod: 002 goes to neither; 003 (test, prod) only to prod, so its table is expected there
  assert.deepEqual([...expectedDifferences(changes, 'staging', 'prod').created.keys()], ['both_envs']);
  assert.equal(expectedDifferences(changes, '', 'prod').created.size, 0);
});

test('an object a change for both sides also creates is compared as usual', () => {
  const n = expectedDifferences([...changes, { id: '004_a_shared', deploySql: 'CREATE OR REPLACE FUNCTION debug_dump() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;' }], 'test', 'prod');
  assert.equal(n.created.has('debug_dump'), false);
});

test('the compare result: expected objects move out of missing, drift gets a note, counts follow', () => {
  const data = {
    summary: { only_in_source: 2, only_in_target: 0, drifted: 1, in_sync: 3 },
    only_in_source: [{ name: 'debug_dump', type: 'function', schema: 'zp_st' }, { name: 'forgotten', type: 'table', schema: 'zp_st' }],
    only_in_target: [], drifted: [{ name: 'zp_lookup_data', type: 'table', schema: 'zp_st' }], in_sync: [],
  };
  const out = annotateCompare(data, expectedDifferences(changes, 'test', 'prod')) as Record<string, any>;
  assert.deepEqual(out.only_in_source.map((o: any) => o.name), ['forgotten']);
  assert.equal(out.expected.length, 1);
  assert.equal(out.expected[0].change, '002_a_debug');
  assert.equal(out.expected[0].only_on, 'source');
  assert.equal(out.drifted[0].env_note.change, '002_a_debug');
  assert.equal(out.summary.only_in_source, 1);
  assert.equal(out.summary.expected, 1);
  assert.deepEqual(annotateCompare(data, expectedDifferences([], 'test', 'prod')), data);
});
