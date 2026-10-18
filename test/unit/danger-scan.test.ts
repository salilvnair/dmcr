import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ruleMatches, whereLessFindings } from '../../src/forms/llm/prompts/danger-scan';
import { revertDangerFindings } from '../../src/forms/llm/prompts/prompt-template';

const both = { deleteWithoutWhere: true, updateWithoutWhere: true };

test('DELETE / UPDATE without WHERE are found per statement', () => {
  assert.deepEqual(whereLessFindings('DELETE FROM shop.orders;', both), ['DELETE without WHERE']);
  assert.deepEqual(whereLessFindings('DELETE FROM a WHERE id = 1; DELETE FROM a;', both), ['DELETE without WHERE']);
  assert.deepEqual(whereLessFindings('UPDATE shop.products SET active = false;', both), ['UPDATE without WHERE']);
  assert.deepEqual(whereLessFindings('UPDATE ONLY "Shop"."Items" AS i SET x = 1', both), ['UPDATE without WHERE']);
});

test('the keywords alone are not deletes or updates', () => {
  const ddl = `CREATE TABLE shop.order_items (
    order_id bigint REFERENCES shop.orders(id) ON DELETE CASCADE ON UPDATE CASCADE);
  GRANT SELECT, INSERT, UPDATE, DELETE ON shop.order_items TO app_rw;
  REVOKE DELETE ON shop.order_items FROM app_ro;
  INSERT INTO shop.products (sku) VALUES ('A') ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name;
  CREATE TRIGGER t AFTER DELETE OR UPDATE ON shop.orders FOR EACH ROW EXECUTE FUNCTION shop.f();`;
  assert.deepEqual(whereLessFindings(ddl, both), []);
});

test('WHERE must follow the statement, comments are ignored', () => {
  assert.deepEqual(whereLessFindings('DELETE FROM a WHERE id = 1', both), []);
  assert.deepEqual(whereLessFindings('DELETE FROM a -- WHERE id = 1', both), ['DELETE without WHERE']);
  assert.deepEqual(whereLessFindings('UPDATE a SET x = 1 /* WHERE */', both), ['UPDATE without WHERE']);
  assert.deepEqual(whereLessFindings('UPDATE a SET x = 1', { deleteWithoutWhere: true, updateWithoutWhere: false }), []);
});

test('rules use their regex, not a substring of the label', () => {
  const rule = { label: 'TRUNCATE', regex: '(?i)\\bTRUNCATE\\b' };
  assert.equal(ruleMatches(rule, 'TRUNCATE shop.audit_log'), true);
  assert.equal(ruleMatches(rule, 'CREATE FUNCTION shop.truncate_name(text)'), false);
  assert.equal(ruleMatches({ label: 'DROP TABLE', regex: '(?i)\\bDROP\\s+TABLE\\b' }, 'drop   table x'), true);
});

test('a WHERE that is always true limits nothing: it counts as no WHERE', () => {
  const both = { deleteWithoutWhere: true, updateWithoutWhere: true };
  for (const sql of ['DELETE FROM t WHERE true;', 'DELETE FROM t WHERE 1=1;', "DELETE FROM t WHERE 'a' = 'a' RETURNING *;", 'DELETE FROM t WHERE (true);', 'DELETE FROM t WHERE NOT false;', 'DELETE FROM t WHERE 1;']) {
    assert.deepEqual(whereLessFindings(sql, both), ['DELETE without WHERE'], sql);
  }
  assert.deepEqual(whereLessFindings('UPDATE t SET a = 1 WHERE 2 = 2;', both), ['UPDATE without WHERE']);
  // real conditions stay allowed, including ones that start with 1 or true
  for (const sql of ['DELETE FROM t WHERE id = 1;', "DELETE FROM t WHERE code IN ('A001', 'A002');", 'UPDATE t SET a = 1 WHERE id IN (1, 2);', 'DELETE FROM t WHERE true_flag;', 'DELETE FROM t WHERE 1 = id;']) {
    assert.deepEqual(whereLessFindings(sql, both), [], sql);
  }
});

test('a revert that truncates or wipes a whole table is found; one that undoes its own rows is not', () => {
  assert.deepEqual(revertDangerFindings('TRUNCATE zp_lookup_data;'), ['TRUNCATE']);
  assert.deepEqual(revertDangerFindings('DELETE FROM zp_lookup_data;'), ['DELETE without WHERE']);
  assert.deepEqual(revertDangerFindings("UPDATE zp_lookup_data SET product = NULL WHERE 1=1;"), ['UPDATE without WHERE']);
  assert.deepEqual(revertDangerFindings("DELETE FROM zp_lookup_data WHERE code IN ('B001', 'B002');\nDROP TABLE IF EXISTS dmcr.bak_010_b_products_for_codes;"), []);
});
