import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePlanProblems } from '../../webview-ui/src/utils/planProblems';

test('dmcr.ps1 (a line per problem) and dmcr.sh (all on one line) read the same', () => {
  const ps = 'BLOCKED by promotion gate (test -> prod):\n  >> 003_b is not applied in test\n  >> 004_b is not applied in test\n  >> 005_b/deploy.sql differs from the one applied in test\n  >> 005_b/verify.sql differs from the one applied in test';
  const sh = 'BLOCKED by promotion gate (test -> prod): >> 003_b is not applied in test >> 004_b is not applied in test >> 005_b/deploy.sql differs from the one applied in test >> 005_b/verify.sql differs from the one applied in test';
  for (const raw of [ps, sh]) {
    const p = parsePlanProblems([raw]);
    assert.deepEqual(p.groups.map(g => g.title), ['2 changes are not applied in test', '1 change has files that differ from test']);
    assert.deepEqual(p.groups[0].items.map(i => i.id), ['003_b', '004_b']);
    assert.equal(p.groups[1].items[0].why, 'deploy.sql, verify.sql');
    assert.equal(p.reasons['003_b'], 'not applied in test');
    assert.equal(p.reasons['005_b'], 'deploy.sql differs from test; verify.sql differs from test');
    assert.equal(p.runFirstOn, 'test');
  }
});

test('50 changes are one line, every name kept', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `${String(i + 1).padStart(3, '0')}_x`);
  const p = parsePlanProblems([`BLOCKED by promotion gate (test -> prod):\n${ids.map(i => `  >> ${i} is not applied in test`).join('\n')}`]);
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].title, '50 changes are not applied in test');
  assert.equal(p.groups[0].items.length, 50);
});

test('order, requires and sign-off have their own lines; only a missing change points at another environment', () => {
  const p = parsePlanProblems([
    'BLOCKED by deploy plan:\n  >> 001_a is out of order: 002_b is already applied (out_of_order=block)\n  >> 003_c requires 009_z, which is not applied and is dropped (no longer needed)',
    'BLOCKED by approval gate (prod):\n  >> 004_d is not approved for prod (approvers: anika) — dmcr approve 004_d --env prod\n  >> 005_e changed since marco approved it (2026-11-01) — approve it again',
  ]);
  assert.deepEqual(p.groups.map(g => g.title), ['1 change is out of order', '1 change needs a change that is not in this deploy', '1 change is not signed off for prod', '1 change changed after the sign-off']);
  assert.equal(p.reasons['003_c'], 'requires 009_z, which is not applied and is dropped (no longer needed)');
  assert.equal(p.reasons['005_e'], 'changed after marco signed it off');
  assert.equal(p.runFirstOn, '');
});

test('edited applied changes are listed, not plan rows; both runners separate them their own way', () => {
  for (const list of ['001_a, 002_b', '001_a 002_b']) {
    const p = parsePlanProblems([`applied change files edited since they were deployed: ${list} (checksum_policy=block)`]);
    assert.equal(p.groups[0].title, '2 changes already applied have been edited since');
    assert.deepEqual(p.groups[0].items.map(i => i.id), ['001_a', '002_b']);
    assert.deepEqual(p.reasons, {});
  }
});

test('anything else is shown as the runner said it', () => {
  const p = parsePlanProblems(["BLOCKED by promotion gate: cannot read the DMCR registry of 'test': connection refused"]);
  assert.equal(p.groups[0].title, "cannot read the DMCR registry of 'test': connection refused");
  assert.deepEqual(p.groups[0].items, []);
});
