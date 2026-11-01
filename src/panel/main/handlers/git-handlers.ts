/**
 * git-handlers.ts — the Commits tab (and the Releases tab's Commit button).
 *
 * Everything git a DMCR user needs, as messages: what is not committed yet (grouped by change
 * folder), the commit history with the changes each commit touched, a commit's or a folder's
 * file diffs (before / after text for Monaco), Commit, Undo last commit (only when it was never
 * pushed) and Push (only when there is a remote). Runs in the repository holding the change folders.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveChangesDir } from '../../../storage/changes-dir';
import type { HandlerContext, Message } from './types';

type Run = { ok: boolean; out: string; err: string };
const MAX_TEXT = 400_000;

function runIn(cwd: string) {
  return (args: string[], timeout = 15_000) => new Promise<Run>(resolve => {
    cp.execFile('git', args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: String(stdout ?? ''), err: String(stderr || (e ? e.message : '')).trim() }));
  });
}

/** The repository holding the change folders, and the change folders' path inside it. */
async function repoInfo(): Promise<{ root: string; changesRel: string; run: ReturnType<typeof runIn> } | null> {
  let start = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let changesAbs = '';
  try { changesAbs = resolveChangesDir(); if (changesAbs && fs.existsSync(changesAbs)) start = changesAbs; } catch { /* workspace root */ }
  if (!start) return null;
  const top = await runIn(start)(['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const root = path.resolve(top.out.trim());
  const changesRel = changesAbs ? path.relative(root, changesAbs).split(path.sep).join('/') : '';
  return { root, changesRel, run: runIn(root) };
}

/** db/changes/014_x/deploy.sql → 014_x (or '' when the file is not in a change folder) */
const folderOf = (changesRel: string, file: string): string => {
  const pre = changesRel ? changesRel.replace(/\/$/, '') + '/' : '';
  if (!file.startsWith(pre)) return '';
  const rest = file.slice(pre.length);
  return rest.includes('/') ? rest.split('/')[0] : '';
};

type StatusFile = { path: string; status: string };

async function workingStatus(info: NonNullable<Awaited<ReturnType<typeof repoInfo>>>) {
  const r = await info.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files: StatusFile[] = [];
  const parts = r.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++;       // the old name follows a rename
    const status = xy === '??' ? 'A' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy[0] === 'R' ? 'R' : 'M';
    files.push({ path: p, status });
  }
  const folders: Record<string, StatusFile[]> = {};
  const other: StatusFile[] = [];
  for (const f of files) {
    const id = folderOf(info.changesRel, f.path);
    if (id) (folders[id] ??= []).push(f); else other.push(f);
  }
  return {
    changes: Object.entries(folders).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true })).map(([changeId, fs]) => ({ changeId, files: fs })),
    other,
  };
}

type Commit = {
  sha: string; short: string; author: string; email: string; date: string; subject: string; body: string;
  refs: string[]; parents: string[]; files: { path: string; status: string; adds: number; dels: number }[]; changeIds: string[];
};

async function commitLog(info: NonNullable<Awaited<ReturnType<typeof repoInfo>>>, limit: number): Promise<Commit[]> {
  const r = await info.run(['log', `-n${limit}`, '--raw', '--numstat', '--no-renames',
    '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%D%x1f%s%x1f%b%x1f']);
  if (!r.ok) return [];
  const commits: Commit[] = [];
  for (const block of r.out.split('\x1e')) {
    if (!block.trim()) continue;
    const f = block.split('\x1f');
    if (f.length < 10) continue;
    const [sha, short, author, email, date, parents, refs, subject, body, tail] = f;
    const files = new Map<string, { path: string; status: string; adds: number; dels: number }>();
    for (const line of (tail ?? '').split('\n')) {
      if (line.startsWith(':')) {                       // :100644 100644 a b M\tpath
        const [meta, p] = line.split('\t');
        if (p) files.set(p, { path: p, status: meta.trim().split(/\s+/).pop() ?? 'M', adds: 0, dels: 0 });
      } else {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (m) {
          const cur = files.get(m[3]) ?? { path: m[3], status: 'M', adds: 0, dels: 0 };
          cur.adds = m[1] === '-' ? 0 : Number(m[1]); cur.dels = m[2] === '-' ? 0 : Number(m[2]);
          files.set(m[3], cur);
        }
      }
    }
    const list = [...files.values()];
    const changeIds = [...new Set(list.map(x => folderOf(info.changesRel, x.path)).filter(Boolean))].sort();
    commits.push({
      sha, short, author, email, date, subject, body: body.trim(),
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      refs: refs.trim() ? refs.split(',').map(s => s.trim()).filter(Boolean) : [],
      files: list, changeIds,
    });
  }
  return commits;
}

/** Many `<rev>:<path>` texts with ONE git process (cat-file --batch); a missing one is '' */
function readBlobs(root: string, specs: string[]): Promise<string[]> {
  if (!specs.length) return Promise.resolve([]);
  return new Promise(resolve => {
    const proc = cp.spawn('git', ['cat-file', '--batch'], { cwd: root });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', () => resolve(specs.map(() => '')));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const out: string[] = [];
      let pos = 0;
      for (let i = 0; i < specs.length; i++) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) { out.push(''); continue; }
        const header = buf.subarray(pos, nl).toString('utf8');
        pos = nl + 1;
        const m = / (blob|tree|commit|tag) (\d+)$/.exec(header);
        if (!m) { out.push(''); continue; }             // "<spec> missing"
        const size = Number(m[2]);
        out.push(m[1] === 'blob' ? buf.subarray(pos, pos + size).toString('utf8') : '');
        pos += size + 1;                                  // content + its trailing newline
      }
      resolve(out);
    });
    proc.stdin.end(specs.map(x => x + '\n').join(''));
  });
}

const text = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n… (truncated)' : s);
const isBinary = (s: string) => s.includes('\0');

export async function handleGitMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;
  const p = (msg.payload ?? {}) as Record<string, unknown>;
  const fail = (type: string, error: string) => webview.postMessage({ type, payload: { ok: false, error, from: p.from } });

  switch (msg.type) {
    /* the whole page: branch, ahead / behind, not committed (by change), history */
    case 'gitOverview': {
      const info = await repoInfo();
      if (!info) { webview.postMessage({ type: 'gitOverview', payload: { repo: false, uncommittedOnly: !!p.uncommittedOnly } }); return true; }
      const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 2000);
      const ts = await import('../../../services/git/team-sync.js');
      const { teamRepo, getTargetBranch } = await import('../../../services/git/git-service.js');
      const repo = await teamRepo().catch(() => null);
      // Refresh asks the remote, so ↓N (what the other DBAs pushed) is real
      let fetchError = '';
      if (repo && p.fetch) { const f = await ts.fetch(repo); if (!f.ok) fetchError = ts.gitError(f, 'git fetch failed'); }
      const [merge, branchList] = repo ? await Promise.all([ts.pendingMerge(repo), ts.listBranches(repo, getTargetBranch())]) : [null, null];
      const [branchR, branchesR, upstreamR, remotesR, status] = await Promise.all([
        info.run(['symbolic-ref', '--short', 'HEAD']),
        info.run(['branch', '--format=%(refname:short)']),
        info.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
        info.run(['remote']),
        workingStatus(info),
      ]);
      const upstream = upstreamR.ok ? upstreamR.out.trim() : '';
      let ahead = 0, behind = 0;
      if (upstream) {
        const c = await info.run(['rev-list', '--left-right', '--count', '@{u}...HEAD']);
        if (c.ok) { const [b, a] = c.out.trim().split(/\s+/).map(Number); behind = b || 0; ahead = a || 0; }
      }
      const commits = p.uncommittedOnly ? [] : await commitLog(info, limit);
      // the newest commit can be undone (kept as not committed) only while no remote branch has it
      let canUndo = false;
      if (commits.length && commits[0].parents.length === 1) {
        const rc = await info.run(['branch', '-r', '--contains', 'HEAD']);
        canUndo = rc.ok && !rc.out.trim();
      }
      const total = await info.run(['rev-list', '--count', 'HEAD']);
      webview.postMessage({
        type: 'gitOverview',
        payload: {
          repo: true, uncommittedOnly: !!p.uncommittedOnly, root: info.root, changesRel: info.changesRel,
          branch: branchR.ok ? branchR.out.trim() : 'HEAD',
          branches: branchesR.out.split('\n').map(s => s.trim()).filter(Boolean),
          upstream, ahead, behind, remotes: remotesR.out.split('\n').map(s => s.trim()).filter(Boolean),
          uncommitted: status.changes, otherUncommitted: status.other,
          commits, totalCommits: total.ok ? Number(total.out.trim()) || commits.length : commits.length, canUndo,
          merge, remoteBranches: branchList?.remoteOnly ?? [], mainBranch: branchList?.main ?? '', fetchError,
        },
      });
      return true;
    }

    /* a commit's files: before / after text for the diff editor */
    case 'gitCommitDiff': {
      const info = await repoInfo();
      const sha = String(p.sha ?? '');
      if (!info || !/^[0-9a-f]{4,40}$/i.test(sha)) { fail('gitCommitDiff', 'Not a commit.'); return true; }
      const commits = await info.run(['show', '-s', '--format=%P', sha]);
      const parent = commits.out.trim().split(/\s+/)[0] || '';
      const names = await info.run(['diff-tree', '-r', '--no-commit-id', '--name-status', '--no-renames', ...(parent ? [parent, sha] : ['--root', sha])]);
      const entries = names.out.split('\n').map(l => l.split('\t')).filter(([, f]) => !!f).map(([st, f]) => ({ status: st.trim()[0], file: f }));
      // every before / after text in one git process
      const specs: string[] = [];
      for (const e of entries) { specs.push(e.status === 'A' || !parent ? '' : `${parent}:${e.file}`); specs.push(e.status === 'D' ? '' : `${sha}:${e.file}`); }
      const wanted = specs.filter(Boolean);
      const blobs = await readBlobs(info.root, wanted);
      const bySpec = new Map(wanted.map((x, i) => [x, blobs[i]]));
      const files = entries.map((e, i) => {
        const before = specs[2 * i] ? bySpec.get(specs[2 * i]) ?? '' : '';
        const after = specs[2 * i + 1] ? bySpec.get(specs[2 * i + 1]) ?? '' : '';
        const binary = isBinary(before) || isBinary(after);
        return { path: e.file, status: e.status, changeId: folderOf(info.changesRel, e.file), before: binary ? '' : text(before), after: binary ? '' : text(after), binary };
      });
      webview.postMessage({ type: 'gitCommitDiff', payload: { ok: true, sha, files } });
      return true;
    }

    /* what is not committed in one change folder (or all of them): HEAD vs the files on disk */
    case 'gitWorkingDiff': {
      const info = await repoInfo();
      if (!info) { fail('gitWorkingDiff', 'Not a git repository.'); return true; }
      const want = Array.isArray(p.changeIds) ? (p.changeIds as string[]) : p.changeId ? [String(p.changeId)] : [];
      const status = await workingStatus(info);
      const list = status.changes.filter(c => !want.length || want.includes(c.changeId)).flatMap(c => c.files.map(f => ({ ...f, changeId: c.changeId })));
      // HEAD's texts in one git process, the files on disk in parallel
      const heads = await readBlobs(info.root, list.filter(f => f.status !== 'A').map(f => `HEAD:${f.path}`));
      let h = 0;
      const befores = list.map(f => (f.status === 'A' ? '' : heads[h++] ?? ''));
      const files = await Promise.all(list.map(async (f, i) => {
        const before = befores[i];
        const after = f.status === 'D' ? '' : await fs.promises.readFile(path.join(info.root, f.path), 'utf8').catch(() => '');
        const binary = isBinary(before) || isBinary(after);
        return { path: f.path, status: f.status, changeId: f.changeId, before: binary ? '' : text(before), after: binary ? '' : text(after), binary };
      }));
      webview.postMessage({ type: 'gitWorkingDiff', payload: { ok: true, changeIds: want, files } });
      return true;
    }

    /* commit these change folders (only them, whatever else is staged) */
    case 'gitCommitChanges': {
      const info = await repoInfo();
      const ids = (Array.isArray(p.changeIds) ? (p.changeIds as string[]) : []).filter(id => /^[\w.-]+$/.test(id));
      const message = String(p.message ?? '').trim();
      if (!info) { fail('gitCommitted', 'Not a git repository.'); return true; }
      if (!ids.length) { fail('gitCommitted', 'Pick at least one change.'); return true; }
      if (!message) { fail('gitCommitted', 'Write a commit message.'); return true; }
      const paths = ids.map(id => (info.changesRel ? `${info.changesRel}/${id}` : id));
      const add = await info.run(['add', '-A', '--', ...paths]);
      if (!add.ok) { fail('gitCommitted', add.err || 'git add failed'); return true; }
      const { identityArgs } = await import('../../../services/git/git-service.js');
      const c = await info.run([...(await identityArgs(info.root)), 'commit', '-m', message, '--', ...paths], 30_000);
      if (!c.ok) { fail('gitCommitted', (c.err || c.out).split('\n')[0] || 'git commit failed'); return true; }
      const h = await info.run(['rev-parse', '--short', 'HEAD']);
      webview.postMessage({ type: 'gitCommitted', payload: { ok: true, hash: h.out.trim(), changeIds: ids, message, from: p.from } });
      webview.postMessage({ type: 'getReleaseDataRefresh' });
      return true;
    }

    /* undo the newest commit, keeping its files as not committed: never for a pushed commit */
    case 'gitUndoLastCommit': {
      const info = await repoInfo();
      if (!info) { fail('gitUndone', 'Not a git repository.'); return true; }
      const head = (await info.run(['rev-parse', 'HEAD'])).out.trim();
      if (p.sha && String(p.sha) !== head) { fail('gitUndone', 'That is no longer the newest commit; refresh.'); return true; }
      const pushed = await info.run(['branch', '-r', '--contains', 'HEAD']);
      if (pushed.out.trim()) { fail('gitUndone', 'This commit is already pushed: it can\'t be undone here.'); return true; }
      const parents = (await info.run(['show', '-s', '--format=%P', 'HEAD'])).out.trim().split(/\s+/).filter(Boolean);
      if (parents.length !== 1) { fail('gitUndone', 'The first commit and merge commits can\'t be undone here.'); return true; }
      const r = await info.run(['reset', '--soft', 'HEAD~1']);
      if (!r.ok) { fail('gitUndone', r.err); return true; }
      // back to "not committed" (unstaged), like before the commit
      await info.run(['reset', '-q']);
      webview.postMessage({ type: 'gitUndone', payload: { ok: true, sha: head.slice(0, 7) } });
      webview.postMessage({ type: 'getReleaseDataRefresh' });
      return true;
    }

    /* ── two DBAs on one repository: pull, push, branches, merges and the conflicts they stop on ── */
    case 'gitPull':
    case 'gitPush':
    case 'gitBringIn':
    case 'gitMergeInto':
    case 'gitFinishMerge': {
      const ts = await import('../../../services/git/team-sync.js');
      const { teamRepo, getTargetBranch } = await import('../../../services/git/git-service.js');
      const action = msg.type.replace(/^git/, '').toLowerCase();
      try {
        const repo = await teamRepo();
        const main = await ts.mainBranch(repo, getTargetBranch());
        const r = msg.type === 'gitPull' ? await ts.pull(repo)
          : msg.type === 'gitPush' ? await ts.push(repo)
          : msg.type === 'gitBringIn' ? await ts.bringIn(repo, main)
          : msg.type === 'gitMergeInto' ? await ts.mergeInto(repo, main)
          : await ts.finishMerge(repo);
        const verb = msg.type === 'gitPull' ? 'Pulled' : msg.type === 'gitBringIn' ? `Brought ${main} in, pushed` : msg.type === 'gitMergeInto' ? `Merged into ${main}, pushed` : msg.type === 'gitFinishMerge' ? 'Merged, pushed' : 'Pushed';
        const message = r.ok ? ts.describe(r, verb) : r.error;
        webview.postMessage({ type: 'gitSynced', payload: { ok: r.ok, action, message, conflict: r.conflict, renamed: r.renamed, branch: r.branch } });
      } catch (e) {
        webview.postMessage({ type: 'gitSynced', payload: { ok: false, action, message: e instanceof Error ? e.message : String(e) } });
      }
      webview.postMessage({ type: 'getReleaseDataRefresh' });
      return true;
    }

    case 'gitNewBranch':
    case 'gitSwitch': {
      const ts = await import('../../../services/git/team-sync.js');
      const { teamRepo } = await import('../../../services/git/git-service.js');
      const name = String(p.branch ?? '').trim();
      const repo = await teamRepo();
      const r = msg.type === 'gitNewBranch' ? await ts.newBranch(repo, name) : await ts.switchTo(repo, name);
      webview.postMessage({ type: 'gitBranchSwitched', payload: { ok: r.ok, branch: name,
        message: r.ok ? (msg.type === 'gitNewBranch' ? `On branch ${name}: local only until the first push` : `Switched to ${name}`) : r.error } });
      webview.postMessage({ type: 'getReleaseDataRefresh' });
      return true;
    }

    /* the merge waiting on its conflicts: each file's mine / theirs / common / with markers */
    case 'gitConflicts': {
      const ts = await import('../../../services/git/team-sync.js');
      const { teamRepo } = await import('../../../services/git/git-service.js');
      try {
        const d = await ts.conflictDetails(await teamRepo());
        webview.postMessage({ type: 'gitConflicts', payload: { ok: true, ...d, files: d.files.map(f => ({ ...f, mine: text(f.mine), theirs: text(f.theirs), base: text(f.base), merged: text(f.merged) })) } });
      } catch (e) { fail('gitConflicts', e instanceof Error ? e.message : String(e)); }
      return true;
    }

    case 'gitResolveFile':
    case 'gitAbortMerge': {
      const ts = await import('../../../services/git/team-sync.js');
      const { teamRepo } = await import('../../../services/git/git-service.js');
      const repo = await teamRepo();
      const how = p.how === 'theirs' ? 'theirs' : p.how === 'text' ? 'text' : 'mine';
      const r = msg.type === 'gitAbortMerge' ? await ts.abortMerge(repo) : await ts.resolveFile(repo, String(p.path ?? ''), how, String(p.text ?? ''));
      webview.postMessage({ type: msg.type === 'gitAbortMerge' ? 'gitSynced' : 'gitResolved', payload: { ok: r.ok, action: 'abort', path: p.path, how,
        message: r.ok ? (msg.type === 'gitAbortMerge' ? 'Merge cancelled: everything is as it was before it' : undefined) : r.error } });
      if (msg.type === 'gitAbortMerge') webview.postMessage({ type: 'getReleaseDataRefresh' });
      return true;
    }
  }
  return false;
}
