/**
 * runner-paths.ts
 * ───────────────
 * Where the runner's user-editable files live.
 *
 * The scripts (dmcr.ps1 / dmcr.sh / dmcr_change_log_ddl.sql) ship read-only inside
 * the extension at `<extension>/scripts/runner/`. User-edited files — `dmcr.cfg`
 * and `dmcr_danger.json` — live in the extension's global storage so they survive
 * extension updates and never require write access to the install directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

let _userRunnerDir: string | null = null;
let _bundledRunnerDir: string | null = null;

/**
 * Call once at activation. Creates the user runner directory and, on first run,
 * copies any dmcr.cfg / dmcr_danger.json found in the extension folder (where
 * older versions wrote them) so existing settings are kept.
 */
export function initRunnerPaths(context: vscode.ExtensionContext): void {
  _bundledRunnerDir = path.join(context.extensionPath, 'scripts', 'runner');
  _userRunnerDir = path.join(context.globalStorageUri.fsPath, 'runner');
  try {
    fs.mkdirSync(_userRunnerDir, { recursive: true });
    for (const name of ['dmcr.cfg', 'dmcr_danger.json']) {
      const legacy = path.join(_bundledRunnerDir, name);
      const target = path.join(_userRunnerDir, name);
      if (!fs.existsSync(target) && fs.existsSync(legacy)) {
        fs.copyFileSync(legacy, target);
      }
    }
  } catch (err) {
    console.warn('[dmcr] could not prepare runner directory:', err);
  }
}

/** Read-only directory holding the bundled runner scripts. */
export function getBundledRunnerDir(): string | null {
  return _bundledRunnerDir;
}

/** Writable directory for dmcr.cfg and dmcr_danger.json. */
export function getUserRunnerDir(): string | null {
  return _userRunnerDir;
}

export function getUserCfgPath(): string | null {
  return _userRunnerDir ? path.join(_userRunnerDir, 'dmcr.cfg') : null;
}

export function getUserDangerRulesPath(): string | null {
  return _userRunnerDir ? path.join(_userRunnerDir, 'dmcr_danger.json') : null;
}
