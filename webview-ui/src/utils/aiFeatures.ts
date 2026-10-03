/**
 * AI feature switches (Settings → AI Features), shared with the extension.
 *
 * The extension stores the list of turned-off features in SQLite and refuses to run them;
 * this hook lets each webview hide the matching buttons and skip automatic calls.
 * Features are identified by their Prompt Library scenario key (e.g. 'AI_CHANGE_EXPLAINER').
 */
import { useCallback, useEffect, useState } from 'react';
import { postMsg } from '../vscode';

/** Where older builds kept the switches (per webview, keyed by feature id like 'D18.1'). */
export const LEGACY_AI_FEATURES_KEY = 'dmcr:ai-features:enabled';

export interface AiFeaturesPayload { disabled: string[]; stored: boolean }

/** Listen for the extension's 'aiFeatures' message; returns an unsubscribe function. */
export function onAiFeatures(cb: (p: AiFeaturesPayload) => void): () => void {
  const handler = (e: MessageEvent) => {
    const m = e.data as { type?: string; payload?: AiFeaturesPayload };
    if (m?.type === 'aiFeatures' && m.payload) {
      cb({ disabled: Array.isArray(m.payload.disabled) ? m.payload.disabled : [], stored: !!m.payload.stored });
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

/**
 * Returns isOn(scenario). Everything counts as on until the extension answers, matching
 * the default. Re-asks when the webview regains focus, so a change made in Settings
 * reaches the Schema Explorer side view too.
 */
export function useAiFeatures(): (scenario: string) => boolean {
  const [disabled, setDisabled] = useState<string[]>([]);
  useEffect(() => {
    const off = onAiFeatures(p => setDisabled(p.disabled));
    const ask = () => postMsg({ type: 'getAiFeatures' });
    ask();
    window.addEventListener('focus', ask);
    return () => { off(); window.removeEventListener('focus', ask); };
  }, []);
  return useCallback((scenario: string) => !disabled.includes(scenario), [disabled]);
}
