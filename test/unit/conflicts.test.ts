import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { diff3Merge, withMarkers } from '../../src/services/conflicts/diff3';
import { touchesOf, argTypes, overlapRows } from '../../src/services/conflicts/sql-touches';
import { analyzeConflicts, type ChangeInput } from '../../src/services/conflicts/analyze';
import { buildMergeChange, hasMarkers, retargetRevert, retargetVerify } from '../../src/services/conflicts/merge-change';

// ── the real 006 (A) and 007 (B) of the example ──
const A006 = `CREATE TABLE IF NOT EXISTS dmcr.bak_update_lookup_custom1_custom2 AS
SELECT code, custom1, custom2 FROM public.zp_lookup_data WHERE code BETWEEN 'L001' AND 'L010';
UPDATE public.zp_lookup_data
   SET custom1 = CASE WHEN code <= 'L005' THEN 'trigger:webhook' ELSE 'trigger:schedule' END,
       custom2 = 'team-a'
 WHERE code BETWEEN 'L001' AND 'L010';`;
const B007 = `INSERT INTO dmcr.bak_x (code, custom7, custom8) SELECT s.code, s.custom7, s.custom8 FROM public.zp_lookup_data s;
UPDATE public.zp_lookup_data AS s
SET custom7 = CASE
                WHEN s.code IN ('L001','L002','L003','L004','L005') THEN 'slack'
                WHEN s.code IN ('L006','L007','L008','L009','L010') THEN 'gmail'
              END,
    custom8 = 'team-b'
WHERE s.code IN ('L001','L002','L003','L004','L005','L006','L007','L008','L009','L010');`;
const B_CUSTOM1 = `UPDATE public.zp_lookup_data SET custom1 = 'trigger:poll' WHERE code IN ('L003','L004','L005','L006');`;

const FN = (weight: string, extra = '') => `CREATE OR REPLACE FUNCTION public.zap_score(p_zap_id bigint)
RETURNS numeric
LANGUAGE sql
STABLE
AS $zap_score$
    WITH ranked AS (
        SELECT r.duration_ms, row_number() OVER (ORDER BY r.started_at DESC) AS rn
        FROM public.zap_runs r
        WHERE r.zap_id = p_zap_id${extra}
    )
    SELECT ${weight}
    FROM ranked
    WHERE rn <= 10;
$zap_score$;`;

const ch = (id: string, project: string, release: string, deploySql: string, extra: Partial<ChangeInput> = {}): ChangeInput =>
  ({ id, project, release, releaseDate: release, dropped: false, requires: [], deploySql, ...extra });

test('diff3: changes to different lines merge cleanly, the same line conflicts', () => {
  const base = 'a\nb\nc\nd';
  const clean = diff3Merge('a\nB\nc\nd', base, 'a\nb\nc\nD');
  assert.equal(clean.conflicts, 0);
  assert.equal(clean.clean, 'a\nB\nc\nD');
  const both = diff3Merge('a\nX\nc\nd', base, 'a\nY\nc\nd');
  assert.equal(both.conflicts, 1);
  assert.equal(withMarkers(both, 'ours', 'theirs'), 'a\n<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\nc\nd');
  assert.equal(diff3Merge('a\nX\nc', 'a\nb\nc', 'a\nX\nc').clean, 'a\nX\nc'); // same change on both sides
});

test('diff3: with no base, only the lines the two sides do not share conflict', () => {
  const r = diff3Merge('a\nb\nc', null, 'a\nB\nc');
  assert.equal(r.conflicts, 1);
  assert.deepEqual(r.chunks[0], { kind: 'stable', lines: ['a'] });
});

test('touches: UPDATE rows and per-row values from CASE on the key, aliases, BETWEEN and IN; dmcr.* ignored', () => {
  const a = touchesOf(A006).filter(t => t.kind === 'update');
  assert.deepEqual(a.map(t => t.key), ['data:public.zp_lookup_data.custom1', 'data:public.zp_lookup_data.custom2']);
  const c1 = a[0] as Extract<typeof a[number], { kind: 'update' }>;
  assert.deepEqual(c1.rows, { kind: 'range', col: 'code', lo: 'L001', hi: 'L010' });
  assert.equal(c1.value('L003'), "'trigger:webhook'");
  assert.equal(c1.value('L008'), "'trigger:schedule'");
  const b = touchesOf(B007).filter(t => t.kind === 'update') as Extract<ReturnType<typeof touchesOf>[number], { kind: 'update' }>[];
  assert.equal(b[0].rows.kind, 'set');
  assert.equal(b[0].value('L002'), "'slack'");
  assert.equal(b[0].value('L009'), "'gmail'");
  assert.equal(touchesOf(B007).some(t => 'table' in t && String(t.table).startsWith('dmcr.')), false);
});

test('touches: function keys use the argument types; columns, enums, inserts', () => {
  assert.equal(argTypes('p_zap_id bigint, b text DEFAULT \'x\''), 'bigint,text');
  const t = touchesOf(`${FN('1')}
ALTER TABLE public.zap_runs ADD COLUMN IF NOT EXISTS last_step text, ALTER COLUMN status SET DEFAULT 'queued';
ALTER TYPE public.run_status ADD VALUE IF NOT EXISTS 'retrying';
INSERT INTO public.zp_lookup_data (code, name) VALUES ('B001', 'one'), ('B002', 'two');`);
  assert.deepEqual(t.map(x => x.key), ['function:public.zap_score(bigint)', 'column:public.zap_runs.last_step', 'column:public.zap_runs.status', 'type:public.run_status', 'rows:public.zp_lookup_data']);
  assert.deepEqual((t[4] as { keys: string[] }).keys, ['B001', 'B002']);
  assert.deepEqual(overlapRows({ kind: 'range', col: 'code', lo: 'L001', hi: 'L010' }, { kind: 'set', col: 'code', values: ['L009', 'L011'] }), ['L009']);
});

test('the example as it is: A and B touch the same rows but different columns, which merges by itself', () => {
  const r = analyzeConflicts([ch('006_a', 'A', '2026-08-11', A006), ch('007_b', 'B', '2026-07-10', B007)]);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.autoMerged.length, 1);
  assert.match(r.autoMerged[0].why, /different columns/);
});

test('both set custom1 on L003..L006: those rows conflict, with each side\'s value', () => {
  const r = analyzeConflicts([ch('006_a', 'A', '2026-08-11', A006), ch('014_b', 'B', '2026-07-10', B_CUSTOM1)]);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.equal(c.kind, 'data');
  assert.equal(c.ours.project, 'B'); // July deploys first
  assert.deepEqual(c.rows, [
    { key: 'L003', ours: "'trigger:poll'", theirs: "'trigger:webhook'" },
    { key: 'L004', ours: "'trigger:poll'", theirs: "'trigger:webhook'" },
    { key: 'L005', ours: "'trigger:poll'", theirs: "'trigger:webhook'" },
    { key: 'L006', ours: "'trigger:poll'", theirs: "'trigger:schedule'" },
  ]);
  const sql = buildMergeChange(c, { picks: { L003: 'ours', L004: 'ours', L005: 'theirs', L006: 'theirs' } });
  assert.match(sql.deploySql, /WHEN 'L003' THEN 'trigger:poll'/);
  assert.match(sql.deploySql, /WHEN 'L006' THEN 'trigger:schedule'/);
  assert.match(sql.revertSql, /UPDATE public\.zp_lookup_data t SET custom1 = b\.custom1 FROM dmcr\.bak___DMCR_CHANGE_ID__ b/);
});

test('function changed on different lines by A and B: clean three-way merge against the base, still needs a merge change', () => {
  const r = analyzeConflicts([
    ch('009_base', 'BASE', '2026-06-01', FN('avg(r.duration_ms)')),
    ch('010_a', 'A', '2026-08-11', FN('sum(r.duration_ms * (11 - rn)) / sum(11 - rn)')),
    ch('014_b', 'B', '2026-07-10', FN('avg(r.duration_ms)', ' AND r.status = \'succeeded\'')),
  ]);
  const c = r.conflicts.find(k => k.kind === 'definition')!;
  assert.equal(c.status, 'auto');
  assert.equal(c.label, 'both modified');
  assert.equal(c.base?.changeId, '009_base');
  assert.match(c.merge!.clean!, /AND r\.status = 'succeeded'/);
  assert.match(c.merge!.clean!, /sum\(r\.duration_ms \* \(11 - rn\)\)/);
  const sql = buildMergeChange(c, { result: c.merge!.clean! });
  assert.match(sql.deploySql, /pg_get_functiondef\(to_regprocedure\('public\.zap_score\(bigint\)'\)\)/);
  assert.match(sql.verifySql, /md5\(prosrc\)/);
});

test('function changed on the same line: a conflict hunk; a result with markers is refused', () => {
  const r = analyzeConflicts([
    ch('009_base', 'BASE', '2026-06-01', FN('avg(r.duration_ms)')),
    ch('010_a', 'A', '2026-08-11', FN('max(r.duration_ms)')),
    ch('014_b', 'B', '2026-07-10', FN('min(r.duration_ms)')),
  ]);
  const c = r.conflicts[0];
  assert.equal(c.status, 'conflict');
  assert.ok(hasMarkers(c.markers!));
  assert.throws(() => buildMergeChange(c, { result: c.markers! }), /markers/);
});

test('a change that requires the other built on it (fast-forward): no conflict; a merge change resolves one', () => {
  const base = ch('009_base', 'BASE', '2026-06-01', FN('avg(r.duration_ms)'));
  // A is numbered first but ships in August, after B's July change: concurrent, like two branches
  const a = ch('010_a', 'A', '2026-08-11', FN('max(r.duration_ms)'));
  assert.equal(analyzeConflicts([base, a, ch('014_b', 'B', '2026-07-10', FN('min(r.duration_ms)'), { requires: ['010_a'] })]).conflicts.length, 0);
  const b = ch('014_b', 'B', '2026-07-10', FN('min(r.duration_ms)'));
  const open = analyzeConflicts([base, a, b]).conflicts[0];
  assert.equal(open.theirs.project, 'A'); // the later release: the merge change goes there
  const merged = ch('015_a_merge', 'A', '2026-08-11', FN('least(min(r.duration_ms), max(r.duration_ms))'), { requires: ['014_b', '010_a'], merges: [{ key: open.key, changes: ['014_b', '010_a'] }] });
  const after = analyzeConflicts([base, a, b, merged]);
  assert.equal(after.conflicts.length, 1);
  assert.equal(after.conflicts[0].resolved?.changeId, '015_a_merge');
});

test('dropped changes and changes of the same project never conflict', () => {
  const r = analyzeConflicts([
    ch('006_a', 'A', '2026-08-11', A006),
    ch('007_a', 'A', '2026-08-11', B_CUSTOM1),
    ch('014_b', 'B', '2026-07-10', B_CUSTOM1, { dropped: true }),
  ]);
  assert.equal(r.conflicts.length, 0);
});

test('in the same release: inserts with the same key and an enum value added by both are conflicts', () => {
  const r = analyzeConflicts([
    ch('005_b', 'B', '2026-07-10', `INSERT INTO public.zp_lookup_data (code, name) VALUES ('X001', 'b');\nALTER TYPE public.run_status ADD VALUE 'retrying';`),
    ch('016_a', 'A', '2026-07-10', `INSERT INTO public.zp_lookup_data (code, name) VALUES ('X001', 'a'), ('X002', 'a');\nALTER TYPE public.run_status ADD VALUE 'retrying';`),
  ]);
  assert.deepEqual(r.conflicts.map(c => c.kind).sort(), ['rows', 'type']);
});

test('a change numbered and released before the other is its history, not a parallel branch', () => {
  const r = analyzeConflicts([
    ch('009_base', 'BASE', '2026-06-01', FN('avg(r.duration_ms)')),
    ch('010_a', 'A', '2026-07-10', FN('max(r.duration_ms)')),
  ]);
  assert.equal(r.conflicts.length, 0);
});

test('only the latest definition of a project counts; comments in front of the statement are not part of it', () => {
  const r = analyzeConflicts([
    ch('009_a', 'A', '2026-08-11', FN('avg(r.duration_ms)')),
    ch('010_a', 'A', '2026-08-11', FN('max(r.duration_ms)')),
    ch('015_b', 'B', '2026-07-10', `-- B's version\n-- second comment\n${FN('avg(r.duration_ms)', " AND r.status = 'succeeded'")}`),
  ]);
  assert.deepEqual(r.conflicts.map(c => [c.ours.changeId, c.theirs.changeId]), [['015_b', '010_a']]);
  assert.equal(r.conflicts[0].ours.text.startsWith('CREATE OR REPLACE FUNCTION'), true);
});

test('the same column added by two concurrent projects is a conflict, even with the same definition', () => {
  const add = 'ALTER TABLE orders ADD COLUMN product varchar(100);';
  const r = analyzeConflicts([ch('007_b_add_product', 'B', '2026-10-31', add), ch('007_c_add_product', 'C', '2026-10-31', add)], [], '');
  const c = r.conflicts.find(k => k.kind === 'column');
  assert.ok(c, 'flagged');
  assert.equal(c!.label, 'both added');
  assert.equal(c!.object, 'orders.product');
});

test('two DBAs in one project: their changes are compared like two branches; one DBA\'s are one branch', () => {
  const by = (author: string, requires: string[] = []) => ({ author, requires });
  const r = analyzeConflicts([
    ch('033_c_round_price', 'C', '2026-11-15', FN('round(avg(r.duration_ms), 2)'), by('anika.rao')),
    ch('034_c_coupon_price', 'C', '2026-11-15', FN('avg(r.duration_ms)', ' AND r.coupon IS NULL'), by('leo.martin')),
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([r.conflicts[0].ours.changeId, r.conflicts[0].theirs.changeId], ['033_c_round_price', '034_c_coupon_price']);
  assert.match(r.conflicts[0].summary, /anika\.rao and leo\.martin/);

  // built on it (requires): history, not a conflict
  const built = analyzeConflicts([
    ch('033_c_round_price', 'C', '2026-11-15', FN('round(avg(r.duration_ms), 2)'), by('anika.rao')),
    ch('034_c_coupon_price', 'C', '2026-11-15', FN('round(avg(r.duration_ms), 2)', ' AND r.coupon IS NULL'), by('leo.martin', ['033_c_round_price'])),
  ]);
  assert.equal(built.conflicts.length, 0);

  // one DBA: the later change replaces the earlier one
  const one = analyzeConflicts([
    ch('033_c_round_price', 'C', '2026-11-15', FN('round(avg(r.duration_ms), 2)'), by('leo.martin')),
    ch('034_c_coupon_price', 'C', '2026-11-15', FN('avg(r.duration_ms)', ' AND r.coupon IS NULL'), by('leo.martin')),
  ]);
  assert.equal(one.conflicts.length, 0);
});

test('the later side\'s revert put back the merge base: it is pointed at the earlier side\'s definition', () => {
  const r = analyzeConflicts([
    ch('009_base', 'BASE', '2026-06-01', FN('avg(r.duration_ms)')),
    ch('010_a', 'A', '2026-08-11', FN('sum(r.duration_ms * (11 - rn)) / sum(11 - rn)')),
    ch('014_b', 'B', '2026-07-10', FN('avg(r.duration_ms)', ' AND r.status = \'succeeded\'')),
  ]);
  const c = r.conflicts.find(k => k.kind === 'definition')!;
  // 014_b deploys first (July), 010_a later: 010_a's revert, written from the base, would drop B's lines
  const revert = `-- Revert: put back the previous definition\n${FN('avg(r.duration_ms)')}\n`;
  const fixed = retargetRevert(c, revert)!;
  assert.ok(fixed.includes(c.ours.text.trim()), 'the earlier side\'s definition');
  assert.match(fixed, /-- DMCR merge: 014_b deploys before this change/);
  assert.match(fixed, /^-- Revert: put back the previous definition/);
  // a revert that puts back something else is left alone
  assert.equal(retargetRevert(c, FN('max(r.duration_ms)')), null);
});

test('both added the function: the later side\'s revert drops it, so it is pointed at the earlier side\'s definition', () => {
  const by = (a: string) => ({ author: a });
  const r = analyzeConflicts([
    { ...ch('003_q_label', 'Q', '2026-11-20', FN('avg(r.duration_ms)')), ...by('anika.rao') },
    { ...ch('004_q_label_price', 'Q', '2026-11-20', FN('max(r.duration_ms)', ' AND r.status = \'succeeded\'')), ...by('leo.martin') },
  ]);
  const c = r.conflicts.find(k => k.kind === 'definition')!;
  assert.ok(c, 'a both-added conflict');
  const revert = `-- revert.sql: drop the function introduced by deploy.sql\nDROP FUNCTION IF EXISTS public.zap_score(bigint);\n`;
  const fixed = retargetRevert(c, revert)!;
  assert.ok(fixed, 'retargeted');
  assert.ok(fixed.includes(c.ours.text.trim()), 'the earlier side\'s definition');
  assert.doesNotMatch(fixed, /DROP FUNCTION/);
  assert.match(fixed, /^-- revert\.sql: drop the function/);
  // its verify said "not applied: gone"; now "not applied: gone, or the earlier side's definition"
  const verify = `DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '004_q_label_price') THEN\n    IF to_regprocedure('public.zap_score(bigint)') IS NOT NULL THEN RAISE EXCEPTION 'still exists'; END IF;\n  END IF;\nEND $$;`;
  const v = retargetVerify(c, verify)!;
  assert.ok(v, 'verify retargeted');
  assert.match(v, /NOT EXISTS \(SELECT 1 FROM pg_proc WHERE oid = to_regprocedure\('public\.zap_score\(bigint\)'\) AND btrim\(regexp_replace\(prosrc, '\\s\+', ' ', 'g'\)\) = '/);
  assert.match(v, /avg\(r\.duration_ms\)/, 'the earlier side\'s body');
  assert.equal(retargetVerify(c, 'SELECT 1;'), null, 'nothing to rewrite');
});
