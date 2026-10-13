import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { tablesInSql, relName } from '../../src/services/schema/sql-tables';

test('finds the table of every ALTER / DROP / CREATE INDEX form', () => {
  assert.deepEqual(tablesInSql('ALTER TABLE zp_st.zp_lookup_data ADD COLUMN category text;'), ['zp_st.zp_lookup_data']);
  assert.deepEqual(tablesInSql('ALTER TABLE IF EXISTS ONLY "zp_st"."zaps" DROP COLUMN x;'), ['zp_st.zaps']);
  assert.deepEqual(tablesInSql('DROP TABLE IF EXISTS zp_st.old_runs;'), ['zp_st.old_runs']);
  assert.deepEqual(tablesInSql('CREATE INDEX CONCURRENTLY IF NOT EXISTS zap_runs_started_at_idx ON zp_st.zap_runs (started_at);'), ['zp_st.zap_runs']);
  assert.deepEqual(tablesInSql('CREATE UNIQUE INDEX ON zaps (name);'), ['zaps']);
});

test('in order, without repeats, ignoring comments', () => {
  const sql = `-- ALTER TABLE zp_st.commented_out ADD x int;
ALTER TABLE zp_st.zp_lookup_data ADD COLUMN owner_team text;
UPDATE zp_st.zp_lookup_data SET owner_team = custom5;
CREATE INDEX zp_lookup_owner_idx ON zp_st.zp_lookup_data (owner_team);
/* DROP TABLE zp_st.nope; */
ALTER TABLE zp_st.zaps ADD COLUMN x int;`;
  assert.deepEqual(tablesInSql(sql), ['zp_st.zp_lookup_data', 'zp_st.zaps']);
  assert.equal(relName('zp_st.zap_runs'), 'zap_runs');
  assert.equal(relName('zaps'), 'zaps');
});
