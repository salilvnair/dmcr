/**
 * Ctrl+V in a webview that may not read the clipboard (from daakia's paste bridge).
 *
 * Copy and Cut push text out and need no permission; paste pulls it in, and a VS Code webview often denies
 * `clipboard-read`, so Ctrl+V never becomes a `paste` event and nothing happens. This catches Ctrl+V (Cmd+V
 * on a Mac), gives the browser's own paste a moment, and only when none came reads the clipboard through
 * the extension host and inserts it: in Monaco as an edit, in an input, textarea or contenteditable with
 * insertText (keeps undo and raises the `input` React listens for). Exactly one insert either way: where the
 * native paste works (DMCR Web, most fields) it wins and the bridge stays out of it.
 */
import { readClipboard } from './read-clipboard';
import { monacoEditorOf, isReadOnly } from './monaco-instance';

/** How long the native paste gets: it comes in the same turn of the event loop when it comes at all */
const NATIVE_GRACE_MS = 40;

/** When the page last saw a real `paste` event that carried something */
let lastNativePaste = 0;

function isPasteCombo(e: KeyboardEvent): boolean {
  if (e.key !== 'v' && e.key !== 'V') { return false; }
  // Ctrl on Windows and Linux, Cmd on a Mac, never both; Ctrl+Shift+V and Ctrl+Alt+V are other shortcuts
  return e.ctrlKey !== e.metaKey && !e.shiftKey && !e.altKey;
}

/** The field the caret is in, when it can be typed into */
function editableTarget(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') { return null; }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    return field.readOnly || field.disabled ? null : el;
  }
  if (el.isContentEditable) { return el; }
  return el.closest('[contenteditable="true"]') as HTMLElement | null;
}

async function paste(e: KeyboardEvent): Promise<void> {
  const target = e.target as HTMLElement | null;
  // Monaco keeps its caret in a hidden textarea: a plain insert would land there, not in the document
  const editor = monacoEditorOf(target);
  const field = editor ? null : editableTarget(target);
  if (editor ? isReadOnly(editor) : !field) { return; }

  const armedAt = Date.now();
  await new Promise(r => setTimeout(r, NATIVE_GRACE_MS));
  if (lastNativePaste >= armedAt) { return; }

  const text = await readClipboard();
  if (!text) { return; }
  if (editor) {
    const selection = editor.getSelection();
    if (selection) { editor.executeEdits('paste-bridge', [{ range: selection, text, forceMoveMarkers: true }]); }
    return;
  }
  field!.focus();
  document.execCommand('insertText', false, text);
}

let installed = false;

/** Install the Ctrl+V bridge once per webview; returns the uninstall */
export function installPasteBridge(): () => void {
  if (installed) { return () => {}; }
  installed = true;
  const onKeyDown = (e: KeyboardEvent) => { if (isPasteCombo(e)) { void paste(e); } };
  // a real paste stands the bridge down; an empty one (clipboard-read denied) does not count
  const onPaste = (e: Event) => {
    const data = (e as ClipboardEvent).clipboardData;
    if (data && !data.getData('text/plain') && !data.files?.length) { return; }
    lastNativePaste = Date.now();
  };
  // capture: Monaco binds Ctrl+V itself and would consume it first
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('paste', onPaste, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('paste', onPaste, true);
    installed = false;
  };
}
