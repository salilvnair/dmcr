import * as monaco from 'monaco-editor';

/**
 * Monaco loads each language's highlighter lazily, as its own chunk, the first time a model in that language is
 * created. Until the chunk arrives the editor shows plain uncoloured text, so the first SQL / JSON file opened
 * (change viewer, cards, Freeform) flashed white before its colours appeared. Creating a throwaway model per
 * language right after startup fetches those chunks up front; by the time an editor opens they are ready.
 */
export function warmMonacoLanguages(languages: string[] = ['sql', 'json']): void {
  const run = () => {
    for (const lang of languages) {
      try { monaco.editor.createModel('', lang).dispose(); } catch { /* a language Monaco does not know: nothing to warm */ }
    }
  };
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(run, { timeout: 1500 }); else setTimeout(run, 200);
}
