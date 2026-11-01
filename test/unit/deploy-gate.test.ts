import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unresolvedConflicts } from '../../src/services/conflicts/deploy-gate';

const fn = (body: string) => `CREATE OR REPLACE FUNCTION price_label(p_amount numeric)\nRETURNS text\nLANGUAGE sql IMMUTABLE\nAS $$\n    SELECT ${body};\n$$;\n`;

/** A changes folder: two DBAs added the same function (003 anika, 004 leo), plus an unrelated table (001) */
function folder(withMerge: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-gate-'));
  const write = (id: string, sql: string, meta: Record<string, unknown>) => {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'deploy.sql'), sql);
    fs.writeFileSync(path.join(dir, id, 'meta.json'), JSON.stringify({ change_id: id, project: 'B', ...meta }));
  };
  fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify({ releases: [{ id: 'r1' }], projects: [{ id: 'A', release: 'r1' }, { id: 'B', release: 'r1' }] }));
  write('001_a_create_qs_item', 'CREATE TABLE qs_item (id bigint PRIMARY KEY);\n', { project: 'A', created_by: 'anika.rao' });
  write('003_b_price_label', fn("to_char(p_amount, 'FM999990.00') || ' EUR'"), { created_by: 'anika.rao' });
  write('004_b_price_label_currency_first', fn("'EUR ' || coalesce(p_amount, 0)"), { created_by: 'leo.martin' });
  if (withMerge) {
    write('005_b_merge_price_label', fn("'EUR ' || to_char(coalesce(p_amount, 0), 'FM999990.00')"),
      { created_by: 'anika.rao', requires: ['003_b_price_label', '004_b_price_label_currency_first'], merges: [{ key: 'function:price_label(numeric)', changes: ['003_b_price_label', '004_b_price_label_currency_first'] }] });
  }
  return dir;
}

test('deploy gate: two DBAs added the same function, not merged: a deploy of either side is refused', () => {
  const dir = folder(false);
  const all = unresolvedConflicts(dir, () => true);
  assert.equal(all.length, 1);
  assert.equal(all[0].object, 'price_label(numeric)');
  assert.deepEqual([all[0].ours.change_id, all[0].ours.created_by, all[0].theirs.change_id, all[0].theirs.created_by],
    ['003_b_price_label', 'anika.rao', '004_b_price_label_currency_first', 'leo.martin']);
  assert.equal(unresolvedConflicts(dir, s => s.changeId === '004_b_price_label_currency_first').length, 1, 'only the later side pending');
  assert.equal(unresolvedConflicts(dir, s => s.changeId === '001_a_create_qs_item').length, 0, 'a deploy of other changes only');
});

test('deploy gate: a merge change resolves it', () => {
  assert.equal(unresolvedConflicts(folder(true), () => true).length, 0);
});

test('deploy gate: keep order (conflicts.json) resolves it', () => {
  const dir = folder(false);
  const [c] = unresolvedConflicts(dir, () => true);
  assert.ok(c);
  const { analyzeConflicts } = require('../../src/services/conflicts/analyze') as typeof import('../../src/services/conflicts/analyze');
  const { loadChangeInputs } = require('../../src/services/conflicts/inputs') as typeof import('../../src/services/conflicts/inputs');
  const id = analyzeConflicts(loadChangeInputs(dir), [], '').conflicts[0].id;
  fs.writeFileSync(path.join(dir, 'conflicts.json'), JSON.stringify({ resolutions: [{ id, resolution: 'keep-order' }] }));
  assert.equal(unresolvedConflicts(dir, () => true).length, 0);
});
