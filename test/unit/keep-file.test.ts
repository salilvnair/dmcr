import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { keepFileDefinitions, isMissingBackup } from '../../src/services/import/keep-file';

const FILE = `CREATE OR REPLACE FUNCTION lookup_label_for(p_code varchar) RETURNS text LANGUAGE sql AS $$
  SELECT name || ' ' || coalesce(region, '') FROM zp_lookup_data WHERE code = p_code
$$;`;

test('a function in deploy.sql is put back exactly as the imported file has it (what test runs)', () => {
  const ai = `-- deploy.sql: lookup_label_for, pinned to the schema it is created in
CREATE OR REPLACE FUNCTION lookup_label_for(p_code varchar)
RETURNS text
LANGUAGE sql
SET search_path FROM CURRENT
AS $$
  SELECT name || ' ' || coalesce(region, '') FROM zp_lookup_data WHERE code = p_code
$$;`;
  const r = keepFileDefinitions(ai, FILE);
  assert.deepEqual(r.restored, ['lookup_label_for(varchar)']);
  assert.ok(!/search_path/.test(r.sql.replace(/^--.*$/m, '')), 'no pin added to the function');
  assert.ok(r.sql.includes(FILE.replace(/;$/, '')), 'the file text, word for word');
  assert.match(r.sql, /^-- deploy\.sql: lookup_label_for/, 'comments kept');
});

test('nothing changes when deploy.sql already has the file text, and other statements stay', () => {
  const dml = "CREATE TABLE IF NOT EXISTS dmcr.bak___DMCR_CHANGE_ID__ AS SELECT id, price FROM zp_lookup_data WHERE code = 'P001';\nUPDATE zp_lookup_data SET price = 12.99 WHERE code = 'P001';";
  assert.deepEqual(keepFileDefinitions(dml, "UPDATE zp_lookup_data SET price = 12.99 WHERE code = 'P001';"), { sql: dml, restored: [] });
  const same = `-- v2\n${FILE}`;
  assert.deepEqual(keepFileDefinitions(same, FILE), { sql: same, restored: [] });
});

test('a missing backup table on test, however verify.sql words it', () => {
  assert.ok(isMissingBackup('ERROR: verify failed: backup table dmcr.bak_029_a_set_region is missing, revert would not be able to restore'));
  assert.ok(isMissingBackup('ERROR: expected snapshot table dmcr.bak_020_c_set_region to exist after deploy'));
  assert.ok(isMissingBackup('ERROR: relation "dmcr.bak_016_c_fix_price" does not exist'));
  assert.ok(!isMissingBackup('ERROR: expected region = EU on P001, got NULL'));
  assert.ok(!isMissingBackup('ERROR: relation "zp_lookup_data" does not exist'));
});
