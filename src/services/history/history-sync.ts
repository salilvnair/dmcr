/**
 * Copies what an environment's dmcr.event_log recorded into the repository (see action-record.ts), then commits and
 * pushes it. It reads the database each time, so what DMCR did not run itself comes along too: a manual script run in
 * DBeaver, a deploy from CI or a terminal. Whatever fails here (a push, an unreachable database) leaves the action
 * done and is picked up by the next sync.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { actionFiles, cleanReason, commitMessage, HISTORY_DIR, sinceFor, type ActionEvent, type ActionRecord } from './action-record';

type Ctx = { extensionPath: string; extensionContext?: import('vscode').ExtensionContext };
export type HistorySync = { committed: boolean; note: string; error?: string };

/** Commands that can add to dmcr.event_log */
const WRITES = new Set(['deploy', 'revert', 'revertlast', 'approve', 'unapprove', 'repair', 'baseline', 'tag']);
/** Reading the status anyway (the Releases tab, "I ran it: refresh"): at most this often per environment */
const READ_EVERY_MS = 60_000;

const reasons = new Map<string, string>();
const lastRead = new Map<string, number>();
let queue: Promise<unknown> = Promise.resolve();

/** The reason typed in a rollback dialog: goes with the next new rollback on that environment */
export function rememberReason(env: string, reason: unknown): void {
  const r = cleanReason(reason);
  if (env && r) reasons.set(env, r);
}

async function runEvents(ctx: Ctx, env: string, since: string): Promise<{ locked: boolean; events: ActionEvent[] } | null> {
  const { buildRunnerInvocation } = await import('../runner/invocation.js');
  const inv = await buildRunnerInvocation({ extensionPath: ctx.extensionPath, extensionContext: ctx.extensionContext, args: ['events', ...(since ? [since] : []), '--env', env] });
  if ('error' in inv) return null;
  const run = (exe: string) => new Promise<{ out: string; code: number | null; missing?: boolean }>(resolve => {
    const child = cp.spawn(exe, inv.spawnArgs, { env: inv.env, shell: false, cwd: inv.cwd });
    let out = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ out, code: 1, missing: e.code === 'ENOENT' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ out, code }); });
  });
  let res = await run(inv.executor);
  if (res.missing && inv.executor === 'pwsh') res = await run('powershell');
  if (res.code !== 0) return null;
  const at = res.out.indexOf('{"');
  try { return at >= 0 ? JSON.parse(res.out.slice(at)) : null; } catch { return null; }
}

async function syncNow(ctx: Ctx, env: string): Promise<HistorySync | null> {
  const { resolveChangesDir } = await import('../../storage/changes-dir.js');
  const git = await import('../git/git-service.js');
  const changes = resolveChangesDir();
  if (!changes || !fs.existsSync(changes) || !(await git.isGitRepo())) return null;
  const root = path.join(changes, HISTORY_DIR);
  const dir = path.join(root, env);
  const have = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const read = await runEvents(ctx, env, sinceFor(have));
  // no registry here yet, or the database is out of reach: nothing to copy now. A run in progress: its record is not whole yet
  if (!read || read.locked) return null;

  const files = actionFiles(env, read.events ?? []);
  const reason = reasons.get(env);
  if (reason) {
    const fresh = [...files].reverse().find(f => f.record.action === 'revert' && !have.includes(f.name));
    if (fresh) { fresh.record.reason = reason; reasons.delete(env); }
  }
  const written: ActionRecord[] = [];
  for (const f of files) {
    const file = path.join(dir, f.name);
    if (have.includes(f.name) && !f.record.reason) {
      // the reason in the file stays: this DBA's copy of the event does not have it
      try { const was = JSON.parse(fs.readFileSync(file, 'utf8')) as ActionRecord; if (was.reason) f.record.reason = was.reason; } catch { /* unreadable: written again */ }
    }
    const text = `${JSON.stringify(f.record, null, 2)}\n`;
    if (have.includes(f.name) && fs.readFileSync(file, 'utf8') === text) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    written.push(f.record);
  }
  // also what an earlier sync wrote and could not commit
  const pending = await git.getUnstagedChanges(root);
  if (!pending.length) return null;
  const r = await git.commitPathsAndPush([root], written.length ? commitMessage(env, written) : `chore(dmcr): record ${pending.length} actions`);
  if (!r.ok) return { committed: !!r.committed, note: '', error: r.error || 'git failed' };
  return { committed: true, note: r.note || `committed ${r.commitHash ?? ''}${r.pushed ? ' and pushed' : ''}`.trim() };
}

/** After a run of the runner: what it did goes to git. Never throws and never holds the run up. */
export function syncAfterRun(ctx: Ctx, webview: { postMessage: (m: unknown) => unknown }, baseCommand: string, args: string[], activeEnv: () => string): void {
  const command = baseCommand.toLowerCase();
  const writes = WRITES.has(command) && !args.includes('--dry-run');
  if (!writes && command !== 'status') return;
  const flag = args.indexOf('--env');
  const env = (flag >= 0 ? args[flag + 1] : '') || activeEnv();
  if (!env) return;
  if (!writes && Date.now() - (lastRead.get(env) ?? 0) < READ_EVERY_MS) return;
  lastRead.set(env, Date.now());
  queue = queue.then(() => syncNow(ctx, env)).then(r => {
    if (r) webview.postMessage({ type: 'actionHistorySaved', payload: { env, ...r } });
  }).catch(e => {
    webview.postMessage({ type: 'actionHistorySaved', payload: { env, committed: false, note: '', error: e instanceof Error ? e.message : String(e) } });
  });
}
