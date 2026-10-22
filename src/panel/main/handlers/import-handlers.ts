/**
 * Releases > Import from test: SQL files someone already ran on test by hand (no DMCR, no numbers), made into
 * DMCR changes that go to prod through Releases.
 *
 *   importScan      load the files (GitHub commit / pull request / folder, or a local folder), suggest the order
 *   importGenerate  each file -> deploy / verify / revert, like Freeform, with prod as the "before" state
 *   importTrial     all of them in order on prod, inside one transaction that is rolled back
 *   importSave      save + one commit, then repair --mark-applied on test (nothing runs there) and verify there
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cp from "child_process";
import type { HandlerContext, Message } from "./types";
import type { DmcrGeneratedChange } from "../../../forms/llm/generation/generator";

type ScanFile = { name: string; path: string; sql: string; kind: string; reasons: string[]; after: string[] };
type GenItem = { name: string; sql: string; after?: string[] };
type GenChange = DmcrGeneratedChange & { file: string; after?: string[] };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '').replace(/\r/g, '').trim();
const slug = (name: string) => name.replace(/\.sql$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^\d+_/, '') || 'change';

/** One runner command; the same pwsh -> Windows PowerShell fallback as the Runner tab. */
async function runRunner(ctx: HandlerContext, args: string[], opts: { changesDirOverride?: string; dmcrOverrides?: Record<string, string>; timeoutMs?: number } = {}) {
  const { buildRunnerInvocation } = await import('../../../services/runner/invocation.js');
  const inv = await buildRunnerInvocation({ extensionPath: ctx.extensionPath, extensionContext: ctx.extensionContext, args, ...opts });
  if ('error' in inv) throw new Error(inv.error === 'config-needed' ? 'The runner has no dmcr.cfg: set up DMCR Config first.' : `Runner script ${inv.scriptName} not found.`);
  const run = (executor: string) => new Promise<{ stdout: string; stderr: string; code: number | null; missing?: boolean }>(resolve => {
    const child = cp.spawn(executor, inv.spawnArgs, { env: inv.env, shell: false, cwd: inv.cwd });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); err += '\ntimed out'; }, opts.timeoutMs ?? 600_000);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ stdout: out, stderr: err + String(e), code: 1, missing: e.code === 'ENOENT' }); });
    child.on('close', c => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code: c }); });
  });
  let res = await run(inv.executor);
  if (res.missing && inv.executor === 'pwsh') res = await run('powershell');
  return res;
}

/** The first JSON object / array the runner printed (after its log lines). */
function runnerJson<T>(stdout: string): T | null {
  const s = strip(stdout);
  for (const open of ['{', '[']) {
    let i = s.indexOf(open);
    while (i >= 0) {
      try { return JSON.parse(s.slice(i)) as T; } catch { /* a log line with a brace */ }
      i = s.indexOf(open, i + 1);
    }
  }
  return null;
}

/** Each routine defined by more than one file -> its definition on `env` now (to tell which version ran last). */
async function routinesOn(env: string, files: { sql: string }[]): Promise<Record<string, string>> {
  const { analyze } = await import('../../../services/import/import-order.js');
  const { withGenerationEnv } = await import('../../../services/schema/env-schema.js');
  const { lookupPreviousDefinitions } = await import('../../../forms/llm/generation/generator.js');
  const firstFile = new Map<string, string>(); const count = new Map<string, number>();
  for (const f of files) for (const r of analyze(f.sql).routines) { count.set(r, (count.get(r) ?? 0) + 1); if (!firstFile.has(r)) firstFile.set(r, f.sql); }
  const out: Record<string, string> = {};
  for (const [r, n] of count) {
    if (n < 2) continue;
    const prev = await withGenerationEnv(env, () => lookupPreviousDefinitions(firstFile.get(r)!, false, { liveOnly: true }));
    const hit = prev.find(p => p.sql && p.object.name.replace(/"/g, '').toLowerCase() === r);
    if (hit?.sql) out[r] = hit.sql;
  }
  return out;
}

/** The previous version of the routine / view a file replaces: an earlier import file, else `env` live (prod). */
async function previousFor(item: GenItem, earlier: GenItem[], env: string): Promise<{ sql: string; from: string } | null> {
  const { analyze } = await import('../../../services/import/import-order.js');
  const mine = analyze(item.sql).routines;
  if (mine.length === 1) {
    for (let i = earlier.length - 1; i >= 0; i--) {
      if (analyze(earlier[i].sql).routines.includes(mine[0])) return { sql: earlier[i].sql.trim(), from: `${earlier[i].name}, the version imported before it` };
    }
  }
  const { withGenerationEnv } = await import('../../../services/schema/env-schema.js');
  const { lookupPreviousDefinitions } = await import('../../../forms/llm/generation/generator.js');
  const prev = await withGenerationEnv(env, () => lookupPreviousDefinitions(item.sql, false, { liveOnly: true }));
  if (prev.length === 1 && prev[0].sql) return { sql: prev[0].sql, from: `${env} (live)` };
  return null;
}

/** Called inside withGenerationEnv(target) + withoutSelfCheck, once for the whole batch (they are module-wide). */
async function generateOne(ctx: HandlerContext, item: GenItem, earlier: GenItem[], target: string, onChunk: (t: string) => void): Promise<DmcrGeneratedChange & { previousFrom?: string }> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace folder open.');
  const { buildFreeformNormalizedRequest } = await import('../../../forms/core/panels/freeform-sql-form.js');
  const { generateDmcrChangeWithCopilot, generateDmcrChangeWithCustomClient, loadDmcrContextText } = await import('../../../forms/llm/generation/generator.js');
  const { exactRoutineRevert } = await import('../../../forms/utils/sql-utils.js');
  const { getActiveFamily, getActiveCustomProviderKey } = await import('../../../services/llm/core/llm-settings.js');
  const { getAllCustomProviders, createCustomProviderClient } = await import('../../../services/llm/core/custom-providers.js');

  const prev = await previousFor(item, earlier, target);
  let normalized = buildFreeformNormalizedRequest({
    sql: item.sql, includePrevious: !!prev, previousSql: prev?.sql ?? '', changeNameHint: slug(item.name), dbSchema: '', dialect: 'postgresql',
  });
  normalized += [
    '',
    `This SQL already ran on the test environment by hand (file ${item.name}); it has NOT run on ${target}.`,
    `Write deploy.sql as this SQL, verify.sql that checks its result, and revert.sql that puts ${target} back as it was before it.`,
  ].join('\n');
  const exactRevert = prev ? exactRoutineRevert(item.sql, prev.sql) ?? undefined : undefined;
  const exactRevertFrom = exactRevert ? `the previous version, from ${prev!.from}` : undefined;
  const dmcrContext = await loadDmcrContextText(ws);
  const gen = async (): Promise<DmcrGeneratedChange> => {
    const key = getActiveCustomProviderKey();
    if (key) {
      const cfg = getAllCustomProviders().find(p => p.key === key);
      if (!cfg) throw new Error(`Custom provider '${key}' not found.`);
      const client = await createCustomProviderClient(key);
      return generateDmcrChangeWithCustomClient(client, cfg.activeModel ?? '', normalized, dmcrContext, onChunk, () => {}, { exactRevert, exactRevertFrom });
    }
    const cts = new vscode.CancellationTokenSource();
    ctx.disposables.push({ dispose: () => cts.dispose() });
    return generateDmcrChangeWithCopilot(normalized, dmcrContext, cts.token, onChunk, getActiveFamily() || undefined, undefined, { exactRevert, exactRevertFrom });
  };
  return { ...(await gen()), previousFrom: prev?.from };
}

/**
 * A function replaced twice in one import (v2 then v3): v3's revert must put back exactly what v2's deploy.sql
 * creates. That is the generated deploy.sql, which can differ from the file it came from (layout inside the
 * body), so it is aligned once every change is generated: index -> the revert.sql to use.
 */
async function alignedReverts(changes: GenChange[]): Promise<Map<number, string>> {
  const { analyze } = await import('../../../services/import/import-order.js');
  const { exactRoutineRevert } = await import('../../../forms/utils/sql-utils.js');
  const { stripLeadingComments } = await import('../../../forms/llm/generation/previous-definition.js');
  const out = new Map<number, string>();
  const routines = changes.map(c => analyze(c?.deploySql ?? '').routines);
  changes.forEach((c, i) => {
    if (!c || routines[i].length !== 1) return;
    for (let j = i - 1; j >= 0; j--) {
      if (!changes[j] || !routines[j].includes(routines[i][0])) continue;
      const revert = exactRoutineRevert(stripLeadingComments(c.deploySql.trim()), stripLeadingComments(changes[j].deploySql.trim()));
      if (revert && revert !== c.revertSql) out.set(i, revert);
      return;
    }
  });
  return out;
}

/** The changes folder (absolute). */
async function changesAbs(): Promise<string> {
  const { resolveChangesDir } = await import('../../../storage/changes-dir.js');
  return resolveChangesDir();
}

export async function handleImportMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;
  switch (msg.type) {

    case 'importScan': {
      const { requestId, source, ranOn } = (msg.payload ?? {}) as { requestId?: string; source?: string; ranOn?: string };
      try {
        const { loadSource } = await import('../../../services/import/sql-source.js');
        const { suggestOrder } = await import('../../../services/import/import-order.js');
        webview.postMessage({ type: 'importStep', payload: { requestId, text: 'Reading the SQL files' } });
        const { label, files } = await loadSource(String(source ?? ''));
        if (!files.length) throw new Error(`No .sql files in ${label}.`);
        webview.postMessage({ type: 'importStep', payload: { requestId, text: `Reading the functions on ${ranOn} that several files define` } });
        const onTest = ranOn ? await routinesOn(ranOn, files).catch(() => ({})) : {};
        const r = suggestOrder(files, onTest);
        const out: ScanFile[] = r.ordered.map(o => ({ name: o.file.name, path: o.file.path, sql: o.file.sql, kind: o.kind, reasons: o.reasons, after: o.after }));
        webview.postMessage({ type: 'importScanResult', payload: { requestId, label, files: out, unsure: r.unsure, notes: r.notes } });
      } catch (e) {
        webview.postMessage({ type: 'importScanResult', payload: { requestId, error: errText(e) } });
      }
      return true;
    }

    case 'importGenerate': {
      const { requestId, items, target, only } = (msg.payload ?? {}) as { requestId?: string; items?: GenItem[]; target?: string; only?: number };
      const list = items ?? [];
      const env = String(target ?? 'prod');
      const { setSelfCheckContext, withoutSelfCheck } = await import('../../../forms/llm/generation/self-check.js');
      const { withGenerationEnv } = await import('../../../services/schema/env-schema.js');
      setSelfCheckContext(ctx.extensionPath, ctx.extensionContext);
      // each file needs only the SQL of the files before it (not what was generated from them): 4 at a time
      const todo = list.map((_, i) => i).filter(i => only === undefined || i === only);
      const one = async (i: number) => {
        webview.postMessage({ type: 'importProgress', payload: { requestId, index: i, status: 'running' } });
        try {
          const ch = await generateOne(ctx, list[i], list.slice(0, i), env,
            t => webview.postMessage({ type: 'importProgress', payload: { requestId, index: i, status: 'running', chunk: t.slice(-200) } }));
          webview.postMessage({ type: 'importProgress', payload: { requestId, index: i, status: 'done', change: { ...ch, file: list[i].name, after: list[i].after } } });
        } catch (e) {
          webview.postMessage({ type: 'importProgress', payload: { requestId, index: i, status: 'error', error: errText(e) } });
        }
      };
      await withGenerationEnv(env, () => withoutSelfCheck(`Already ran on test: checked by the import's trial run on ${env}`, async () => {
        const queue = [...todo];
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { for (let i = queue.shift(); i !== undefined; i = queue.shift()) await one(i); }));
      }));
      webview.postMessage({ type: 'importGenerateDone', payload: { requestId } });
      return true;
    }

    case 'importTrial': {
      const { requestId, changes, target } = (msg.payload ?? {}) as { requestId?: string; changes?: GenChange[]; target?: string };
      const env = String(target ?? 'prod');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-import-trial-'));
      try {
        const dir = await changesAbs();
        const tmpChanges = path.join(tmp, 'changes');
        fs.mkdirSync(tmpChanges);
        let maxId = 0; let width = 3;
        if (dir && fs.existsSync(dir)) {
          for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            if (d.isDirectory() && /^\d+_/.test(d.name)) {
              const num = /^(\d+)_/.exec(d.name)![1];
              maxId = Math.max(maxId, parseInt(num, 10)); width = Math.max(width, num.length);
              fs.cpSync(path.join(dir, d.name), path.join(tmpChanges, d.name), { recursive: true });
            } else if (d.isFile() && d.name === 'releases.json') {
              fs.copyFileSync(path.join(dir, d.name), path.join(tmpChanges, d.name));
            }
          }
        }
        const list = changes ?? [];
        const aligned = await alignedReverts(list);
        for (const [i, revertSql] of aligned) list[i] = { ...list[i], revertSql };
        const ids: string[] = [];
        for (const c of list) {
          const id = `${String(maxId + ids.length + 1).padStart(width, '0')}_${slug(c.changeName || c.file)}`;
          const apply = (s: string) => (s ?? '').replace(/__DMCR_CHANGE_ID__/g, id);
          fs.mkdirSync(path.join(tmpChanges, id));
          fs.writeFileSync(path.join(tmpChanges, id, 'deploy.sql'), apply(c.deploySql), 'utf8');
          fs.writeFileSync(path.join(tmpChanges, id, 'verify.sql'), apply(c.verifySql), 'utf8');
          fs.writeFileSync(path.join(tmpChanges, id, 'revert.sql'), apply(c.revertSql), 'utf8');
          fs.writeFileSync(path.join(tmpChanges, id, 'meta.json'), JSON.stringify({ change_id: id }, null, 2), 'utf8');
          ids.push(id);
        }
        if (!ids.length) throw new Error('Nothing to trial-run.');
        // a short lock wait: on prod a busy table fails the trial instead of holding everyone up
        const res = await runRunner(ctx, ['test', '--to', ids[ids.length - 1], '--env', env, '--allow-prod'], { changesDirOverride: tmpChanges, dmcrOverrides: { lock_timeout: '3s' } });
        const data = runnerJson<{ status?: string; changes?: { change_id: string; status: string; details?: string }[]; stopped_at?: { change_id: string; reason: string } }>(res.stdout);
        if (!data || !Array.isArray(data.changes)) {
          throw new Error(`The trial run did not complete (exit ${res.code}): ${strip(res.stderr || res.stdout).split('\n').slice(-6).join('\n')}`);
        }
        const byId = new Map(data.changes.map(c => [c.change_id, c]));
        const results = ids.map((id, i) => {
          const r = byId.get(id);
          return { index: i, status: r?.status ?? (data.stopped_at ? 'not reached' : 'not run'), details: strip(r?.details ?? '') };
        });
        const otherFail = data.changes.find(c => !ids.includes(c.change_id) && c.status === 'fail');
        webview.postMessage({ type: 'importTrialResult', payload: {
          requestId, env, results, aligned: [...aligned].map(([index, revertSql]) => ({ index, revertSql })),
          ok: results.every(r => r.status === 'pass'),
          stopped: data.stopped_at ? { index: ids.indexOf(data.stopped_at.change_id), reason: strip(data.stopped_at.reason) } : undefined,
          blockedBy: otherFail ? `${otherFail.change_id}, a change already in the repository and not yet on ${env}, fails: ${strip(otherFail.details ?? '')}` : undefined,
        } });
      } catch (e) {
        webview.postMessage({ type: 'importTrialResult', payload: { requestId, env, error: errText(e) } });
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
      }
      return true;
    }

    case 'importSave': {
      const { requestId, changes, project, requestedBy, ranOn, ticket, label } = (msg.payload ?? {}) as {
        requestId?: string; changes?: GenChange[]; project?: string; requestedBy?: string; ranOn?: string; ticket?: string; label?: string;
      };
      const step = (text: string) => webview.postMessage({ type: 'importStep', payload: { requestId, text } });
      const saved: { file: string; id: string; folderRel: string }[] = [];
      try {
        const { saveChangeToDisk } = await import('./types.js');
        const idOf = new Map<string, string>();
        const list = changes ?? [];
        for (const [i, revertSql] of await alignedReverts(list)) list[i] = { ...list[i], revertSql };
        for (const c of list) {
          step(`Saving ${c.file}`);
          let meta: Record<string, unknown> = {};
          if (c.metaJson) { try { meta = JSON.parse(c.metaJson); } catch { /* AI meta not JSON */ } }
          const req = (c.after ?? []).map(n => idOf.get(n)).filter(Boolean) as string[];
          if (req.length) meta.requires = [...new Set([...(Array.isArray(meta.requires) ? meta.requires as string[] : []), ...req])];
          if (ticket?.trim()) meta.ticket = ticket.trim();
          meta.imported_from = `${c.file}${label ? ` (${label})` : ''}, ran on ${ranOn} by hand`;
          const r = await saveChangeToDisk({ ...c, metaJson: JSON.stringify(meta), releaseMeta: { project, requestedBy } });
          idOf.set(c.file, r.nextId);
          saved.push({ file: c.file, id: r.nextId, folderRel: r.folderRel });
        }
        step('Committing the changes');
        const { commitPaths, isGitRepo } = await import('../../../services/git/git-service.js');
        let commit: { ok: boolean; commitHash?: string; error?: string } | null = null;
        if (await isGitRepo()) {
          commit = await commitPaths(saved.map(s => s.folderRel), `feat(db): import ${saved.length} change${saved.length === 1 ? '' : 's'} already run on ${ranOn}${label ? ` from ${label}` : ''}\n\n${saved.map(s => `${s.id} <- ${s.file}`).join('\n')}`);
        }

        // test has them already: record them as applied there (no SQL runs), then check them there
        const marked: { id: string; ok: boolean; error?: string }[] = [];
        for (const s of saved) {
          step(`Marking ${s.id} as applied on ${ranOn}`);
          const res = await runRunner(ctx, ['repair', '--mark-applied', s.id, '--env', String(ranOn), '--json'], { timeoutMs: 120_000 });
          const j = runnerJson<{ status?: string }>(res.stdout);
          marked.push(j?.status === 'ok' ? { id: s.id, ok: true } : { id: s.id, ok: false, error: strip(res.stderr || res.stdout).split('\n').slice(-3).join('\n') });
        }
        step(`Verifying them on ${ranOn}`);
        const vr = await runRunner(ctx, ['verify', 'all', '--env', String(ranOn), '--json'], { timeoutMs: 300_000 });
        const all = runnerJson<{ change_id: string; status: string; error?: string }[]>(vr.stdout) ?? [];
        const ids = new Set(saved.map(s => s.id));
        // a data change backs up the rows it changes when it deploys; on test the SQL ran by hand, so that backup does
        // not exist there: everything else verified, and only test cannot revert it (prod gets the backup at deploy)
        const verified = (Array.isArray(all) ? all : [all]).filter(v => ids.has(v.change_id)).map(v => {
          const error = v.error ? strip(v.error) : undefined;
          return { id: v.change_id, status: v.status !== 'ok' && /backup table \S+ is missing/i.test(error ?? '') ? 'no-backup' : v.status, error };
        });
        webview.postMessage({ type: 'importSaveResult', payload: { requestId, saved, commit, marked, verified } });
      } catch (e) {
        webview.postMessage({ type: 'importSaveResult', payload: { requestId, saved, error: errText(e) } });
      }
      return true;
    }
  }
  return false;
}
