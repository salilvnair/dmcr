import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findDuplicateChange } from '../../src/services/changes/duplicate';

function changesDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-dup-'));
  for (const [id, sql] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'deploy.sql'), sql);
  }
  return dir;
}

test('the same deploy.sql under another name is a duplicate (comments, spacing and the id aside)', () => {
  const dir = changesDir({
    '004_a_insert_lookup_20': "INSERT INTO ${schema}.zp_lookup_data (code) VALUES ('A001') ON CONFLICT (code) DO NOTHING;",
    '005_b_insert_lookup_20': "-- B codes\nINSERT INTO dmcr.log VALUES ('005_b_insert_lookup_20');\nINSERT INTO ${schema}.zp_lookup_data (code) VALUES ('B001');",
  });
  assert.equal(findDuplicateChange(dir, "/* again */ INSERT INTO dmcr.log VALUES ('__DMCR_CHANGE_ID__');   INSERT INTO ${schema}.zp_lookup_data (code)\n VALUES ('B001');"), '005_b_insert_lookup_20');
  assert.equal(findDuplicateChange(dir, "INSERT INTO ${schema}.zp_lookup_data (code) VALUES ('B002');"), null);
  assert.equal(findDuplicateChange(dir, '-- only a comment'), null);
});

test('repeatables are not compared', () => {
  const dir = changesDir({ R__zap_view: 'CREATE OR REPLACE VIEW v AS SELECT 1;' });
  assert.equal(findDuplicateChange(dir, 'CREATE OR REPLACE VIEW v AS SELECT 1;'), null);
});
