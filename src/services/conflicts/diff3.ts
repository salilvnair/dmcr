/**
 * Line-level three-way merge, the way git merges a file: lines only one side changed are taken
 * automatically, lines both sides changed the same way are taken once, and lines both sides changed
 * differently become a conflict hunk (ours / base / theirs).
 */

export type MergeChunk =
  | { kind: 'stable'; lines: string[] }
  /** changed by one side only (or identically by both): merged automatically */
  | { kind: 'ours' | 'theirs' | 'both'; lines: string[]; base: string[] }
  | { kind: 'conflict'; ours: string[]; base: string[]; theirs: string[] };

export interface MergeResult {
  chunks: MergeChunk[];
  conflicts: number;
  /** merged text when there is no conflict */
  clean: string | null;
}

/** For each line of `a`, the index of the matching line in `b` along a longest common subsequence (-1 if none). */
export function lcsMatch(a: string[], b: string[]): number[] {
  const n = a.length; const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const match = new Array<number>(n).fill(-1);
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { match[i] = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return match;
}

/**
 * What two lines are compared by: indentation and runs of spaces do not count, so a side that only
 * re-indented SQL does not turn every line into a conflict (like git merge -Xignore-space-change).
 * Letter case does count: 'Slack' and 'slack' in a string literal are different data.
 */
export const lineKey = (l: string) => l.trim().replace(/\s+/g, ' ');
const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => lineKey(l) === lineKey(y[i]));

export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n').map(l => l.replace(/\s+$/, ''));
}

/**
 * Three-way merge of `ours` and `theirs` against `base`. With no base (both sides added the same
 * object), the lines the two sides share are used as the base, so only real differences conflict.
 */
export function diff3Merge(oursText: string, baseText: string | null, theirsText: string): MergeResult {
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);
  let base: string[];
  if (baseText === null) {
    const m = lcsMatch(ours, theirs);
    base = ours.filter((_, i) => m[i] >= 0);
  } else {
    base = splitLines(baseText);
  }
  const bk = base.map(lineKey);
  const mo = lcsMatch(bk, ours.map(lineKey));
  const mt = lcsMatch(bk, theirs.map(lineKey));
  // a stable line keeps the spelling of the side that re-spelled it (theirs first: it deploys last)
  const spelling = (b: string, ov: string, tv: string) => (tv !== b ? tv : ov);
  const stable = (k: number) => mo[k] >= 0 && mt[k] >= 0;
  // Lines taken from one side are re-indented to the spelling the merge keeps around them: measured on the
  // nearest line both sides share (the one before the chunk, else the one after it).
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const shift = (lines: string[], d: number) => (d === 0 ? lines
    : lines.map(l => (!l.trim() ? l : d > 0 ? ' '.repeat(d) + l : l.slice(Math.min(-d, indentOf(l))))));
  let last: { b: string; o: string; t: string } | null = null;

  const chunks: MergeChunk[] = [];
  const push = (c: MergeChunk) => {
    const last = chunks[chunks.length - 1];
    if (c.kind === 'stable' && last?.kind === 'stable') { last.lines.push(...c.lines); return; }
    if (c.kind === 'stable' && c.lines.length === 0) return;
    chunks.push(c);
  };

  let i = 0; let o = 0; let t = 0;
  while (i < base.length || o < ours.length || t < theirs.length) {
    if (i < base.length && stable(i) && mo[i] === o && mt[i] === t) {
      push({ kind: 'stable', lines: [spelling(base[i], ours[o], theirs[t])] });
      last = { b: base[i], o: ours[o], t: theirs[t] };
      i++; o++; t++;
      continue;
    }
    // next base line both sides kept, at or after i
    let k = i;
    while (k < base.length && !(stable(k) && mo[k] >= o && mt[k] >= t)) k++;
    const ok = k < base.length ? mo[k] : ours.length;
    const tk = k < base.length ? mt[k] : theirs.length;
    const b = base.slice(i, k); const ov = ours.slice(o, ok); const tv = theirs.slice(t, tk);
    const ref = last ?? (k < base.length ? { b: base[k], o: ours[ok], t: theirs[tk] } : null);
    const kept = ref ? spelling(ref.b, ref.o, ref.t) : '';
    const dOurs = ref ? indentOf(kept) - indentOf(ref.o) : 0;
    const dTheirs = ref ? indentOf(kept) - indentOf(ref.t) : 0;
    if (same(ov, b) && same(tv, b)) {
      push({ kind: 'stable', lines: b.map((l, x) => spelling(l, ov[x], tv[x])) });
      if (b.length) last = { b: b[b.length - 1], o: ov[ov.length - 1], t: tv[tv.length - 1] };
    }
    else if (same(ov, b)) push({ kind: 'theirs', lines: shift(tv, dTheirs), base: b });
    else if (same(tv, b)) push({ kind: 'ours', lines: shift(ov, dOurs), base: b });
    else if (same(ov, tv)) push({ kind: 'both', lines: shift(tv, dTheirs), base: b });
    else {
      // like git's zealous merge: lines both sides share at the start or end of the hunk are not part of the conflict
      let p = 0;
      while (p < ov.length && p < tv.length && lineKey(ov[p]) === lineKey(tv[p])) p++;
      let q = 0;
      while (q < ov.length - p && q < tv.length - p && lineKey(ov[ov.length - 1 - q]) === lineKey(tv[tv.length - 1 - q])) q++;
      if (p) push({ kind: 'both', lines: shift(tv.slice(0, p), dTheirs), base: [] });
      push({ kind: 'conflict', ours: shift(ov.slice(p, ov.length - q), dOurs), base: b, theirs: shift(tv.slice(p, tv.length - q), dTheirs) });
      if (q) push({ kind: 'both', lines: shift(tv.slice(tv.length - q), dTheirs), base: [] });
    }
    i = k; o = ok; t = tk;
  }
  const conflicts = chunks.filter(c => c.kind === 'conflict').length;
  const clean = conflicts ? null : chunks.flatMap(c => (c.kind === 'conflict' ? [] : c.lines)).join('\n');
  return { chunks, conflicts, clean };
}

/** The merge as text with git-style conflict markers (what the result editor starts from). */
export function withMarkers(r: MergeResult, oursLabel: string, theirsLabel: string): string {
  return r.chunks.flatMap(c => c.kind === 'conflict'
    ? [`<<<<<<< ${oursLabel}`, ...c.ours, '=======', ...c.theirs, `>>>>>>> ${theirsLabel}`]
    : c.lines).join('\n');
}
