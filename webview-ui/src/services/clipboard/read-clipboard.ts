/**
 * Read the clipboard from the one place that is allowed to.
 *
 * A VS Code webview often denies `clipboard-read` and cannot ask for it: `navigator.clipboard.readText()`
 * rejects and paste silently does nothing. The extension host can always read it
 * (`vscode.env.clipboard.readText()`), so the host is asked first and the browser API is the fallback.
 * DMCR Web's host has no clipboard and refuses at once, so there the browser answers (as in daakia).
 */
import { postMsg } from '../../vscode';

/** Long enough for a round trip to the host, short enough not to feel stuck */
const TIMEOUT_MS = 1500;

let seq = 0;

/** The host's answer, or null when it refused or did not answer in time */
function fromHost(): Promise<string | null> {
  return new Promise(resolve => {
    const requestId = `clip-${++seq}-${Date.now()}`;
    let done = false;
    const finish = (value: string | null) => {
      if (done) { return; }
      done = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      resolve(value);
    };
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type !== 'clipboard:text' || msg.requestId !== requestId) { return; }
      finish(msg.failed ? null : String(msg.text ?? ''));
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    window.addEventListener('message', handler);
    postMsg({ type: 'clipboard:read', requestId });
  });
}

export async function readClipboard(): Promise<string> {
  const hosted = await fromHost();
  if (hosted !== null) { return hosted; }
  try { return await navigator.clipboard.readText(); } catch { return ''; }
}
