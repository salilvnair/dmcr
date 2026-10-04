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

/** Per-environment release rules (dmcr.cfg [<env>] promote_from / out_of_order). */
export interface EnvRules { promoteFrom?: string; outOfOrder?: 'allow' | 'block' | '' }

/**
 * Build the content of dmcr.cfg from form values.
 * `extraEnvs` supports N additional environments beyond dev/prod.
 * `existing` is the current file, parsed: keys and sections the form does not manage
 * ([placeholders], run_history_limit, hand-added settings …) are carried over unchanged.
 */
export function buildDmcrCfg(p: {
  env: string; changesDir: string; psqlPath: string;
  lockTimeout: string; statementTimeout: string;
  checksumPolicy?: string;
  devConnUrl?: string; prodConnUrl?: string; compareConnUrl?: string;
  extraEnvs?: { name: string; connUrl: string }[];
  envRules?: Record<string, EnvRules>;
  existing?: Record<string, Record<string, string>>;
}): string {
  const extras = (p.extraEnvs ?? []).filter(e => e.name.trim());
  const allEnvNames = ['dev', 'prod', ...extras.map(e => e.name)];
  const existing = p.existing ?? {};
  const managed: Record<string, Set<string>> = {
    dmcr: new Set(['env', 'changes_dir', 'psql_path', 'lock_timeout', 'statement_timeout', 'checksum_policy']),
    envs: new Set(['names']),
    compare: new Set(['conn']),
  };
  for (const n of allEnvNames) { managed[n] = new Set(['conn', 'promote_from', 'out_of_order']); }
  /** Lines for the keys of `section` in the existing file that the form does not manage. */
  const kept = (section: string): string[] =>
    Object.entries(existing[section] ?? {})
      .filter(([k]) => !managed[section]?.has(k))
      .map(([k, v]) => `${k} = ${v}`);
  const rules = (envName: string): string[] => {
    const r = p.envRules?.[envName] ?? {};
    const out: string[] = [];
    const from = (r.promoteFrom ?? '').trim();
    if (from && from !== envName) {
      out.push(`# Promotion gate: deploy only changes already applied in [${from}] with identical files`, `promote_from = ${from}`);
    }
    if (r.outOfOrder === 'block' || r.outOfOrder === 'allow') {
      out.push(`# A pending change that sorts before an applied one: allow | block`, `out_of_order = ${r.outOfOrder}`);
    }
    return out;
  };

  const lines: string[] = [
    '[dmcr]',
    `# Active environment: ${allEnvNames.join(' | ')}`,
    `env = ${p.env || 'dev'}`,
    '',
    `# Relative (from workspace root) or absolute path to your DMCR changes directory`,
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
  ];
  const policy = (p.checksumPolicy ?? existing['dmcr']?.['checksum_policy'] ?? '').trim();
  if (policy) {
    lines.push(`# Applied change files edited afterwards: warn | block | repair`, `checksum_policy = ${policy}`, '');
  }
  lines.push(...kept('dmcr'),
    '',
    '[envs]',
    `# All configured environments — add names here and create a matching [envname] section below`,
    `names = ${allEnvNames.join(', ')}`,
    ...kept('envs'),
    '',
    '',
    '[dev]',
    `# Connection URL (no password). Password stored separately in OS Keychain as dmcr.devPassword.`,
    `# The DMCR extension injects the full URL via DMCR_CONN env var at runtime.`,
    `conn = ${p.devConnUrl ?? ''}`,
    ...rules('dev'),
    ...kept('dev'),
    '',
    '',
    '[prod]',
    `# Connection URL (no password). Password stored separately in OS Keychain as dmcr.prodPassword.`,
    `conn = ${p.prodConnUrl ?? ''}`,
    ...rules('prod'),
    ...kept('prod'),
    '',
  );

  for (const env of extras) {
    lines.push(
      '',
      `[${env.name}]`,
      `# Connection URL (no password). Password stored separately in OS Keychain as dmcr.${env.name}Password.`,
      `conn = ${env.connUrl}`,
      ...rules(env.name),
      ...kept(env.name),
      '',
    );
  }

  lines.push(
    '',
    '[compare]',
    `# Optional second DB for Schema Diff (compare target). Full connection URL including password.`,
    `conn = ${p.compareConnUrl ?? ''}`,
    ...kept('compare'),
    '',
  );

  // Sections the form does not know ([placeholders], …) — kept as they were
  for (const section of Object.keys(existing)) {
    if (managed[section]) continue;
    const entries = Object.entries(existing[section]);
    lines.push('', `[${section}]`, ...entries.map(([k, v]) => `${k} = ${v}`), '');
  }

  return lines.join('\n');
}

/** Save a generated DMCR change to disk and return folder info. */
export async function saveChangeToDisk(change: DmcrGeneratedChange & { location?: string }): Promise<{
  nextId: string; folderRel: string; deployUri: vscode.Uri; isDanger: boolean;
}> {
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
