import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { objectsTouched, readChanges, formatDmcrState } from '../../src/services/assistant/dmcr-state';

test('objectsTouched names what a deploy.sql creates, alters and writes', () => {
  const sql = `-- create the table
CREATE TABLE IF NOT EXISTS zp_lookup_data (id bigint PRIMARY KEY, code varchar(50));
CREATE UNIQUE INDEX IF NOT EXISTS zp_lookup_data_code_uk ON zp_lookup_data (code);
CREATE OR REPLACE FUNCTION lookup_card_for(p_code varchar) RETURNS lookup_card AS $$ SELECT 1 $$ LANGUAGE sql;
ALTER TABLE zp_lookup_data ADD COLUMN IF NOT EXISTS active char(1) DEFAULT 'Y';
INSERT INTO zp_lookup_data (code) VALUES ('A001');
UPDATE zp_lookup_data SET active = 'Y';
REFRESH MATERIALIZED VIEW lookup_kind_counts;
CREATE MATERIALIZED VIEW IF NOT EXISTS zp.lookup_kind_counts AS SELECT 1;`;
  assert.deepEqual(objectsTouched(sql).sort(), [
    'alters table zp_lookup_data',
    'creates function lookup_card_for',
    'creates index zp_lookup_data_code_uk',
    'creates materialized view lookup_kind_counts',
    'creates table zp_lookup_data',
    'inserts into zp_lookup_data',
    'refreshes materialized view lookup_kind_counts',
    'updates zp_lookup_data',
  ]);
});

test('the state says where each change is applied, and that prod has nothing yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-state-'));
  const mk = (id: string, sql: string, meta: object) => {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'deploy.sql'), sql);
    fs.writeFileSync(path.join(dir, id, 'meta.json'), JSON.stringify(meta));
  };
  mk('002_a_create_zp_lookup_data', 'CREATE TABLE IF NOT EXISTS zp_lookup_data (id bigint);', { project: 'A' });
  mk('007_a_add_active_to_zp_lookup_data', "ALTER TABLE zp_lookup_data ADD COLUMN active char(1) DEFAULT 'Y';", { project: 'A', requires: ['002_a_create_zp_lookup_data'] });
  fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify({
    releases: [{ id: '2026-10-25', name: 'Product A', status: 'planned' }],
    projects: [{ id: 'A', name: 'Product A', release: '2026-10-25' }],
  }));
  const { changes, releases } = readChanges(dir);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].release, '2026-10-25');   // from the project in releases.json
  const text = formatDmcrState(changes, releases, [
    { env: 'test', schema: 'zp_st', active: true, applied: new Map([['002_a_create_zp_lookup_data', '2026-10-18'], ['007_a_add_active_to_zp_lookup_data', '2026-10-18']]) },
    { env: 'prod', schema: 'zp', active: false, applied: new Map() },
  ]);
  assert.match(text, /test \(active\) · schema zp_st: 2 of 2 changes applied/);
  assert.match(text, /prod · schema zp: 0 of 2 changes applied \(nothing deployed yet\)/);
  assert.match(text, /002_a_create_zp_lookup_data · project A · release 2026-10-25 · creates table zp_lookup_data · test: applied 2026-10-18 · prod: not applied/);
  assert.match(text, /007_a_add_active_to_zp_lookup_data · .*alters table zp_lookup_data · requires 002_a_create_zp_lookup_data/);
});

test('an environment without the dmcr registry says so instead of a change list', () => {
  const text = formatDmcrState([], [], [{ env: 'prod', active: false, problem: 'DMCR is not set up here yet (no dmcr registry)' }]);
  assert.match(text, /prod: DMCR is not set up here yet/);
  assert.match(text, /Changes: none yet/);
});
