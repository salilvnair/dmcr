/**
 * Shared types and helpers for DmcrPanel message handlers.
 */
import * as vscode from "vscode";
import * as path from "path";
import type { DmcrGeneratedChange } from "../../../forms/llm/generation/generator";

/* ── Handler context passed to every handler module ── */

export interface PendingGeneration {
  msgId: string;
  contextualUserText: string;
  dmcrContext: string;
  conversationId: string;
  fullUserText: string;
  /** Change name hint typed by the user; when set it is the change's name (the AI only proposes one). */
  changeNameHint?: string;
}

export interface PanelState {
  activeFormType: string | null;
  /** Generations waiting for their metadata form, keyed by the form's pendingId. */
  pendingGenerations: Record<string, PendingGeneration>;
  inlineConvSessionStartId: number;
}

export interface HandlerContext {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  extensionPath: string;
  disposables: vscode.Disposable[];
  state: PanelState;
  extensionContext: vscode.ExtensionContext | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Message = { type: string; msgId?: string; payload?: any };

/* ── Shared utility functions ── */

export async function computeNextChangeId(
  changesAbs: string,
  width: number,
  slug: string,
): Promise<string> {
  let next = 1;
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(changesAbs));
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) continue;
      const m = name.match(/^(\d+)_/);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= next) next = n + 1;
    }
  } catch { /* empty dir is fine */ }
  const prefix = String(next).padStart(width, "0");
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${prefix}_${safeSlug}`;
}

export async function writeFileToDisk(folderAbs: string, fileName: string, content: string) {
  const fileUri = vscode.Uri.file(path.join(folderAbs, fileName));
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
}

export { parseDmcrIni, buildDmcrCfg, cfgEnvList, cfgActiveEnv, NON_ENV_SECTIONS, ENV_NAME_RE } from './dmcr-cfg';
export type { EnvRules, EnvConn } from './dmcr-cfg';

/** Save a generated DMCR change to disk and return folder info. */
export async function saveChangeToDisk(change: DmcrGeneratedChange & {
  location?: string;
  /** Release fields from the change card (Project, Requested by, Kind) */
  releaseMeta?: { project?: string; requestedBy?: string; kind?: string };
}): Promise<{
  nextId: string; folderRel: string; deployUri: vscode.Uri; isDanger: boolean;
}> {
  // Every change records who created it: no DBA name, no save (nothing is written)
  {
    const { getDbaName } = await import('./release-handlers.js');
    if (!(await getDbaName())) {
      throw new Error('Set your DBA name first (Settings > DMCR Config > DBA name). Every change records who created it.');
    }
  }
  const loc = (change.location ?? '').trim();
  const { CHANGE_ID_WIDTH, getChangesDirSetting } = await import('../../../storage/changes-dir.js');
  const idWidth = CHANGE_ID_WIDTH;

  // Resolve changesDir: explicit location > the shared setting (DMCR Config > dmcr.cfg > VS Code setting)
  const changesDir = loc || getChangesDirSetting();

  // Resolve relative path against workspace root (same logic as lsChanges)
  let changesAbs: string;
  if (path.isAbsolute(changesDir)) {
    changesAbs = changesDir;
  } else {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) throw new Error('No workspace open and changes directory is a relative path. Open a workspace or use an absolute path.');
    changesAbs = path.join(ws.uri.fsPath, changesDir);
  }
  // The folder number is assigned here; drop one the AI may have written into the name (005_add_x)
  let changeName = change.changeName.replace(/^(danger_)?\d+_/, '$1');
  const repeatable = /^R__/.test(changeName);
  // Folder names carry the project: 003_a_insert_lookup_20 (one folder, one global deploy order)
  const projectSlug = (change.releaseMeta?.project ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (projectSlug && !repeatable) {
    const bare = changeName.replace(/^danger_/, '');
    if (!bare.toLowerCase().startsWith(projectSlug + '_')) {
      changeName = (changeName.startsWith('danger_') ? 'danger_' : '') + `${projectSlug}_${bare}`;
    }
  }
  const { hasDangerPatterns } = await import('../../../forms/llm/prompts/prompt-template.js');
  // A repeatable is re-run automatically on every change of its file: a dangerous one (DROP …) never may be
  if (repeatable && (/(^|_)danger_/i.test(changeName) || hasDangerPatterns(change.deploySql))) {
    throw new Error('A dangerous change (DROP, TRUNCATE …) cannot be a repeatable R__ change: it would run automatically. Switch off "Repeatable migration" and save it as a numbered danger_ change, which the DBA runs by hand.');
  }
  if (!repeatable && !changeName.startsWith('danger_') && hasDangerPatterns(change.deploySql)) {
    changeName = `danger_${changeName}`;
  }
  // The same deploy.sql as a change already saved (an old card saved twice): one change, not two ids
  if (!repeatable) {
    const { findDuplicateChange } = await import('../../../services/changes/duplicate.js');
    const dup = findDuplicateChange(changesAbs, change.deploySql);
    if (dup) throw new Error(`Already saved as ${dup}: its deploy.sql does the same. Nothing was written. To change that change's project, requested by or kind, use Releases (or Save details on the card that saved it).`);
  }
  // Repeatable: R__<name>, no number — saving again updates the same folder (a new version)
  const nextId = repeatable
    ? 'R__' + changeName.slice(3).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
    : await computeNextChangeId(changesAbs, idWidth, changeName);
  const folderAbs = path.join(changesAbs, nextId);
  const applyId = (sql: string) => sql.replace(/__DMCR_CHANGE_ID__/g, nextId);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(folderAbs));
  await writeFileToDisk(folderAbs, 'deploy.sql', applyId(change.deploySql));
  await writeFileToDisk(folderAbs, 'verify.sql', applyId(change.verifySql));
  await writeFileToDisk(folderAbs, 'revert.sql', applyId(change.revertSql));
  // Project / requester given on the card, plus who wrote it and when (dmcr.change_log records them)
  const rm = change.releaseMeta ?? {};
  const { getDbaName } = await import('./release-handlers.js');
  const dbaName = await getDbaName();
  const stamp = (meta: Record<string, unknown>) => {
    if (rm.project?.trim()) meta.project = rm.project.trim();
    if (rm.requestedBy?.trim()) meta.requested_by = rm.requestedBy.trim();
    if (rm.kind?.trim()) meta.kind = rm.kind.trim();
    if (dbaName && !meta.created_by) meta.created_by = dbaName;
    if (!meta.created_at) meta.created_at = new Date().toISOString().slice(0, 10);
  };
  if (change.metaJson) {
    // change_id is the folder id (what dmcr.change_log records), never a placeholder such as
    // the Assistant's "(will be generated)" or the bare change name
    let metaOut = change.metaJson;
    try {
      const meta = JSON.parse(change.metaJson) as Record<string, unknown>;
      meta.change_id = nextId;
      stamp(meta);
      metaOut = JSON.stringify(meta, null, 2);
    } catch { /* not JSON: written as given, the runner reports it */ }
    await writeFileToDisk(folderAbs, 'meta.json', metaOut);
  } else if (rm.project || rm.requestedBy || rm.kind || dbaName) {
    const meta: Record<string, unknown> = { change_id: nextId };
    stamp(meta);
    await writeFileToDisk(folderAbs, 'meta.json', JSON.stringify(meta, null, 2));
  }
  const deployUri = vscode.Uri.file(path.join(folderAbs, 'deploy.sql'));
  const folderRel = path.join(changesDir, nextId);
  const isDanger = changeName.startsWith('danger_');
  return { nextId, folderRel, deployUri, isDanger };
}

/**
 * Auto-commit the generated change folder if gitAutoCommit is enabled.
 * Generates an AI commit message using the GIT_COMMIT_MESSAGE prompt.
 * Returns the commit result or null if auto-commit is disabled/unavailable.
 */
export async function gitAutoCommitIfEnabled(
  folderRel: string,
  deploySql: string,
  folderName: string,
): Promise<{ ok: boolean; committed?: boolean; commitHash?: string; commitMessage?: string; error?: string } | null> {
  const { findById: findGitCfg } = await import('../../../storage/db.js');
  const storedCfg = findGitCfg<{ gitAutoCommit?: boolean }>('dmcr_config', 'main');
  if (!storedCfg?.gitAutoCommit) return null;

  try {
    const { isGitAvailable, isGitRepo, commitAndPush, getCurrentBranch } = await import('../../../services/git/git-service.js');
    if (!(await isGitAvailable()) || !(await isGitRepo())) return null;

    // Generate AI commit message
    let commitMsg = `feat(db): add ${folderName}`;
    try {
      const { getResolvedPrompt, getResolvedUserPrompt } = await import('../../../storage/prompt-library.js');
      const branch = await getCurrentBranch();
      const systemPrompt = getResolvedPrompt('GIT_COMMIT_MESSAGE', {});
      const userPrompt = getResolvedUserPrompt('GIT_COMMIT_MESSAGE', {
        folderName,
        deploySql: deploySql.slice(0, 2000), // Limit SQL length for token efficiency
        changeSummary: `New change folder: ${folderName}`,
        branch,
      });
      const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
      const t0 = Date.now();
      const aiMsg = await callActiveLlm(systemPrompt, userPrompt, 0.1);
      if (aiMsg && aiMsg.trim().length > 5 && aiMsg.trim().length < 200) {
        commitMsg = aiMsg.trim();
      }
      // Audit log the LLM call
      try {
        const { insertAudit } = await import('../../../storage/db.js');
        insertAudit({
          conversation_id: `git-autocommit-${folderName}`,
          stage: 'GIT_COMMIT_MESSAGE',
          system_prompt: systemPrompt.slice(0, 2000),
          user_prompt: userPrompt.slice(0, 2000),
          response_payload: JSON.stringify({ commitMessage: commitMsg }),
          duration_ms: Date.now() - t0,
          meta: JSON.stringify({ folderRel, branch, trigger: 'auto-commit' }),
        });
      } catch { /* audit is best-effort */ }
    } catch {
      // Fallback to default commit message
    }

    const result = await commitAndPush(folderRel, commitMsg);
    return result;
  } catch {
    return null;
  }
}
