import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { diff3Merge } from '../../src/services/conflicts/diff3';

// The three versions of public.zap_score from the rerun (2026-10-11): the merge base (009, A's v1), B's change
// (015: only succeeded runs, /200) and A's v2 (010), which re-indented and renamed the CTEs while adding weights.
const BASE = "CREATE OR REPLACE FUNCTION public.zap_score(p_zap_id bigint)\nRETURNS numeric\nLANGUAGE sql\nSTABLE\nPARALLEL SAFE\nAS $fn$\nWITH ranked_runs AS (\n    SELECT r.duration_ms,\n           row_number() OVER (ORDER BY r.started_at DESC) AS rn\n    FROM public.zap_runs r\n    WHERE r.zap_id = p_zap_id\n),\nlast_ten_runs AS (\n    SELECT duration_ms\n    FROM ranked_runs\n    WHERE rn <= 10\n)\nSELECT CASE\n           WHEN count(duration_ms) = 0 THEN 100::numeric\n           ELSE round(greatest(0, 100 - avg(duration_ms) / 100), 1)\n       END\nFROM last_ten_runs;\n$fn$;";
const OURS = "CREATE OR REPLACE FUNCTION public.zap_score(p_zap_id bigint)\nRETURNS numeric\nLANGUAGE sql\nSTABLE\nPARALLEL SAFE\nAS $fn$\nWITH ranked_runs AS (\n    SELECT r.duration_ms,\n           row_number() OVER (ORDER BY r.started_at DESC) AS rn\n    FROM public.zap_runs r\n    WHERE r.zap_id = p_zap_id AND r.status = 'succeeded'\n),\nlast_ten_runs AS (\n    SELECT duration_ms\n    FROM ranked_runs\n    WHERE rn <= 10\n)\nSELECT CASE\n           WHEN count(duration_ms) = 0 THEN 100::numeric\n           ELSE round(greatest(0, 100 - avg(duration_ms) / 200), 1)\n       END\nFROM last_ten_runs;\n$fn$;";
const THEIRS = "CREATE OR REPLACE FUNCTION public.zap_score(p_zap_id bigint)\nRETURNS numeric\nLANGUAGE sql\nSTABLE\nAS $zap_score$\n    WITH ranked AS (\n        SELECT r.duration_ms,\n               row_number() OVER (ORDER BY r.started_at DESC) AS rn\n        FROM public.zap_runs r\n        WHERE r.zap_id = p_zap_id\n    ),\n    recent AS (\n        SELECT duration_ms, 11 - rn AS weight\n        FROM ranked\n        WHERE rn <= 10\n    )\n    SELECT CASE\n               WHEN count(*) = 0 THEN 100::numeric\n               ELSE round(GREATEST(0::numeric, 100 - (sum(duration_ms * weight)::numeric / sum(weight)) / 100), 1)\n           END\n    FROM recent;\n$zap_score$;";

test('re-indented lines are not conflicts: only the line both sides changed is', () => {
  const r = diff3Merge(OURS, BASE, THEIRS);
  const conflicts = r.chunks.filter(c => c.kind === 'conflict');
  const lines = conflicts.reduce((n, c) => n + (c.kind === 'conflict' ? c.ours.length + c.theirs.length : 0), 0);
  // before: one conflict hunk of 40+ lines (the whole body); now a few small ones
  assert.ok(lines < 16, `conflicting lines: ${lines}`);
  const merged = r.chunks.flatMap(c => (c.kind === 'conflict' ? c.theirs : c.lines)).join('\n');
  assert.match(merged, /status = 'succeeded'/, "B's filter merges in on its own");
  assert.match(merged, /weight/, "A's weighting stays");
  // B's line sits among A's re-indented lines: it gets A's indentation (8 spaces), not B's (4)
  assert.ok(merged.split('\n').includes("        WHERE r.zap_id = p_zap_id AND r.status = 'succeeded'"), 'B line re-indented');
  // and so are B's side of the conflict, so Accept B lines up too
  const hunk = r.chunks.find(k => k.kind === 'conflict');
  assert.ok(hunk && hunk.kind === 'conflict' && hunk.ours.every(l => l.startsWith('               ') && !l.startsWith('                ')), 'B side re-indented to 15');
});

test('identical inputs still merge clean, and a plain conflict still conflicts', () => {
  assert.equal(diff3Merge('a\nb', 'a\nb', 'a\nb').conflicts, 0);
  const r = diff3Merge('x\nKEEP\ny1', 'x\nKEEP\ny', 'x\nKEEP\ny2');
  assert.equal(r.conflicts, 1);
  const c = r.chunks.find(k => k.kind === 'conflict');
  assert.deepEqual(c && c.kind === 'conflict' ? [c.ours, c.theirs] : [], [['y1'], ['y2']]);
});
