/**
 * Git Service — pull, commit, push for DMCR change folders.
 *
 * Uses the `git` CLI via child_process. Requires `git` on PATH.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
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

/** Pull with rebase from remote. */
export async function pull(remote = 'origin'): Promise<boolean> {
  const cwd = getCwd();
  try {
    const branch = await resolveTargetBranch();
    await git(['pull', '--rebase', remote, branch], cwd);
    return true;
  } catch {
    return false;
  }
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
    await git(['commit', '-m', commitMessage], cwd);
    const hash = await git(['rev-parse', '--short', 'HEAD'], cwd);
    result.committed = true;
    result.commitHash = hash;
    result.commitMessage = commitMessage;

    // Push
    if (push) {
      const branch = await resolveTargetBranch();
      await git(['push', remote, branch], cwd);
      result.pushed = true;
    }

    result.ok = true;
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/**
 * Full sync: pull → stage all changes under changesDir → commit → push.
 * Used by /sync command and manual sync button.
 */
export async function fullSync(
  changesDir: string,
  commitMessage: string,
  remote = 'origin',
): Promise<GitSyncResult> {
  const cwd = getCwd();
  const result: GitSyncResult = { ok: false, pulled: false, committed: false, pushed: false };

  try {
    // Pull first
    try {
      const branch = await resolveTargetBranch();
      await git(['pull', '--rebase', remote, branch], cwd);
      result.pulled = true;
    } catch {
      // Pull may fail if no remote configured — continue anyway
    }

    // Stage all changes under changesDir
    await git(['add', '--', changesDir], cwd);

    // Check if anything staged
    try {
      await git(['diff', '--cached', '--quiet'], cwd);
      result.ok = true;
      result.committed = false;
      return result; // Nothing to commit
    } catch {
      // Good — there are staged changes
    }

    // Commit
    await git(['commit', '-m', commitMessage], cwd);
    const hash = await git(['rev-parse', '--short', 'HEAD'], cwd);
    result.committed = true;
    result.commitHash = hash;
    result.commitMessage = commitMessage;

    // Push
    try {
      const branch = await resolveTargetBranch();
      await git(['push', remote, branch], cwd);
      result.pushed = true;
    } catch (pushErr: unknown) {
      result.error = `Committed (${hash}) but push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`;
    }

    result.ok = true;
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
