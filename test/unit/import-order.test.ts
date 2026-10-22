import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { suggestOrder, analyze, routineBody, type ImportFile } from '../../src/services/import/import-order';

const f = (name: string, sql: string, gitOrder = 0): ImportFile => ({ name, path: name, sql, gitOrder });
const card = (body: string) => `CREATE OR REPLACE FUNCTION lookup_card_for(p_code varchar) RETURNS text LANGUAGE sql AS $$ ${body} $$;`;

// the user's example: 8 files, all in one commit (git cannot tell their order), names without numbers
const files = [
  f('card_v3.sql', card("SELECT name || ' ' || region || ' ' || price FROM zp_lookup_data WHERE code = p_code")),
  f('fix_price.sql', "UPDATE zp_lookup_data SET price = 12.99 WHERE code = 'P001';"),
  f('index_region.sql', 'CREATE INDEX zp_lookup_data_region_idx ON zp_lookup_data (region);'),
  f('insert_plans.sql', "INSERT INTO zp_lookup_data (code, name, kind, price) VALUES ('P001', 'Basic', 'plan', 9.99), ('P002', 'Pro', 'plan', 29.99);"),
  f('remove_old.sql', "DELETE FROM zp_lookup_data WHERE code = 'X999';"),
  f('set_region.sql', "UPDATE zp_lookup_data SET region = 'EU' WHERE code LIKE 'P%';"),
  f('add_region.sql', 'ALTER TABLE zp_lookup_data ADD COLUMN region varchar(20);'),
  f('card_v2.sql', card("SELECT name || ' ' || region FROM zp_lookup_data WHERE code = p_code")),
];
// test has v3 (the last one run)
const onTest = { lookup_card_for: `CREATE OR REPLACE FUNCTION public.lookup_card_for(p_code character varying)\n RETURNS text\n LANGUAGE sql\nAS $function$  SELECT name || ' ' || region || ' ' || price FROM zp_lookup_data WHERE code = p_code  $function$` };

test('kinds: DDL, DML, function', () => {
  assert.equal(analyze(files[6].sql).kind, 'DDL');
  assert.equal(analyze(files[1].sql).kind, 'DML');
  assert.equal(analyze(files[0].sql).kind, 'function');
});

test('the same function body compares equal whatever the dollar tag and spacing', () => {
  assert.equal(routineBody(onTest.lookup_card_for), routineBody(files[0].sql));
  assert.notEqual(routineBody(files[7].sql), routineBody(files[0].sql));
});

test("the user's 8 files: dependencies, then test decides between the two function versions", () => {
  const r = suggestOrder(files, onTest);
  const names = r.ordered.map(o => o.file.name);
  const pos = (n: string) => names.indexOf(n);
  assert.ok(pos('add_region.sql') < pos('set_region.sql'), 'the column is added before it is set');
  assert.ok(pos('add_region.sql') < pos('index_region.sql'), 'and before it is indexed');
  assert.ok(pos('insert_plans.sql') < pos('fix_price.sql'), 'P001 is inserted before its price is fixed');
  assert.ok(pos('card_v2.sql') < pos('card_v3.sql'), 'v2 before v3');
  assert.ok(pos('add_region.sql') < pos('card_v2.sql'), 'the function uses region');
  assert.ok(pos('add_region.sql') < pos('card_v3.sql'), 'v3 uses region too');
  const why = (n: string) => r.ordered.find(o => o.file.name === n)!.reasons.join(' | ');
  assert.match(why('set_region.sql'), /uses column zp_lookup_data\.region \(added by add_region\.sql\)/);
  assert.match(why('fix_price.sql'), /changes P001 \(inserted by insert_plans\.sql\)/);
  assert.match(why('card_v3.sql'), /matches lookup_card_for on test now, so it ran last/);
  assert.match(why('card_v2.sql'), /an older version of lookup_card_for: test has card_v3\.sql/);
  assert.match(why('remove_old.sql'), /needs no other file: name order \(git cannot tell\)/);
  assert.equal(r.unsure, true, 'remove_old has nothing to go by: the order shown is a suggestion');
});

test('git order decides between files that do not touch each other', () => {
  const r = suggestOrder([f('b.sql', "DELETE FROM t WHERE id = 1;", 2), f('a.sql', "DELETE FROM u WHERE id = 1;", 1)]);
  assert.deepEqual(r.ordered.map(o => o.file.name), ['a.sql', 'b.sql']);
  assert.match(r.ordered[0].reasons[0], /git order/);
  assert.equal(r.unsure, false);
});

test('two versions of a function and test has neither: git order, with a note', () => {
  const r = suggestOrder([f('v_b.sql', card('SELECT 2'), 2), f('v_a.sql', card('SELECT 1'), 1)], { lookup_card_for: card('SELECT 9') });
  assert.deepEqual(r.ordered.map(o => o.file.name), ['v_a.sql', 'v_b.sql']);
  assert.match(r.notes.join(' '), /none matches test/);
});
