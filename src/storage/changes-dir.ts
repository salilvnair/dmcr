/**
 * Where DMCR change folders live — one answer for every feature.
 *
 * Order: Settings → DMCR Config (SQLite dmcr_config.changesDir)
 *      → changes_dir in the user's dmcr.cfg (what the runner reads)
 *      → VS Code setting dmcr.changesDir (default "db/changes").
 * A relative path is resolved against the first workspace folder, as the runner does.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findById } from './db';
import { getUserCfgPath } from './runner-paths';

/** Change folders are numbered 001_, 002_, … The runners only recognise 3-digit prefixes. */
export const CHANGE_ID_WIDTH = 3;

function changesDirFromCfg(cfgPath: string | undefined): string {
  if (!cfgPath || !fs.existsSync(cfgPath)) { return ''; }
  let section = '';
  for (const raw of fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }
    const kv = line.match(/^changes_dir\s*=\s*(.*)$/i);
    if (kv && section === 'dmcr') { return kv[1].trim(); }
  }
  return '';
}

/** The configured value, as written (may be relative). */
export function getChangesDirSetting(): string {
  const stored = findById<{ changesDir?: string }>('dmcr_config', 'main')?.changesDir?.trim();
  if (stored) { return stored; }
  let fromCfg = '';
  try { fromCfg = changesDirFromCfg(getUserCfgPath() ?? undefined); } catch { /* unreadable cfg */ }
  if (fromCfg) { return fromCfg; }
  return vscode.workspace.getConfiguration('dmcr').get<string>('changesDir', 'db/changes') || 'db/changes';
}

/** Absolute path of the changes folder, or '' when it is relative and no workspace is open. */
export function resolveChangesDir(): string {
  const dir = getChangesDirSetting();
  if (path.isAbsolute(dir)) { return dir; }
  const ws = vscode.workspace.workspaceFolders?.[0];
  return ws ? path.join(ws.uri.fsPath, dir) : '';
}

/** Like resolveChangesDir, but throws a message the UI can show. */
export function requireChangesDir(): string {
  const abs = resolveChangesDir();
  if (!abs) {
    throw new Error('The changes directory is a relative path and no workspace is open. Open the workspace or set an absolute path in Settings → DMCR Config.');
  }
  return abs;
}
