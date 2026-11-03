import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { actionFiles, cleanReason, commitMessage, sinceFor, type ActionEvent } from '../../src/services/history/action-record';

const ev = (id: number, action: string, change_id: string, extra: Partial<ActionEvent> = {}): ActionEvent =>
  ({ id, event_at: '2026-11-02 05:26:59', action, change_id, status: 'success', actor: 'salil', ...extra });

test('a run is one file; anything else is a file of its own', () => {
  const files = actionFiles('prod', [
    ev(7, 'revert', '001_a', { deploy_id: 'd1973349da155f58', duration_ms: 73 }),
    ev(6, 'revert', '002_b', { deploy_id: 'd1973349da155f58', duration_ms: 130 }),
    ev(8, 'approve', '003_c', { message: 'Approved' }),
    ev(9, 'repair', '*', { message: 'Lock cleared' }),
  ]);
  assert.deepEqual(files.map(f => f.name), [
    '2026-11-02T05-26-59Z_revert_d1973349.json',
    '2026-11-02T05-26-59Z_approve_003_c-8.json',
    '2026-11-02T05-26-59Z_repair_all-9.json',
  ]);
  const run = files[0].record;
  assert.equal(run.at, '2026-11-02T05:26:59Z');
  assert.equal(run.status, 'success');
  assert.deepEqual(run.changes.map(c => c.change_id), ['002_b', '001_a'], 'in the order they ran');
  assert.equal(files[1].record.changes[0].message, 'Approved');
});

test('a run with a failure is a failure; the same events always give the same file', () => {
  const events = [ev(1, 'deploy', '001_a', { deploy_id: 'abcd1234' }), ev(2, 'deploy', '002_b', { deploy_id: 'abcd1234', status: 'failure', message: 'boom' })];
  const a = actionFiles('test', events);
  assert.equal(a[0].record.status, 'failure');
  assert.deepEqual(a, actionFiles('test', [...events].reverse()));
  assert.equal(JSON.stringify(a[0].record).includes('synced'), false, 'nothing that differs between two DBAs');
});

test('passwords never reach git and long database errors are cut', () => {
  const [f] = actionFiles('test', [ev(1, 'deploy', '001_a', { status: 'failure', message: `could not connect to postgresql://u:s3cret@h/db ${'x'.repeat(900)}` })]);
  const m = f.record.changes[0].message!;
  assert.equal(m.includes('s3cret'), false);
  assert.ok(m.length <= 503);
});

test('row values and this machine\'s folders stay out of git', () => {
  const message = (m: string) => actionFiles('test', [ev(1, 'deploy', '001_a', { status: 'failure', message: m })])[0].record.changes[0].message;
  assert.equal(message('ERROR: duplicate key value\nDETAIL: Key (email)=(a@b.c) already exists.\nCONTEXT: line 3'), 'ERROR: duplicate key value');
  assert.equal(message('failed for file: C:\\Users\\salil\\work\\changes\\002_b\\revert.sql\nERROR: boom'), 'failed for file: revert.sql\nERROR: boom');
  assert.equal(message('failed for file: /home/salil/work/002_b/deploy.sql'), 'failed for file: deploy.sql');
  assert.equal(message('function a/b not found'), 'function a/b not found', 'only a whole path');
});

test('the next read starts a day before the newest file; no files read everything', () => {
  assert.equal(sinceFor([]), '');
  assert.equal(sinceFor(['2026-11-02T05-26-59Z_revert_d1973349.json', '2026-10-01T00-00-00Z_deploy_aaaa.json', 'notes.txt']), '2026-11-01T05:26:59Z');
});

test('the commit message says what happened', () => {
  const rec = (action: string, n: number, extra = {}) => actionFiles('prod', Array.from({ length: n }, (_, i) => ev(i + 1, action, `00${i + 1}_x`, { deploy_id: 'd1973349da15' })))[0].record && { ...actionFiles('prod', Array.from({ length: n }, (_, i) => ev(i + 1, action, `00${i + 1}_x`, { deploy_id: 'd1973349da15' })))[0].record, ...extra };
  assert.equal(commitMessage('prod', [rec('revert', 2, { reason: 'price label is wrong' })]), 'chore(dmcr): revert on prod: 001_x, 002_x (d1973349): price label is wrong');
  assert.equal(commitMessage('prod', [rec('deploy', 5)]), 'chore(dmcr): deploy on prod: 001_x, 002_x, 003_x and 2 more (d1973349)');
  assert.equal(commitMessage('prod', [rec('deploy', 1, { status: 'failure' })]), 'chore(dmcr): deploy failed on prod: 001_x (d1973349)');
  assert.equal(commitMessage('prod', [rec('deploy', 1), rec('revert', 1)]), 'chore(dmcr): record 2 actions on prod');
});

test('a reason is one line', () => {
  assert.equal(cleanReason('  two\n lines  '), 'two lines');
  assert.equal(cleanReason(undefined), '');
  assert.equal(cleanReason('x'.repeat(400)).length, 300);
});
