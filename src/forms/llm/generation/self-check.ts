/**
 * Self-check of a generated change before anyone sees it: the real runner runs
 * `test --to <change> --env <test env>` against a temporary copy of the changes folder with the new
 * change added as the next folder. That is deploy, verify, revert, verify for every pending change up
 * to it, inside one transaction that is rolled back - nothing is left in the database.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cp from "child_process";
import { parseDmcrIni } from "../../../panel/main/handlers/types";
import { buildRunnerInvocation, findRunnerConfig, resolveRunnerScript } from "../../../services/runner/invocation";

export type SelfCheckResult = {
  status: 'passed' | 'failed' | 'skipped';
  /** one line for the card */
  message: string;
  /** what PostgreSQL / the runner reported for this change (failed) */
  error?: string;
  env?: string;
  ms: number;
};

let ext: { extensionPath: string; extensionContext?: vscode.ExtensionContext } | null = null;

/** Called by the panel handlers so generation can start the runner (it needs the extension path and keychain). */
export function setSelfCheckContext(extensionPath: string, extensionContext?: vscode.ExtensionContext): void {
  ext = { extensionPath, extensionContext };
}

const TIMEOUT_MS = 180_000;

/** The environment to test on: [test] when the config has it, else the default [dmcr].env. */
function testEnv(cfgPath: string): string {
  try {
    const ini = parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'));
    if (ini['test']) return 'test';
    return ini['dmcr']?.['env'] || 'dev';
  } catch { return 'dev'; }
}

/** meta.json says "transaction": false (the change runs outside a transaction, e.g. CREATE INDEX CONCURRENTLY). */
function noTransaction(metaJson?: string): boolean {
  if (!metaJson) return false;
  try { return (JSON.parse(metaJson) as { transaction?: unknown }).transaction === false; } catch { return false; }
}

export async function runSelfCheck(change: { changeName: string; deploySql: string; verifySql: string; revertSql: string; metaJson?: string }): Promise<SelfCheckResult> {
  const t0 = Date.now();
  const skipped = (message: string): SelfCheckResult => ({ status: 'skipped', message, ms: Date.now() - t0 });
  if (!ext) return skipped('Self-check not available here.');
  let changesDir = '';
  try { const { resolveChangesDir } = await import('../../../storage/changes-dir.js'); changesDir = resolveChangesDir(); } catch { /* no workspace */ }
  if (!changesDir || !fs.existsSync(changesDir)) return skipped('No changes folder, so the change was not test-run.');
  const { script } = resolveRunnerScript(ext.extensionPath);
  const cfgPath = script ? findRunnerConfig(script) : '';
  if (!cfgPath) return skipped('No dmcr.cfg, so the change was not test-run.');
  const env = testEnv(cfgPath);
  // danger_ changes are manual-only: the runner never test-runs or deploys them, the DBA runs them
  if (/(^|_)danger_/i.test(change.changeName ?? '')) return { ...skipped('A manual-only (danger_) change is never test-run: the DBA runs it by hand.'), env };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-selfcheck-'));
  try {
    const tmpChanges = path.join(tmp, 'changes');
    fs.mkdirSync(tmpChanges);
    let maxId = 0; let width = 3;
    for (const d of fs.readdirSync(changesDir, { withFileTypes: true })) {
      if (d.isDirectory() && /^\d+_/.test(d.name)) {
        const num = /^(\d+)_/.exec(d.name)![1];
        maxId = Math.max(maxId, parseInt(num, 10)); width = Math.max(width, num.length);
        fs.cpSync(path.join(changesDir, d.name), path.join(tmpChanges, d.name), { recursive: true });
      } else if (d.isFile() && d.name === 'releases.json') {
        fs.copyFileSync(path.join(changesDir, d.name), path.join(tmpChanges, d.name));
      }
    }
    const slug = (change.changeName || 'change').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^\d+_/, '').replace(/^_+|_+$/g, '') || 'change';
    const id = `${String(maxId + 1).padStart(width, '0')}_${slug}`;
    const dir = path.join(tmpChanges, id);
    fs.mkdirSync(dir);
    const applyId = (sql: string) => (sql ?? '').replace(/__DMCR_CHANGE_ID__/g, id);
    fs.writeFileSync(path.join(dir, 'deploy.sql'), applyId(change.deploySql), 'utf8');
    fs.writeFileSync(path.join(dir, 'verify.sql'), applyId(change.verifySql), 'utf8');
    fs.writeFileSync(path.join(dir, 'revert.sql'), applyId(change.revertSql), 'utf8');
    // requires are the user's choice and are checked at save / deploy; the round trip runs every pending change before it anyway
    // "transaction": false is kept: the runner then tests CREATE/DROP INDEX CONCURRENTLY without
    // CONCURRENTLY inside the rolled-back transaction (same end state), as `dmcr test` does.
    const meta: Record<string, unknown> = { change_id: id };
    if (noTransaction(change.metaJson)) meta.transaction = false;
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    const inv = await buildRunnerInvocation({ extensionPath: ext.extensionPath, extensionContext: ext.extensionContext, args: ['test', '--to', id, '--env', env], changesDirOverride: tmpChanges });
    if ('error' in inv) return skipped('The runner is not configured, so the change was not test-run.');

    const run = (executor: string) => new Promise<{ stdout: string; stderr: string; code: number | null; missing?: boolean }>(resolve => {
      const child = cp.spawn(executor, inv.spawnArgs, { env: inv.env, shell: false, cwd: inv.cwd });
      let out = ''; let err = '';
      const timer = setTimeout(() => { child.kill(); err += '\nself-check timed out'; }, TIMEOUT_MS);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ stdout: out, stderr: err + String(e), code: 1, missing: e.code === 'ENOENT' }); });
      child.on('close', c => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code: c }); });
    });
    let res = await run(inv.executor);
    // Same fallback as the Runner tab: no PowerShell 7 (pwsh) on this machine -> Windows PowerShell
    if (res.missing && inv.executor === 'pwsh') res = await run('powershell');
    const { stdout, stderr, code } = res;

    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '').replace(/\r/g, '').trim();
    let data: { status?: string; changes?: { change_id: string; status: string; details?: string }[]; stopped_at?: { change_id: string; reason: string } } | null = null;
    try { data = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { /* not JSON */ }
    if (!data || !Array.isArray(data.changes)) {
      const tail = strip(stderr || stdout).split('\n').slice(-6).join('\n');
      return { status: 'skipped', message: `The test run did not complete (exit ${code}).`, error: tail, env, ms: Date.now() - t0 };
    }
    const mine = data.changes.find(c => c.change_id === id);
    const earlier = data.changes.find(c => c.change_id !== id && c.status === 'fail');
    if (earlier) return { status: 'skipped', message: `An earlier pending change (${earlier.change_id}) fails its own round trip, so this one could not be tested.`, error: strip(earlier.details ?? ''), env, ms: Date.now() - t0 };
    if (mine?.status === 'pass') return { status: 'passed', message: `Test-run on ${env}: deploy, verify, revert and verify passed; schema and data restored exactly (rolled back).`, env, ms: Date.now() - t0 };
    const reason = strip(mine?.details || data.stopped_at?.reason || stderr || 'failed');
    return { status: 'failed', message: `Test-run on ${env} failed.`, error: reason, env, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 'skipped', message: 'The self-check could not run.', error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
