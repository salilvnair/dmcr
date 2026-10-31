/**
 * Conflicts between projects (Releases page): find them, preview and create the merge change that
 * resolves one (self-checked with the runner's round trip before it is saved), or record that the
 * deploy order is the intended outcome (conflicts.json in the changes folder).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HandlerContext, Message } from './types';
import { analyzeConflicts, type Conflict, type ConflictReport } from '../../../services/conflicts/analyze';
import { loadChangeInputs, readResolutions, writeResolutions } from '../../../services/conflicts/inputs';
import { buildMergeChange, retargetRevert, retargetVerify, type MergeInput } from '../../../services/conflicts/merge-change';
import * as cp from 'child_process';

async function changesDir(): Promise<string> {
  const { requireChangesDir } = await import('../../../storage/changes-dir.js');
  return requireChangesDir();
}

export async function buildConflictReport(): Promise<ConflictReport & { changesDir: string }> {
  const dir = await changesDir();
  return { ...analyzeConflicts(loadChangeInputs(dir), readResolutions(dir), ''), changesDir: dir };
}

async function findConflict(id: string): Promise<Conflict> {
  const report = await buildConflictReport();
  const c = report.conflicts.find(k => k.id === id);
  if (!c) throw new Error('That conflict is gone: the changes were edited since the list was loaded. Refresh.');
  return c;
}

export async function handleConflictMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;
  // merge changes saved but not committed: the resolved row offers Commit (folder relative to the workspace)
  const uncommittedMerges = async (report: { conflicts?: { resolved?: { resolution?: string; changeId?: string } }[] }): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    try {
      const ids = [...new Set((report.conflicts ?? []).filter(c => c.resolved?.resolution === 'merge' && c.resolved.changeId).map(c => c.resolved!.changeId!))];
      if (!ids.length) return out;
      const { isGitRepo, getUnstagedChanges } = await import('../../../services/git/git-service.js');
      if (!(await isGitRepo())) return out;
      const { requireChangesDir } = await import('../../../storage/changes-dir.js');
      const fsm = await import('fs'); const pathm = await import('path');
      const dir = await requireChangesDir();
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      for (const id of ids) {
        const folder = pathm.join(dir, id);
        if (fsm.existsSync(folder) && (await getUnstagedChanges(folder)).length) out[id] = root ? pathm.relative(root, folder) : folder;
      }
    } catch { /* no git: nothing to offer */ }
    return out;
  };
  const sendReport = async (extra: Record<string, unknown> = {}) => {
    try { const report = await buildConflictReport(); webview.postMessage({ type: 'conflictsData', payload: { ...report, uncommittedMerges: await uncommittedMerges(report as never), ...extra } }); }
    catch (e) { webview.postMessage({ type: 'conflictsData', payload: { error: e instanceof Error ? e.message : String(e), ...extra } }); }
  };

  switch (msg.type) {
    case 'getConflicts': {
      await sendReport();
      return true;
    }

    /* The merge change's SQL for the merge editor's preview (nothing is written) */
    case 'previewMergeChange': {
      const { conflictId, input } = (msg.payload ?? {}) as { conflictId?: string; input?: MergeInput };
      try {
        const c = await findConflict(conflictId ?? '');
        webview.postMessage({ type: 'mergeChangePreview', payload: { conflictId, sql: buildMergeChange(c, input ?? {}) } });
      } catch (e) {
        webview.postMessage({ type: 'mergeChangePreview', payload: { conflictId, error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    /* Build, self-check (runner round trip on a copy) and save the merge change */
    case 'createMergeChange': {
      const { conflictId, input, project, requestedBy } = (msg.payload ?? {}) as { conflictId?: string; input?: MergeInput; project?: string; requestedBy?: string };
      try {
        const c = await findConflict(conflictId ?? '');
        const sql = buildMergeChange(c, input ?? {});
        // the later side's revert.sql puts back the definition both started from: point it at the earlier side's,
        // so reverting it never drops the other DBA's change (kept only when the merge change is saved)
        const theirsRevert = path.join(await changesDir(), c.theirs.changeId, 'revert.sql');
        const oldRevert = fs.existsSync(theirsRevert) ? fs.readFileSync(theirsRevert, 'utf8') : '';
        const newRevert = oldRevert ? retargetRevert(c, oldRevert) : null;
        if (newRevert) fs.writeFileSync(theirsRevert, newRevert);
        // both added it: its verify.sql must accept the earlier side's definition once reverted
        const theirsVerify = path.join(await changesDir(), c.theirs.changeId, 'verify.sql');
        const oldVerify = newRevert && fs.existsSync(theirsVerify) ? fs.readFileSync(theirsVerify, 'utf8') : '';
        const newVerify = oldVerify ? retargetVerify(c, oldVerify) : null;
        if (newVerify) fs.writeFileSync(theirsVerify, newVerify);
        const { runSelfCheck } = await import('../../../forms/llm/generation/self-check.js');
        // the round trip runs every pending change up to the merge change, both sides included
        const selfCheck = await runSelfCheck({ changeName: sql.changeName, deploySql: sql.deploySql, verifySql: sql.verifySql, revertSql: sql.revertSql });
        if (selfCheck.status === 'failed' && newRevert) fs.writeFileSync(theirsRevert, oldRevert);
        if (selfCheck.status === 'failed' && newVerify) fs.writeFileSync(theirsVerify, oldVerify);
        if (selfCheck.status === 'failed') {
          webview.postMessage({ type: 'mergeChangeCreated', payload: { conflictId, selfCheck, error: `Not saved: the round-trip test failed. ${selfCheck.message}` } });
          return true;
        }
        const meta = {
          change_id: '',
          description: sql.description,
          tags: ['merge'],
          requires: [c.ours.changeId, c.theirs.changeId],
          merges: [{ key: c.key, changes: [c.ours.changeId, c.theirs.changeId] }],
        };
        const { saveChangeToDisk } = await import('./types.js');
        const saved = await saveChangeToDisk({
          changeName: sql.changeName, deploySql: sql.deploySql, verifySql: sql.verifySql, revertSql: sql.revertSql,
          metaJson: JSON.stringify(meta, null, 2),
          releaseMeta: { project: project || c.theirs.project, requestedBy: requestedBy || undefined },
        });
        // committed right away (it passed its round trip): nobody should need git for this
        let commit: { ok: boolean; committed?: boolean; hash?: string; error?: string; message?: string; folderRel: string } = { ok: false, folderRel: saved.folderRel };
        try {
          const { isGitAvailable, isGitRepo, commitAndPush } = await import('../../../services/git/git-service.js');
          if (await isGitAvailable() && await isGitRepo()) {
            // the retargeted revert.sql (and verify.sql) go into the same commit
            if (newRevert) await new Promise(res => cp.execFile('git', ['add', '--', theirsRevert, ...(newVerify ? [theirsVerify] : [])], { cwd: path.dirname(theirsRevert) }, () => res(null)));
            const r = await commitAndPush(saved.folderRel, `feat(dmcr): add merge change ${saved.folderRel.split(/[\\/]/).pop()}`) as { ok?: boolean; committed?: boolean; commitHash?: string; error?: string; message?: string };
            commit = { ok: !!r.ok, committed: r.committed, hash: r.commitHash, error: r.error, message: r.message, folderRel: saved.folderRel };
          } else commit = { ok: false, error: 'Git not available or not a git repository.', folderRel: saved.folderRel };
        } catch (ce) { commit = { ok: false, error: ce instanceof Error ? ce.message : String(ce), folderRel: saved.folderRel }; }
        webview.postMessage({ type: 'mergeChangeCreated', payload: { conflictId, changeId: saved.nextId, selfCheck, commit } });
        await sendReport();
        webview.postMessage({ type: 'getReleaseDataRefresh' });
      } catch (e) {
        webview.postMessage({ type: 'mergeChangeCreated', payload: { conflictId, error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    /* Keep the deploy order (the later side wins) and record why: its own message, as Schema Diff's AI resolver
       answers 'resolveConflict' first */
    case 'keepConflictOrder': {
      const { conflictId, note } = (msg.payload ?? {}) as { conflictId?: string; note?: string };
      try {
        const { getDbaName } = await import('./release-handlers.js');
        const by = await getDbaName();
        if (!by) throw new Error('Set your DBA name first (Settings > DMCR Config > DBA name).');
        const dir = await changesDir();
        const list = readResolutions(dir).filter(r => r.id !== conflictId);
        list.push({ id: conflictId ?? '', resolution: 'keep-order', note: (note ?? '').trim() || undefined, by, at: new Date().toISOString().slice(0, 16).replace('T', ' ') });
        writeResolutions(dir, list);
        await sendReport({ saved: conflictId });
      } catch (e) {
        await sendReport({ saveError: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    case 'reopenConflict': {
      const { conflictId } = (msg.payload ?? {}) as { conflictId?: string };
      const dir = await changesDir();
      writeResolutions(dir, readResolutions(dir).filter(r => r.id !== conflictId));
      await sendReport();
      return true;
    }
  }
  return false;
}
