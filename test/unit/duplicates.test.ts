import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { additions, findDuplicates } from '../../src/services/conflicts/duplicates';

test('additions: columns (also in a DO block and a clause list), tables, types, sequences; without a schema', () => {
  const a = additions(`CREATE TABLE IF NOT EXISTS app.orders (id bigint);
CREATE SEQUENCE order_no_seq START WITH 1000;
CREATE TYPE order_card AS (code varchar(50));
ALTER TABLE \${schema}.orders ADD COLUMN product varchar(100), ADD note text, ADD CONSTRAINT x CHECK (true);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1) THEN ALTER TABLE customers ADD COLUMN IF NOT EXISTS tier varchar(20); END IF;
END $$;`);
  assert.deepEqual([...a].sort(), ['column customers.tier', 'column orders.note', 'column orders.product', 'sequence order_no_seq', 'table orders', 'type order_card']);
});

test('a rebuild (dropped first in the same file) is not an addition', () => {
  assert.deepEqual([...additions('DROP TYPE IF EXISTS order_card; CREATE TYPE order_card AS (code text);')], []);
});

test('findDuplicates names the saved change that already adds it', () => {
  const d = findDuplicates('ALTER TABLE orders ADD COLUMN product varchar(100);', [
    { id: '006_a_insert', project: 'A', deploySql: "INSERT INTO orders (code) VALUES ('x');" },
    { id: '007_b_add_product', project: 'B', deploySql: 'ALTER TABLE orders ADD COLUMN product varchar(100);' },
  ]);
  assert.deepEqual(d, [{ changeId: '007_b_add_product', project: 'B', object: 'column orders.product' }]);
});
