/**
 * Git Service — pull, commit, push for DMCR change folders.
 *
 * Uses the `git` CLI via child_process. Requires `git` on PATH.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { findById } from '../../storage/db';

/* ── types ─────────────────────────────────────────────────────────────── */

export interface GitSyncResult {
  ok: boolean;
  pulled: boolean;
  committed: boolean;
  pushed: boolean;
  commitHash?: string;
  commitMessage?: string;
  error?: string;
  /** e.g. the repository has no remote, so the commit stayed local */
  note?: string;
  /** what happened, in words: pushed, brought in N commits, 031 came from anika.rao; yours is now 032 */
  message?: string;
  /** changes moved to a free number because the other DBA already used theirs */
  renamed?: { from: string; to: string; theirs: string; by: string }[];
  /** the pull before the push stopped on these files: resolved in the Commits tab */
  conflictFiles?: string[];
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function getCwd(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) { throw new Error('No workspace folder open'); }
  return ws.uri.fsPath;
}

/** Run a git command and return stdout. Rejects on non-zero exit. */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr?.trim() || err.message)); return; }
      resolve(stdout.trim());
    });
  });
}

/** `-c user.name=<DBA name>` when git has no user.name, so a commit never fails for want of an author. */
export async function identityArgs(cwd: string): Promise<string[]> {
  try { if (await git(['config', 'user.name'], cwd)) { return []; } } catch { /* not set */ }
  const { getDbaName } = await import('../../panel/main/handlers/release-handlers.js');
  const dba = await getDbaName();
  return dba ? ['-c', `user.name=${dba}`] : [];
}

/** True when the repository has the named remote. */
async function hasRemote(remote: string, cwd: string): Promise<boolean> {
  try { return (await git(['remote'], cwd)).split(/\s+/).includes(remote); } catch { return false; }
}

/** The repository holding the change folders, for team-sync (pull, push, branches, conflicts) */
export async function teamRepo(): Promise<import('./team-sync').Repo> {
  const { gitIn } = await import('./team-sync.js');
  let start = getCwd();
  let changesAbs = '';
  try {
    const { resolveChangesDir } = await import('../../storage/changes-dir.js');
    changesAbs = resolveChangesDir();
    if (changesAbs && fs.existsSync(changesAbs)) start = changesAbs;
  } catch { /* the workspace root */ }
  const root = path.resolve(await git(['rev-parse', '--show-toplevel'], start));
  const changesRel = changesAbs ? path.relative(root, changesAbs).split(path.sep).join('/') : '';
  return { root, changesRel: changesRel.startsWith('..') ? '' : changesRel, git: gitIn(root), ident: await identityArgs(root) };
}

/** pull (renumbering a clash), then push: the outcome as a GitSyncResult on top of `base` */
async function pullThenPush(base: GitSyncResult): Promise<GitSyncResult> {
  const ts = await import('./team-sync.js');
  const r = await ts.push(await teamRepo());
  const out: GitSyncResult = { ...base, pulled: r.pulled > 0, pushed: r.pushed, renamed: r.renamed, note: r.note };
  if (r.conflict) {
    out.conflictFiles = r.conflict.files;
    out.error = `${base.committed ? `Committed ${base.commitHash}, not pushed: ` : ''}the pull stopped on ${r.conflict.files.join(', ')} (both DBAs changed it). Resolve it in Commits.`;
    out.ok = false;
    return out;
  }
  if (!r.ok) { out.ok = false; out.error = `${base.committed ? `Committed ${base.commitHash}, not pushed: ` : ''}${r.error}`; return out; }
  out.ok = true;
  const pulled = r.pulled ? `; brought in ${r.pulled} commit${r.pulled === 1 ? '' : 's'}${r.authors?.length ? ` from ${r.authors.join(', ')}` : ''}` : '';
  out.message = (base.committed ? `Committed ${base.commitHash}` : 'Nothing new to commit') + (r.pushed ? ' and pushed' : r.note ? ` (${r.note})` : '')
    + pulled + r.renamed.map(x => `; ${x.theirs.split('_')[0]} came from ${x.by || 'the other DBA'}, yours is now ${x.to.split('_')[0]}`).join('');
  return out;
}

/* ── public API ────────────────────────────────────────────────────────── */

/** Check whether git is available on PATH. */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await git(['--version'], getCwd());
    return true;
  } catch {
    return false;
  }
}

/** Check whether the workspace is inside a git repo. */
export async function isGitRepo(): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], getCwd());
    return true;
  } catch {
    return false;
  }
}

/** Get the configured remote URL (or empty string). */
export async function getRemoteUrl(remote = 'origin'): Promise<string> {
  try {
    return await git(['remote', 'get-url', remote], getCwd());
  } catch {
    return '';
  }
}

/** Set or update the remote URL. Creates 'origin' if it doesn't exist. */
export async function setRemoteUrl(url: string, remote = 'origin'): Promise<void> {
  const cwd = getCwd();
  try {
    await git(['remote', 'set-url', remote, url], cwd);
  } catch {
    await git(['remote', 'add', remote, url], cwd);
  }
}

/** Get list of untracked/modified files under changesDir. */
export async function getUnstagedChanges(changesDir: string): Promise<string[]> {
  const cwd = getCwd();
  try {
    const out = await git(['status', '--porcelain', '--', changesDir], cwd);
    if (!out) { return []; }
    return out.split('\n').filter(Boolean).map(l => l.slice(3));
  } catch {
    return [];
  }
}

/** Pull (rebase, or a merge when that stops), renumbering a change whose number the other DBA already used. */
export async function pull(): Promise<boolean> {
  const ts = await import('./team-sync.js');
  return (await ts.pull(await teamRepo())).ok;
}

/** Stage, commit, and optionally push a specific folder. */
export async function commitAndPush(
  folderRel: string,
  commitMessage: string,
  push = true,
  remote = 'origin',
): Promise<GitSyncResult> {
  const cwd = getCwd();
  const result: GitSyncResult = { ok: false, pulled: false, committed: false, pushed: false };

  try {
    // Stage the folder
    await git(['add', '--', folderRel], cwd);

    // Check if there's anything staged
    try {
      await git(['diff', '--cached', '--quiet', '--', folderRel], cwd);
      // If diff --cached --quiet succeeds, there's nothing staged → already committed
      result.ok = true;
      result.committed = false;
      return result;
    } catch {
      // Good — there ARE staged changes to commit
    }

    // Commit
    await git([...(await identityArgs(cwd)), 'commit', '-m', commitMessage], cwd);
    const hash = await git(['rev-parse', '--short', 'HEAD'], cwd);
    result.committed = true;
    result.commitHash = hash;
    result.commitMessage = commitMessage;

    // Push, when there is somewhere to push to: always after a pull, so the other DBA's work comes in first
    if (push && await hasRemote(remote, cwd)) return await pullThenPush(result);
    if (push) result.note = `No git remote '${remote}': committed locally`;

    result.ok = true;
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/**
 * One local commit of exactly these paths (folders or files), nothing else that happens to be staged or
 * changed: an import saves several change folders and commits them together.
 */
export async function commitPaths(paths: string[], commitMessage: string): Promise<{ ok: boolean; commitHash?: string; error?: string }> {
  const cwd = getCwd();
  try {
    await git(['add', '--', ...paths], cwd);
    await git([...(await identityArgs(cwd)), 'commit', '-m', commitMessage, '--', ...paths], cwd);
    return { ok: true, commitHash: await git(['rev-parse', '--short', 'HEAD'], cwd) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Full sync: pull → stage all changes under changesDir → commit → push.
 * Used by /sync command and manual sync button.
 */
export async function fullSync(
  changesDir: string,
  commitMessage: string,
): Promise<GitSyncResult> {
  const cwd = getCwd();
  const result: GitSyncResult = { ok: false, pulled: false, committed: false, pushed: false };
  try {
    // what is saved under the change folders, committed as the DBA; then pull (never hidden) and push
    await git(['add', '--', changesDir], cwd);
    const staged = await git(['diff', '--cached', '--quiet', '--', changesDir], cwd).then(() => false, () => true);
    if (staged) {
      await git([...(await identityArgs(cwd)), 'commit', '-m', commitMessage, '--', changesDir], cwd);
      result.committed = true;
      result.commitHash = await git(['rev-parse', '--short', 'HEAD'], cwd);
      result.commitMessage = commitMessage;
    }
    if (!(await hasRemote('origin', cwd)) && !(await git(['remote'], cwd)).trim()) {
      return { ...result, ok: true, note: 'No git remote: committed locally' };
    }
    return await pullThenPush(result);
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/** Get a short summary of uncommitted changes for the AI commit message prompt. */
export async function getChangesSummary(changesDir: string): Promise<string> {
  const cwd = getCwd();
  try {
    const status = await git(['status', '--porcelain', '--', changesDir], cwd);
    if (!status) { return 'No changes detected.'; }
    // Also get a condensed diff stat
    const diffStat = await git(['diff', '--stat', '--', changesDir], cwd).catch(() => '');
    const untrackedDiff = await git(['diff', '--stat', '--no-index', '/dev/null', changesDir], cwd).catch(() => '');
    return `Files:\n${status}\n\nDiff:\n${diffStat || untrackedDiff || '(new files)'}`;
  } catch {
    return 'Unable to read git status.';
  }
}

/** Get the current branch name. */
export async function getCurrentBranch(): Promise<string> {
  try {
    return await git(['rev-parse', '--abbrev-ref', 'HEAD'], getCwd());
  } catch {
    return 'unknown';
  }
}

/**
 * Get the configured branch from settings, falling back to the current branch.
 */
export function getTargetBranch(): string {
  // Settings → DMCR Config saves to SQLite; the VS Code setting is the fallback.
  const stored = findById<{ gitBranch?: string }>('dmcr_config', 'main')?.gitBranch?.trim();
  if (stored) return stored;
  return vscode.workspace.getConfiguration('dmcr').get<string>('gitBranch', '') || '';
}

/**
 * Resolve the branch to use for push/pull: configured setting → current HEAD.
 */
export async function resolveTargetBranch(): Promise<string> {
  const configured = getTargetBranch();
  if (configured) return configured;
  return getCurrentBranch();
}

/**
 * List branches available on the remote. Requires the remote URL to be set.
 * Returns branch names without the refs/heads/ prefix.
 */
export async function listRemoteBranches(remote = 'origin'): Promise<string[]> {
  const cwd = getCwd();
  try {
    const out = await git(['ls-remote', '--heads', remote], cwd);
    if (!out) return [];
    // Each line: <sha>\trefs/heads/<branch>
    return out.split('\n')
      .filter(Boolean)
      .map(line => {
        const match = line.match(/refs\/heads\/(.+)$/);
        return match ? match[1] : '';
      })
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}
