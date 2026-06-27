/**
 * LLM settings service for DMCR.
 * Manages active Copilot model family + custom provider selection.
 * Persists preferences to SQLite via db.ts.
 */
import * as vscode from 'vscode';
import { upsert, findById } from '../../../storage/db';
import { getAllCustomProviders } from './custom-providers';
import { getAllKeyStatus } from './secret-store';

const PREF_COLLECTION       = 'llm_prefs';
const ACTIVE_FAMILY_KEY     = 'activeFamily';
const ACTIVE_CUSTOM_KEY     = 'activeCustomProvider';

let _activeFamily: string | null = null;
let _activeCustomProviderKey: string | null = null;

/* ── Active family (Copilot) ─────────────────────────────────────── */

export function setActiveFamily(family: string) {
  _activeFamily = family;
  _activeCustomProviderKey = null;
}

export function getActiveFamily(): string {
  if (_activeFamily) return _activeFamily;
  if (_activeCustomProviderKey) {
    const providers = getAllCustomProviders();
    return providers.find(p => p.key === _activeCustomProviderKey)?.activeModel ?? '';
  }
  const stored = findById<{ family: string }>(PREF_COLLECTION, ACTIVE_FAMILY_KEY);
  return stored?.family ?? '';
}

/* ── Active custom provider ──────────────────────────────────────── */

export function setActiveCustomProvider(key: string | null) {
  _activeCustomProviderKey = key;
  if (key) _activeFamily = null;
}

export function getActiveCustomProviderKey(): string | null {
  return _activeCustomProviderKey;
}

export function getActiveProviderKey(): string {
  return _activeCustomProviderKey ?? 'copilot';
}

/* ── Persist & restore from DB ───────────────────────────────────── */

export function saveActiveFamilyToDb(family: string) {
  setActiveFamily(family);
  upsert(PREF_COLLECTION, ACTIVE_FAMILY_KEY, { family });
}

export function saveActiveCustomProviderToDb(key: string | null) {
  setActiveCustomProvider(key);
  upsert(PREF_COLLECTION, ACTIVE_CUSTOM_KEY, { key });
}

/** Call once after initDb() to restore the last saved selection. */
export function loadActiveFamilyFromDb() {
  const stored = findById<{ family: string }>(PREF_COLLECTION, ACTIVE_FAMILY_KEY);
  if (stored?.family) setActiveFamily(stored.family);

  const storedCustom = findById<{ key: string }>(PREF_COLLECTION, ACTIVE_CUSTOM_KEY);
  if (storedCustom?.key) setActiveCustomProvider(storedCustom.key);
}

/* ── Available Copilot models ────────────────────────────────────── */

export interface CopilotModelInfo {
  id: string;
  label: string;
  family: string;
}

export async function getAvailableCopilotModels(): Promise<CopilotModelInfo[]> {
  let lmModels: readonly vscode.LanguageModelChat[] = [];
  try {
    lmModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    // lm API not available
  }

  const seen = new Set<string>();
  const models: CopilotModelInfo[] = [];
  for (const m of lmModels) {
    const id = m.family || m.id;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: m.name, family: id });
  }
  return models;
}

/* ── Full provider snapshot (for settings panel) ─────────────────── */

export async function getSettingsSnapshot() {
  const copilotModels = await getAvailableCopilotModels();
  const allProviders = getAllCustomProviders();
  const keyStatus = await getAllKeyStatus(allProviders.map(p => p.key));
  const customProviders = allProviders.map((p) => ({
    key: p.key,
    name: p.name,
    type: p.type,
    chatUrl: p.chatUrl,
    modelsUrl: p.modelsUrl,
    headers: p.headers ?? {},
    activeModel: p.activeModel ?? '',
    cachedModels: p.cachedModels ?? [],
    hasApiKey: keyStatus[p.key] ?? false,
    // apiKey intentionally omitted
  }));

  return {
    activeProvider: getActiveProviderKey(),
    activeFamily:   getActiveFamily(),
    copilot: {
      models: copilotModels,
    },
    customProviders,
  };
}
