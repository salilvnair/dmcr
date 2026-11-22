import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isSingleReadOnlyStatement as ro } from '../../src/services/schema/read-only-sql';

test('plain reads run', () => {
  assert.ok(ro('SELECT count(*) FROM orders;'));
  assert.ok(ro("SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'"));
  assert.ok(ro('WITH t AS (SELECT id FROM orders) SELECT * FROM t'));
  assert.ok(ro('EXPLAIN SELECT * FROM orders'));
  assert.ok(ro("SELECT 'delete; drop table x' AS note"));
  assert.ok(ro('SELECT last_analyze FROM pg_stat_user_tables'));
  assert.ok(ro('SELECT "update" FROM t -- insert here'));
});

test('anything that can write is refused', () => {
  for (const q of [
    'DELETE FROM orders',
    'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d',
    'WITH u AS (UPDATE orders SET x = 1 RETURNING *) SELECT 1',
    'EXPLAIN ANALYZE DELETE FROM orders',
    'EXPLAIN (ANALYZE) SELECT 1',
    'SELECT * INTO copy_of_orders FROM orders',
    "SELECT nextval('orders_id_seq')",
    "SELECT set_config('search_path', 'x', false)",
    'SELECT pg_terminate_backend(123)',
    'SELECT pg_sleep(100)',
    "SELECT lo_import('/etc/passwd')",
    "SELECT dblink_exec('x', 'drop table t')",
    'SELECT * FROM orders FOR UPDATE',
    'SELECT 1; DROP TABLE orders',
    null,
    'VACUUM orders',
  ]) assert.equal(ro(q), false, String(q));
});
