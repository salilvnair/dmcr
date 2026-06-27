/**
 * danger-rules.ts
 * ──────────────
 * Reads and writes `dmcr_danger.json` in the workspace root.
 * This file defines which SQL patterns are considered "dangerous" and require
 * a `danger_` folder prefix.  It mirrors the logic in dmcr.ps1 v2 and can be
 * committed alongside the project so the rules are version-controlled.
 *
 * dmcr.ps1 reads this file on startup (if present) and uses it to override
 * its built-in $DangerDeployOnlyPatterns / $DangerAlwaysPatterns.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Extension path (set once at activation) ────────────────────────────────

let _extensionPath: string | null = null;

/** Call once at activation to tell danger-rules where the extension lives. */
export function initDangerRulesDir(extensionPath: string): void {
  _extensionPath = extensionPath;
}

// ─── Default rule sets (mirrors dmcr.ps1 built-ins) ─────────────────────────

export interface DangerRule {
  /** Human-readable label shown in the UI and in dmcr.ps1 messages. */
  label: string;
  /** Case-insensitive regex fragment used by dmcr.ps1 (PowerShell regex syntax). */
  regex: string;
  /**
   * When to enforce: "deployOnly" = only in deploy.sql (safe to have in revert.sql),
   * "always" = blocked in both deploy.sql and revert.sql.
   */
  scope: 'deployOnly' | 'always';
  /** Whether this rule is active. Defaults to true when absent. */
  enabled?: boolean;
}

export interface DangerRulesFile {
  /** Rules that are only dangerous in deploy.sql (DROP DDL etc.). */
  deployOnlyPatterns: DangerRule[];
  /** Rules blocked in both deploy.sql and revert.sql (e.g. TRUNCATE). */
  alwaysPatterns: DangerRule[];
  /** Whether DELETE without WHERE is blocked in deploy.sql. */
  deleteWithoutWhereEnabled: boolean;
  /** Whether UPDATE without WHERE is blocked in deploy.sql. */
  updateWithoutWhereEnabled: boolean;
}

export const DEFAULT_DANGER_RULES: DangerRulesFile = {
  deployOnlyPatterns: [
    { label: 'DROP TABLE',     regex: '(?i)\\bDROP\\s+TABLE\\b',     scope: 'deployOnly' },
    { label: 'DROP SCHEMA',    regex: '(?i)\\bDROP\\s+SCHEMA\\b',    scope: 'deployOnly' },
    { label: 'DROP DATABASE',  regex: '(?i)\\bDROP\\s+DATABASE\\b',  scope: 'deployOnly' },
    { label: 'DROP FUNCTION',  regex: '(?i)\\bDROP\\s+FUNCTION\\b',  scope: 'deployOnly' },
    { label: 'DROP PROCEDURE', regex: '(?i)\\bDROP\\s+PROCEDURE\\b', scope: 'deployOnly' },
    { label: 'DROP VIEW',      regex: '(?i)\\bDROP\\s+VIEW\\b',      scope: 'deployOnly' },
    { label: 'DROP TRIGGER',   regex: '(?i)\\bDROP\\s+TRIGGER\\b',   scope: 'deployOnly' },
    { label: 'DROP INDEX',     regex: '(?i)\\bDROP\\s+INDEX\\b',     scope: 'deployOnly' },
    { label: 'DROP SEQUENCE',  regex: '(?i)\\bDROP\\s+SEQUENCE\\b',  scope: 'deployOnly' },
    { label: 'DROP TYPE',      regex: '(?i)\\bDROP\\s+TYPE\\b',      scope: 'deployOnly' },
    { label: 'DROP EXTENSION', regex: '(?i)\\bDROP\\s+EXTENSION\\b', scope: 'deployOnly' },
  ],
  alwaysPatterns: [
    { label: 'TRUNCATE', regex: '(?i)\\bTRUNCATE\\b', scope: 'always' },
  ],
  deleteWithoutWhereEnabled: true,
  updateWithoutWhereEnabled: false,
};

// ─── File path helpers ───────────────────────────────────────────────────────

/**
 * Returns the danger rules directory — always the extension's own scripts/runner folder.
 * This ensures dmcr_danger.json lives alongside dmcr.ps1 and ships with the VSIX.
 */
export function getDangerRulesDir(): string | null {
  if (_extensionPath) return path.join(_extensionPath, 'scripts', 'runner');
  return null;
}

function getDangerRulesPath(): string | null {
  const dir = getDangerRulesDir();
  if (!dir) return null;
  return path.join(dir, 'dmcr_danger.json');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Load dmcr_danger.json from the configured directory.  Returns defaults if not found. */
export function loadDangerRules(): DangerRulesFile {
  const filePath = getDangerRulesPath();
  if (!filePath) return structuredClone(DEFAULT_DANGER_RULES);

  try {
    if (!fs.existsSync(filePath)) return structuredClone(DEFAULT_DANGER_RULES);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DangerRulesFile>;
    // Merge with defaults so new fields added in future versions are back-filled
    return {
      deployOnlyPatterns: parsed.deployOnlyPatterns ?? DEFAULT_DANGER_RULES.deployOnlyPatterns,
      alwaysPatterns:     parsed.alwaysPatterns     ?? DEFAULT_DANGER_RULES.alwaysPatterns,
      deleteWithoutWhereEnabled: parsed.deleteWithoutWhereEnabled ?? DEFAULT_DANGER_RULES.deleteWithoutWhereEnabled,
      updateWithoutWhereEnabled: parsed.updateWithoutWhereEnabled ?? DEFAULT_DANGER_RULES.updateWithoutWhereEnabled,
    };
  } catch {
    return structuredClone(DEFAULT_DANGER_RULES);
  }
}

/** Save dmcr_danger.json to the configured directory. */
export function saveDangerRules(rules: DangerRulesFile): void {
  const dir = getDangerRulesDir();
  if (!dir) throw new Error('Cannot determine danger rules directory. Extension path not set.');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dmcr_danger.json'), JSON.stringify(rules, null, 2), 'utf8');
}

/** Reset dmcr_danger.json to built-in defaults. */
export function resetDangerRules(): DangerRulesFile {
  const defaults = structuredClone(DEFAULT_DANGER_RULES);
  saveDangerRules(defaults);
  return defaults;
}
