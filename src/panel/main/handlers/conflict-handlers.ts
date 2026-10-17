/**
 * Conflicts between projects (Releases page): find them, preview and create the merge change that
 * resolves one (self-checked with the runner's round trip before it is saved), or record that the
 * deploy order is the intended outcome (conflicts.json in the changes folder).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HandlerContext, Message } from './types';
import { analyzeConflicts, type ChangeInput, type Conflict, type ConflictReport, type Resolution } from '../../../services/conflicts/analyze';
import { buildMergeChange, type MergeInput } from '../../../services/conflicts/merge-change';
import { compareChangeIds } from '../../../storage/change-order';

const RESOLUTIONS_FILE = 'conflicts.json';

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

async function changesDir(): Promise<string> {
  const { requireChangesDir } = await import('../../../storage/changes-dir.js');
  return requireChangesDir();
}

function readResolutions(dir: string): Resolution[] {
  const f = path.join(dir, RESOLUTIONS_FILE);
  if (!fs.existsSync(f)) return [];
  try { const j = readJson(f) as { resolutions?: Resolution[] }; return Array.isArray(j.resolutions) ? j.resolutions : []; } catch { return []; }
}

function writeResolutions(dir: string, list: Resolution[]): void {
  fs.writeFileSync(path.join(dir, RESOLUTIONS_FILE), JSON.stringify({ resolutions: list }, null, 2) + '\n', 'utf8');
}

/** Every change folder with its project, release, requires and deploy.sql. */
export function loadChangeInputs(dir: string): ChangeInput[] {
  let projects: { id: string; release?: string; status?: string }[] = [];
  let releases: { id: string; date?: string }[] = [];
  const cat = path.join(dir, 'releases.json');
  if (fs.existsSync(cat)) {
    try { const j = readJson(cat) as { projects?: typeof projects; releases?: typeof releases }; projects = j.projects ?? []; releases = j.releases ?? []; } catch { /* reported by the Releases page */ }
  }
  const proj = new Map(projects.map(p => [str(p.id).toLowerCase(), p]));
  const rel = new Map(releases.map(r => [str(r.id).toLowerCase(), r]));
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d+_/.test(d.name))
    .map(d => d.name).sort(compareChangeIds)
    .map(id => {
      let meta: Record<string, unknown> = {};
      const mf = path.join(dir, id, 'meta.json');
      if (fs.existsSync(mf)) { try { meta = readJson(mf) as Record<string, unknown>; } catch { /* ignored */ } }
      const df = path.join(dir, id, 'deploy.sql');
      const project = str(meta.project);
      const p = proj.get(project.toLowerCase());
      const release = str(p?.release);
      const merges = Array.isArray(meta.merges) ? (meta.merges as { key?: string; changes?: string[] }[]).filter(m => m.key && Array.isArray(m.changes)).map(m => ({ key: m.key!, changes: m.changes! })) : undefined;
      return {
        id, project, release, releaseDate: str(rel.get(release.toLowerCase())?.date) || release,
        dropped: str(meta.status).toLowerCase() === 'dropped' || str(p?.status).toLowerCase() === 'dropped',
        requires: Array.isArray(meta.requires) ? (meta.requires as unknown[]).map(str).filter(Boolean) : [],
        // no schema: older changes' ${schema}.zaps and newer ones' zaps are the same table
        deploySql: fs.existsSync(df) ? fs.readFileSync(df, 'utf8').replace(/\$\{schema\}\./g, '') : '',
        merges,
      };
    });
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
        const { runSelfCheck } = await import('../../../forms/llm/generation/self-check.js');
        // the round trip runs every pending change up to the merge change, both sides included
        const selfCheck = await runSelfCheck({ changeName: sql.changeName, deploySql: sql.deploySql, verifySql: sql.verifySql, revertSql: sql.revertSql });
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
        let commit: { ok: boolean; committed?: boolean; hash?: string; error?: string; folderRel: string } = { ok: false, folderRel: saved.folderRel };
        try {
          const { isGitAvailable, isGitRepo, commitAndPush } = await import('../../../services/git/git-service.js');
          if (await isGitAvailable() && await isGitRepo()) {
            const r = await commitAndPush(saved.folderRel, `feat(dmcr): add merge change ${saved.folderRel.split(/[\\/]/).pop()}`) as { ok?: boolean; committed?: boolean; commitHash?: string; error?: string };
            commit = { ok: !!r.ok, committed: r.committed, hash: r.commitHash, error: r.error, folderRel: saved.folderRel };
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

    /* Keep the deploy order (the later side wins) and record why */
    case 'resolveConflict': {
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
