/**
 * team-sync.ts — git for several DBAs on one change repository, with no git typed by anyone.
 *
 * Pull (rebase, or a merge when the rebase stops), push (always after a pull), branches (new, the other DBAs'
 * pushed ones, bring main in, merge into main) and the conflicts a pull or merge stops on (keep mine, take theirs,
 * or a hand-merged text, then finish). After every pull or merge two DBAs may hold the same folder number
 * (both saved 031): the change that is not shared yet moves to the next free number, and everything that names
 * it (meta.json change_id, requires, the SQL's change_log checks) follows.
 *
 * Plain Node (no VS Code): every function takes the repository root and the change folders' path inside it.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type Run = { ok: boolean; out: string; err: string };
export type Git = (args: string[], timeout?: number) => Promise<Run>;

export type Repo = {
  root: string;
  /** the change folders' path inside the repository ('db/changes'), '' when they are the root */
  changesRel: string;
  git: Git;
  /** `-c user.name=<DBA name>` when git has no user.name (see git-service identityArgs) */
  ident?: string[];
};

/** A change moved to a free number because the other side already used its number */
export type Renamed = { from: string; to: string; theirs: string; by: string };

export type Conflict = {
  /** what stopped: a pull, bringing main into a branch, or merging a branch into main */
  kind: MergeKind;
  /** the branch being merged in, and the branch it goes into */
  from: string; into: string;
  files: string[];
};

export type SyncResult = {
  ok: boolean;
  branch: string;
  upstream?: string;
  /** commits brought in */
  pulled: number;
  pushed: boolean;
  renamed: Renamed[];
  /** the pull or merge stopped on these files: resolve them, then finish */
  conflict?: Conflict;
  /** e.g. there is no remote, so the commit stays here */
  note?: string;
  error?: string;
};

type MergeKind = 'pull' | 'bring-in' | 'merge-into';
/** kept in .git while a merge waits on its conflicts: which side is the DBA's own and which is already shared */
type MergeInfo = { kind: MergeKind; from: string; into: string; mine: 'ours' | 'theirs'; back?: string };

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C' };

export function gitIn(root: string): Git {
  return (args, timeout = 60_000) => new Promise<Run>(resolve => {
    cp.execFile('git', args, { cwd: root, timeout, env: ENV, maxBuffer: 32 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: String(stdout ?? '').trim(), err: String(stderr || (e ? e.message : '')).trim() }));
  });
}

/** git's own words, without the hints: the line that says what went wrong */
export const gitError = (r: Run, fallback: string) => {
  const lines = (r.err || r.out).split('\n').map(s => s.trim()).filter(l => l && !/^hint:/.test(l));
  return lines.find(l => /^(error|fatal|CONFLICT|!)/.test(l))?.replace(/^(error|fatal): /, '') ?? lines.pop() ?? fallback;
};

const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);

export async function currentBranch(repo: Repo): Promise<string> {
  const r = await repo.git(['symbolic-ref', '--short', 'HEAD']);
  return r.ok ? r.out : '';
}

export async function remoteOf(repo: Repo): Promise<string> {
  const rs = lines((await repo.git(['remote'])).out);
  return rs.includes('origin') ? 'origin' : rs[0] ?? '';
}

/** the branch's remote branch: its upstream, or <remote>/<branch> when that exists */
export async function upstreamOf(repo: Repo, branch: string): Promise<string> {
  const u = await repo.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`]);
  if (u.ok && u.out) return u.out;
  const remote = await remoteOf(repo);
  if (remote && (await repo.git(['rev-parse', '-q', '--verify', `refs/remotes/${remote}/${branch}`])).ok) return `${remote}/${branch}`;
  return '';
}

export async function fetch(repo: Repo): Promise<Run> {
  const remote = await remoteOf(repo);
  if (!remote) return { ok: true, out: '', err: '' };
  return repo.git(['fetch', '--prune', remote], 120_000);
}

const gitDir = async (repo: Repo) => path.resolve(repo.root, (await repo.git(['rev-parse', '--git-dir'])).out || '.git');
const infoFile = async (repo: Repo) => path.join(await gitDir(repo), 'DMCR_MERGE');

export async function conflictedFiles(repo: Repo): Promise<string[]> {
  return lines((await repo.git(['diff', '--name-only', '--diff-filter=U'])).out);
}

/** a merge waiting on its conflicts (or null): what it is and which files are left */
export async function pendingMerge(repo: Repo): Promise<Conflict | null> {
  if (!(await repo.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) return null;
  const info = readInfo(await infoFile(repo)) ?? { kind: 'pull' as MergeKind, from: 'MERGE_HEAD', into: await currentBranch(repo) };
  return { kind: info.kind, from: info.from, into: info.into, files: await conflictedFiles(repo) };
}

function readInfo(file: string): MergeInfo | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as MergeInfo; } catch { return null; }
}

/** a rebase another tool left half done would block everything: back it out */
async function clearStaleRebase(repo: Repo) {
  const dir = await gitDir(repo);
  if (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply'))) await repo.git(['rebase', '--abort']);
}

/** merge `ref` into the current branch; on a conflict the merge waits (MergeInfo kept) */
async function mergeRef(repo: Repo, ref: string, info: MergeInfo, noFf = false): Promise<{ ok: boolean; conflict?: Conflict; error?: string }> {
  const m = await repo.git([...(repo.ident ?? []), 'merge', '--no-edit', '--autostash', ...(noFf ? ['--no-ff'] : []), ref], 120_000);
  if (m.ok) return { ok: true };
  const files = await conflictedFiles(repo);
  if (files.length) {
    fs.writeFileSync(await infoFile(repo), JSON.stringify(info));
    return { ok: false, conflict: { kind: info.kind, from: info.from, into: info.into, files } };
  }
  await repo.git(['merge', '--abort']);
  return { ok: false, error: gitError(m, 'git merge failed') };
}

/* ── renumbering ─────────────────────────────────────────────────────────── */

const TEXT = /\.(sql|json|ya?ml|md|txt|csv|ps1|sh)$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') walk(p, out); } else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Folders sharing a number after a pull or merge: the one `keepRef` has (already shared) keeps it, the other moves
 * to the next free number. Its id is replaced everywhere in the change folders. A committed folder's move is
 * committed; a folder not committed yet is only renamed on disk.
 */
export async function renumberDuplicates(repo: Repo, keepRef: string): Promise<Renamed[]> {
  const changesAbs = path.join(repo.root, repo.changesRel);
  if (!fs.existsSync(changesAbs)) return [];
  const pre = repo.changesRel ? repo.changesRel.replace(/\/$/, '') + '/' : '';
  const kept = new Set(lines((await repo.git(['ls-tree', '--name-only', `${keepRef}:${repo.changesRel || '.'}`])).out));
  const local = fs.readdirSync(changesAbs, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d+_/.test(e.name)).map(e => e.name);
  const byNum = new Map<number, string[]>();
  for (const f of local) { const n = Number(f.match(/^(\d+)_/)![1]); byNum.set(n, [...(byNum.get(n) ?? []), f]); }
  let max = Math.max(0, ...[...local, ...kept].map(f => Number(/^(\d+)_/.exec(f)?.[1] ?? 0)));
  const renamed: Renamed[] = [];
  for (const [, group] of [...byNum.entries()].sort(([a], [b]) => a - b)) {
    if (group.length < 2) continue;
    const theirs = group.filter(f => kept.has(f));
    if (!theirs.length) continue;                       // neither is shared yet: not ours to decide
    for (const f of group.filter(x => !kept.has(x)).sort()) {
      const width = /^(\d+)_/.exec(f)![1].length;
      const to = String(++max).padStart(width, '0') + f.slice(width);
      const by = (await repo.git(['log', '-1', '--format=%an', keepRef, '--', pre + theirs[0]])).out;
      renamed.push({ from: f, to, theirs: theirs[0], by });
    }
  }
  if (!renamed.length) return [];
  const touched = new Set<string>();
  let tracked = false;
  for (const r of renamed) {
    const was = (await repo.git(['ls-tree', '--name-only', 'HEAD', pre + r.from])).out;
    if (was) tracked = true;
    fs.renameSync(path.join(changesAbs, r.from), path.join(changesAbs, r.to));
    touched.add(pre + r.from); touched.add(pre + r.to);
  }
  for (const file of walk(changesAbs)) {
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const r of renamed) after = after.split(r.from).join(r.to);
    if (after !== before) { fs.writeFileSync(file, after); touched.add(path.relative(repo.root, file).split(path.sep).join('/')); }
  }
  if (tracked) {
    const paths = [...touched];
    await repo.git(['add', '-A', '--', ...paths]);
    const msg = renamed.map(r => `${r.from} → ${r.to}`).join(', ');
    const why = renamed.map(r => `${r.theirs.split('_')[0]} came from ${r.by || 'the other side'}`).join('; ');
    await repo.git([...(repo.ident ?? []), 'commit', '-m', `chore(dmcr): renumber ${msg}`, '-m', why, '--', ...paths]);
  }
  return renamed;
}

/* ── pull, push ──────────────────────────────────────────────────────────── */

/** bring in what the remote branch has: rebase the local commits on it, or merge when the rebase stops */
export async function pull(repo: Repo): Promise<SyncResult> {
  const branch = await currentBranch(repo);
  const res: SyncResult = { ok: false, branch, pulled: 0, pushed: false, renamed: [] };
  if (!branch) return { ...res, error: 'Not on a branch.' };
  const waiting = await pendingMerge(repo);
  if (waiting) return { ...res, conflict: waiting, error: 'A merge is waiting on its conflicts: resolve them first.' };
  await clearStaleRebase(repo);
  const f = await fetch(repo);
  if (!f.ok) return { ...res, error: `Could not reach the remote: ${gitError(f, 'git fetch failed')}` };
  const up = await upstreamOf(repo, branch);
  res.upstream = up || undefined;
  if (!up) return { ...res, ok: true, note: (await remoteOf(repo)) ? `${branch} is not on the remote yet` : 'No remote: nothing to pull' };
  res.pulled = Number((await repo.git(['rev-list', '--count', `HEAD..${up}`])).out) || 0;
  if (!res.pulled) return { ...res, ok: true };
  const rb = await repo.git([...(repo.ident ?? []), 'rebase', '--autostash', up], 120_000);
  if (!rb.ok) {
    // the rebase stopped on a file: back out and merge instead, so there is one conflict to resolve, not one per commit
    await repo.git(['rebase', '--abort']);
    const m = await mergeRef(repo, up, { kind: 'pull', from: up, into: branch, mine: 'ours' });
    if (!m.ok) return { ...res, conflict: m.conflict, error: m.error ?? `The pull stopped on ${m.conflict!.files.join(', ')}` };
  }
  res.renamed = await renumberDuplicates(repo, up);
  return { ...res, ok: true };
}

/** pull, then push the current branch (new branches go up with their upstream set) */
export async function push(repo: Repo): Promise<SyncResult> {
  for (let attempt = 0; ; attempt++) {
    const p = await pull(repo);
    if (!p.ok) return p;
    const remote = await remoteOf(repo);
    if (!remote) return { ...p, note: 'No git remote: committed here only' };
    const ahead = p.upstream ? Number((await repo.git(['rev-list', '--count', `${p.upstream}..HEAD`])).out) || 0 : 1;
    if (!ahead) return p;
    const r = await repo.git(['push', '-u', remote, `HEAD:refs/heads/${p.branch}`], 120_000);
    if (r.ok) return { ...p, upstream: `${remote}/${p.branch}`, pushed: true };
    // someone pushed in between: pull again, once
    if (attempt === 0 && /rejected|fetch first|non-fast-forward/i.test(r.err)) continue;
    return { ...p, ok: false, error: gitError(r, 'git push failed') };
  }
}

/* ── branches ─────────────────────────────────────────────────────────────── */

export type Branches = { current: string; local: string[]; remoteOnly: string[]; main: string };

/** the shared branch everyone merges into: the configured one, the remote's default, else main or master */
export async function mainBranch(repo: Repo, configured = ''): Promise<string> {
  if (configured) return configured;
  const remote = await remoteOf(repo);
  if (remote) {
    const h = await repo.git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
    if (h.ok && h.out) return h.out.slice(remote.length + 1);
  }
  const all = lines((await repo.git(['branch', '-a', '--format=%(refname:short)'])).out).map(b => b.replace(/^[^/]+\//, ''));
  return all.includes('main') ? 'main' : all.includes('master') ? 'master' : await currentBranch(repo);
}

export async function listBranches(repo: Repo, configuredMain = ''): Promise<Branches> {
  const local = lines((await repo.git(['branch', '--format=%(refname:short)'])).out);
  const remote = await remoteOf(repo);
  const remoteOnly = remote
    ? lines((await repo.git(['branch', '-r', '--format=%(refname:short)'])).out)
      .filter(b => b.startsWith(remote + '/') && b !== `${remote}/HEAD` && b !== remote).map(b => b.slice(remote.length + 1)).filter(b => !local.includes(b))
    : [];
  return { current: await currentBranch(repo), local, remoteOnly, main: await mainBranch(repo, configuredMain) };
}

/** tracked files edited and not committed would follow to the other branch, or block it */
async function dirtyTracked(repo: Repo): Promise<number> {
  return lines((await repo.git(['status', '--porcelain', '--untracked-files=no'])).out).length;
}

export async function newBranch(repo: Repo, name: string): Promise<{ ok: boolean; error?: string }> {
  const n = name.trim();
  if (!n || !(await repo.git(['check-ref-format', '--branch', n])).ok) return { ok: false, error: `'${n}' can't be a branch name.` };
  if ((await repo.git(['rev-parse', '-q', '--verify', `refs/heads/${n}`])).ok) return { ok: false, error: `${n} already exists.` };
  const r = await repo.git(['switch', '-c', n]);
  return r.ok ? { ok: true } : { ok: false, error: gitError(r, 'git switch failed') };
}

/** switch to a local branch, or check out another DBA's pushed branch */
export async function switchTo(repo: Repo, name: string): Promise<{ ok: boolean; error?: string }> {
  if (await pendingMerge(repo)) return { ok: false, error: 'A merge is waiting on its conflicts: finish or cancel it first.' };
  const n = await dirtyTracked(repo);
  if (n) return { ok: false, error: `Uncommitted edits on this branch (${n} file${n === 1 ? '' : 's'}): commit them first, then switch.` };
  const r = await repo.git(['switch', name]);   // a remote-only name becomes a local branch tracking it
  return r.ok ? { ok: true } : { ok: false, error: gitError(r, 'git switch failed') };
}

/** bring the main branch (as the remote has it) into the current branch, then push the branch */
export async function bringIn(repo: Repo, main: string): Promise<SyncResult> {
  const branch = await currentBranch(repo);
  const res: SyncResult = { ok: false, branch, pulled: 0, pushed: false, renamed: [] };
  if (!branch || branch === main) return { ...res, error: `Already on ${main}: use Pull.` };
  if (await pendingMerge(repo)) return { ...res, error: 'A merge is waiting on its conflicts: finish or cancel it first.' };
  const f = await fetch(repo);
  if (!f.ok) return { ...res, error: `Could not reach the remote: ${gitError(f, 'git fetch failed')}` };
  const ref = (await upstreamOf(repo, main)) || main;
  res.pulled = Number((await repo.git(['rev-list', '--count', `HEAD..${ref}`])).out) || 0;
  if (res.pulled) {
    const m = await mergeRef(repo, ref, { kind: 'bring-in', from: main, into: branch, mine: 'ours' });
    if (!m.ok) return { ...res, conflict: m.conflict, error: m.error ?? `Bringing ${main} in stopped on ${m.conflict!.files.join(', ')}` };
    res.renamed = await renumberDuplicates(repo, ref);
  }
  const p = await push(repo);
  return { ...p, pulled: res.pulled, renamed: [...res.renamed, ...p.renamed] };
}

/** merge the current branch into main and push main; stays on main */
export async function mergeInto(repo: Repo, main: string): Promise<SyncResult> {
  const branch = await currentBranch(repo);
  const res: SyncResult = { ok: false, branch, pulled: 0, pushed: false, renamed: [] };
  if (!branch || branch === main) return { ...res, error: `Already on ${main}.` };
  if (await pendingMerge(repo)) return { ...res, error: 'A merge is waiting on its conflicts: finish or cancel it first.' };
  const n = await dirtyTracked(repo);
  if (n) return { ...res, error: `Uncommitted edits (${n} file${n === 1 ? '' : 's'}): commit them first.` };
  // the branch as it is goes up first, so the merge is of what everyone can see
  const up = await push(repo);
  if (!up.ok) return up;
  const sw = await repo.git(['switch', main]);
  if (!sw.ok) return { ...res, error: gitError(sw, `git switch ${main} failed`) };
  const p = await pull(repo);
  if (!p.ok) return { ...p, branch: main };
  const m = await mergeRef(repo, branch, { kind: 'merge-into', from: branch, into: main, mine: 'theirs', back: branch }, true);
  if (!m.ok) return { ...res, branch: main, conflict: m.conflict, error: m.error ?? `Merging ${branch} stopped on ${m.conflict!.files.join(', ')}` };
  const renamed = await renumberDuplicates(repo, 'HEAD^1');
  const pushed = await push(repo);
  return { ...pushed, renamed: [...renamed, ...pushed.renamed] };
}

/* ── conflicts ───────────────────────────────────────────────────────────── */

export type ConflictFile = { path: string; mine: string; theirs: string; base: string; merged: string; mineBy: string; theirsBy: string; deleted?: 'mine' | 'theirs' };

/** each conflicted file: my version, theirs, the common one, and the file with git's markers */
export async function conflictDetails(repo: Repo): Promise<{ merge: Conflict | null; mineLabel: string; theirsLabel: string; files: ConflictFile[] }> {
  const merge = await pendingMerge(repo);
  if (!merge) return { merge: null, mineLabel: '', theirsLabel: '', files: [] };
  const info = readInfo(await infoFile(repo));
  const mineStage = info?.mine === 'theirs' ? 3 : 2, theirsStage = mineStage === 2 ? 3 : 2;
  const mineRef = mineStage === 2 ? 'HEAD' : 'MERGE_HEAD', theirsRef = mineStage === 2 ? 'MERGE_HEAD' : 'HEAD';
  const show = async (spec: string) => { const r = await repo.git(['show', spec]); return r.ok ? r.out + '\n' : null; };
  const files: ConflictFile[] = [];
  for (const p of merge.files) {
    const [mine, theirs, base] = await Promise.all([show(`:${mineStage}:${p}`), show(`:${theirsStage}:${p}`), show(`:1:${p}`)]);
    const merged = fs.existsSync(path.join(repo.root, p)) ? fs.readFileSync(path.join(repo.root, p), 'utf8') : '';
    const by = async (ref: string) => (await repo.git(['log', '-1', '--format=%an', ref, '--', p])).out;
    files.push({ path: p, mine: mine ?? '', theirs: theirs ?? '', base: base ?? '', merged, mineBy: await by(mineRef), theirsBy: await by(theirsRef),
      deleted: mine === null ? 'mine' : theirs === null ? 'theirs' : undefined });
  }
  const label = (k: MergeKind) => k === 'pull' ? ['yours', `${merge.from}`] : k === 'bring-in' ? [`${merge.into} (yours)`, merge.from] : [`${merge.from} (yours)`, merge.into];
  const [mineLabel, theirsLabel] = label(merge.kind);
  return { merge, mineLabel, theirsLabel, files };
}

/** settle one file: my version, theirs, or a hand-merged text */
export async function resolveFile(repo: Repo, file: string, how: 'mine' | 'theirs' | 'text', text = ''): Promise<{ ok: boolean; error?: string }> {
  const merge = await pendingMerge(repo);
  if (!merge?.files.includes(file)) return { ok: false, error: `${file} has no conflict to resolve.` };
  const info = readInfo(await infoFile(repo));
  const abs = path.join(repo.root, file);
  if (how === 'text') {
    if (/^(<{7}|>{7}|={7})( |$)/m.test(text)) return { ok: false, error: 'The text still has conflict markers (<<<<<<<, =======, >>>>>>>).' };
    fs.writeFileSync(abs, text);
    const a = await repo.git(['add', '--', file]);
    return a.ok ? { ok: true } : { ok: false, error: gitError(a, 'git add failed') };
  }
  const side = (how === 'mine') === (info?.mine !== 'theirs') ? '--ours' : '--theirs';
  const stage = side === '--ours' ? 2 : 3;
  if (!(await repo.git(['cat-file', '-e', `:${stage}:${file}`])).ok) {   // that side deleted it
    const r = await repo.git(['rm', '-q', '--', file]);
    return r.ok ? { ok: true } : { ok: false, error: gitError(r, 'git rm failed') };
  }
  const c = await repo.git(['checkout', side, '--', file]);
  if (!c.ok) return { ok: false, error: gitError(c, 'git checkout failed') };
  const a = await repo.git(['add', '--', file]);
  return a.ok ? { ok: true } : { ok: false, error: gitError(a, 'git add failed') };
}

/** every file settled: make the merge commit, renumber, push */
export async function finishMerge(repo: Repo): Promise<SyncResult> {
  const branch = await currentBranch(repo);
  const res: SyncResult = { ok: false, branch, pulled: 0, pushed: false, renamed: [] };
  const merge = await pendingMerge(repo);
  if (!merge) return { ...res, error: 'No merge is waiting.' };
  if (merge.files.length) return { ...res, conflict: merge, error: `Still to resolve: ${merge.files.join(', ')}` };
  const info = readInfo(await infoFile(repo));
  const c = await repo.git([...(repo.ident ?? []), 'commit', '--no-edit']);
  if (!c.ok) return { ...res, error: gitError(c, 'git commit failed') };
  fs.rmSync(await infoFile(repo), { force: true });
  // what was already shared keeps its numbers: the remote's side for a pull or main brought in, main's for a merge into main
  res.renamed = await renumberDuplicates(repo, info?.mine === 'theirs' ? 'HEAD^1' : 'HEAD^2');
  const p = await push(repo);
  return { ...p, renamed: [...res.renamed, ...p.renamed] };
}

/** give up on the merge: everything as it was before it (back on the branch, for a merge into main) */
export async function abortMerge(repo: Repo): Promise<{ ok: boolean; error?: string }> {
  const info = readInfo(await infoFile(repo));
  const r = await repo.git(['merge', '--abort']);
  fs.rmSync(await infoFile(repo), { force: true });
  if (!r.ok) return { ok: false, error: gitError(r, 'git merge --abort failed') };
  if (info?.back) await repo.git(['switch', info.back]);
  return { ok: true };
}

/* ── words for the DBA ───────────────────────────────────────────────────── */

export function describe(r: SyncResult, what = 'Pushed'): string {
  const parts: string[] = [];
  if (r.pulled) parts.push(`brought in ${r.pulled} commit${r.pulled === 1 ? '' : 's'}`);
  for (const x of r.renamed) parts.push(`${x.theirs.split('_')[0]} came from ${x.by || 'the other side'}; yours is now ${x.to.split('_')[0]}`);
  const head = r.pushed ? `${what} ${r.branch}` : r.note ?? (r.pulled ? `Up to date with ${r.upstream}` : 'Up to date');
  return parts.length ? `${head}; ${parts.join('; ')}` : head;
}
