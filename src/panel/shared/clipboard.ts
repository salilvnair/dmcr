/**
 * The clipboard, read where it can be read.
 *
 * A VS Code webview is often denied `clipboard-read`: Ctrl+V does nothing in Monaco and a menu's Paste gets
 * nothing from `navigator.clipboard.readText()`. The extension host has no such limit, so the webview asks
 * here (`clipboard:read`) and gets the text back (`clipboard:text`). See webview-ui/src/services/clipboard.
 */
import * as vscode from 'vscode';

/** Answers a webview's `clipboard:read`; true when the message was one */
export function answerClipboardRead(webview: vscode.Webview, msg: { type?: string; requestId?: unknown } | undefined): boolean {
  if (msg?.type !== 'clipboard:read') { return false; }
  const requestId = String(msg.requestId ?? '');
  void vscode.env.clipboard.readText().then(
    text => webview.postMessage({ type: 'clipboard:text', requestId, text }),
    () => webview.postMessage({ type: 'clipboard:text', requestId, text: '', failed: true }),
  );
  return true;
}
