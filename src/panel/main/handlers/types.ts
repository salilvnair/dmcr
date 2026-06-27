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
}

export interface PanelState {
  activeFormType: string | null;
  pendingGeneration: PendingGeneration | null;
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

/** Minimal INI parser — returns { section: { key: value } }. Strips inline # comments. */
export function parseDmcrIni(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      result[section] = result[section] ?? {};
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0 || !section) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).split('#')[0].trim();
    result[section][key] = val;
  }
  return result;
}

/**
 * Build the content of dmcr.cfg from form values.
 * `extraEnvs` supports N additional environments beyond dev/prod.
 */
export function buildDmcrCfg(p: {
  env: string; changesDir: string; psqlPath: string;
  lockTimeout: string; statementTimeout: string;
  devConnUrl?: string; prodConnUrl?: string; compareConnUrl?: string;
  extraEnvs?: { name: string; connUrl: string }[];
}): string {
  const extras = (p.extraEnvs ?? []).filter(e => e.name.trim());
  const allEnvNames = ['dev', 'prod', ...extras.map(e => e.name)];

  const lines: string[] = [
    '[dmcr]',
    `# Active environment: ${allEnvNames.join(' | ')}`,
    `env = ${p.env || 'dev'}`,
    '',
    `# Absolute path to your DMCR changes directory`,
    `changes_dir = ${p.changesDir}`,
    '',
    `# Absolute path to psql (leave blank to use PATH)`,
    `psql_path = ${p.psqlPath}`,
    '',
    `# Fail fast if DDL/DML waits on a lock longer than this (e.g. 5s, 30s)`,
    `lock_timeout = ${p.lockTimeout || '30s'}`,
    '',
    `# Abort any single statement that runs longer than this (e.g. 5min, 30s)`,
    `statement_timeout = ${p.statementTimeout || '5min'}`,
    '',
    '',
    '[envs]',
    `# All configured environments — add names here and create a matching [envname] section below`,
    `names = ${allEnvNames.join(', ')}`,
    '',
    '',
    '[dev]',
    `# Connection URL (no password). Password stored separately in OS Keychain as dmcr.devPassword.`,
    `# The DMCR extension injects the full URL via DMCR_CONN env var at runtime.`,
    `conn = ${p.devConnUrl ?? ''}`,
    '',
    '',
    '[prod]',
    `# Connection URL (no password). Password stored separately in OS Keychain as dmcr.prodPassword.`,
    `conn = ${p.prodConnUrl ?? ''}`,
    '',
  ];

  for (const env of extras) {
    lines.push(
      '',
      `[${env.name}]`,
      `conn = ${env.connUrl}`,
      '',
    );
  }

  lines.push(
    '',
    '[compare]',
    `# Optional second DB for Schema Diff (compare target). Full connection URL including password.`,
    `conn = ${p.compareConnUrl ?? ''}`,
    '',
  );

  return lines.join('\n');
}

/** Save a generated DMCR change to disk and return folder info. */
export async function saveChangeToDisk(change: DmcrGeneratedChange & { location?: string }): Promise<{
  nextId: string; folderRel: string; deployUri: vscode.Uri; isDanger: boolean;
}> {
  const loc = (change.location ?? '').trim();
  const idWidth = 3;

  // Resolve changesDir: explicit location > SQLite dmcr_config
  const { findById } = await import('../../../storage/db.js');
  const dbCfg = findById<{ changesDir?: string }>('dmcr_config', 'main');
  let changesDir = loc || (dbCfg?.changesDir ?? '');

  // changesDir must be absolute — DMCR stores absolute paths in dmcr.cfg and SQLite
  let changesAbs: string;
  if (changesDir && path.isAbsolute(changesDir)) {
    changesAbs = changesDir;
  } else {
    throw new Error('No changes directory configured. Set an absolute path in Settings → DMCR Config.');
  }
  let changeName = change.changeName;
  const { hasDangerPatterns } = await import('../../../forms/llm/prompts/prompt-template.js');
  if (!changeName.startsWith('danger_') && hasDangerPatterns(change.deploySql)) {
    changeName = `danger_${changeName}`;
  }
  const nextId = await computeNextChangeId(changesAbs, idWidth, changeName);
  const folderAbs = path.join(changesAbs, nextId);
  const applyId = (sql: string) => sql.replace(/__DMCR_CHANGE_ID__/g, nextId);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(folderAbs));
  await writeFileToDisk(folderAbs, 'deploy.sql', applyId(change.deploySql));
  await writeFileToDisk(folderAbs, 'verify.sql', applyId(change.verifySql));
  await writeFileToDisk(folderAbs, 'revert.sql', applyId(change.revertSql));
  if (change.metaJson) {
    await writeFileToDisk(folderAbs, 'meta.json', change.metaJson);
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
