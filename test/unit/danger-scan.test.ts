import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ruleMatches, whereLessFindings } from '../../src/forms/llm/prompts/danger-scan';

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
