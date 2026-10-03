/**
 * On/off switches for the AI power features (Settings → AI Features).
 *
 * Stored in SQLite (ui_state/ai_features) so every DMCR webview — the main panel and the
 * Schema Explorer side view — and the extension itself see the same switches. Only the
 * turned-off features are stored; everything else is on.
 */
import { findById, upsert } from './db';
import { SCENARIO_LABELS, type PromptScenario } from './prompt-library';

const COLLECTION = 'ui_state';
const DOC_ID = 'ai_features';

interface AiFeatureToggles { disabled: string[] }

/** Whether the user has ever saved the switches (used to migrate the old per-webview copy). */
export function hasStoredAiFeatureToggles(): boolean {
  return !!findById<AiFeatureToggles>(COLLECTION, DOC_ID);
}

export function getDisabledAiFeatures(): string[] {
  const doc = findById<AiFeatureToggles>(COLLECTION, DOC_ID);
  return Array.isArray(doc?.disabled) ? doc!.disabled.filter(s => typeof s === 'string') : [];
}

export function saveDisabledAiFeatures(disabled: string[]): void {
  upsert(COLLECTION, DOC_ID, { disabled: [...new Set(disabled.filter(s => typeof s === 'string'))] });
}

export function isAiFeatureEnabled(scenario: PromptScenario): boolean {
  return !getDisabledAiFeatures().includes(scenario);
}

/** Throws when the feature is turned off, so the handler's own catch reports it to the UI. */
export function assertAiFeatureEnabled(scenario: PromptScenario): void {
  if (!isAiFeatureEnabled(scenario)) {
    const label = SCENARIO_LABELS[scenario] ?? scenario;
    throw new Error(`${label} is turned off. Turn it on in Settings → AI Features.`);
  }
}
