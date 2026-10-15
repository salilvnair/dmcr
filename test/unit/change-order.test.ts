import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compareChangeIds, isChangeFolder, changeNum } from '../../src/storage/change-order';

test('change folders run in number order past 999 (a string sort puts 1000_ before 101_)', () => {
  const ids = ['1000_a', '101_b', '099_c', '999_d', 'R__view', '1050_e', '001_f', '100_g'];
  assert.deepEqual([...ids].sort(compareChangeIds), ['001_f', '099_c', '100_g', '101_b', '999_d', '1000_a', '1050_e', 'R__view']);
  assert.equal(changeNum('1000_a'), 1000);
  assert.equal(changeNum('R__x'), Infinity);
});

test('a change folder has 3 or more digits, then _', () => {
  for (const ok of ['001_a', '999_b', '1000_c', '12345_d']) assert.ok(isChangeFolder(ok), ok);
  for (const no of ['12_a', 'R__x', 'releases.json', 'abc_1']) assert.ok(!isChangeFolder(no), no);
});
