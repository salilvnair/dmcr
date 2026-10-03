/**
 * DmcrPanel — main VS Code editor panel (WebviewPanel).
 *
 * Opened by clicking the DMCR activity-bar icon.
 *
 * Message handling is delegated to handler modules under ./handlers/.
 * This file contains only the panel lifecycle (create, dispose, HTML)
 * and the thin dispatch layer.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  handleFormMessage,
  handleChatMessage,
  handleSettingsMessage,
  handleRunnerMessage,
  handleMcpMessage,
  handleDataMessage,
  handleConfigMessage,
} from "./handlers";
import type { HandlerContext, PanelState } from "./handlers";

/* ══════════════════════════════════════════════════════════
   DmcrPanel
══════════════════════════════════════════════════════════ */
export class DmcrPanel {
  public static currentPanel: DmcrPanel | undefined;
  /** VS Code extension context — stored once on first createOrShow for SecretStorage access */
  private static _context: vscode.ExtensionContext | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _extensionPath: string;
  private _disposables: vscode.Disposable[] = [];
  /** If true, this panel is a secondary "new tab" instance — not the singleton */
  private _isSecondary = false;

  /** Shared mutable state — handlers read/write through this reference. */
  private _state: PanelState = {
    activeFormType: null,
    pendingGenerations: {},
    inlineConvSessionStartId: 0,
  };

  /** Guard: re-apply HTML once on first visible layout to work around VS Code
   *  not painting webview content when the panel is created during activate(). */
  private _initialRenderDone = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._extensionPath = extensionUri.fsPath;

    this._panel.webview.html = this._getHtml();

    // VS Code may not paint webview HTML set during activate() until a layout
    // event occurs. Re-apply after a microtask so the event loop completes first.
    const ensureRender = setTimeout(() => {
      if (!this._initialRenderDone) {
        this._initialRenderDone = true;
        this._panel.webview.html = this._getHtml();
      }
    }, 80);

    this._panel.onDidChangeViewState(() => {
      if (!this._initialRenderDone && this._panel.visible) {
        this._initialRenderDone = true;
        clearTimeout(ensureRender);
        this._panel.webview.html = this._getHtml();
      }
    }, null, this._disposables);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      undefined,
      this._disposables,
    );
  }

  public static createOrShow(extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
    if (context) DmcrPanel._context = context;
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;

    if (DmcrPanel.currentPanel) {
      DmcrPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "dmcr.panel",
      "DMCR",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "webview", "dist"),
          vscode.Uri.joinPath(extensionUri, "images"),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "images", "dmcr_bot.png");
    DmcrPanel.currentPanel = new DmcrPanel(panel, extensionUri);
  }

  /**
   * Open a specific form/tab in a new editor column (non-singleton).
   * Used for "Open in New Tab" context-menu action.
   */
  public static openInNewTab(extensionUri: vscode.Uri, form: string, context?: vscode.ExtensionContext) {
    if (context) DmcrPanel._context = context;

    const FORM_LABELS: Record<string, string> = {
      ddl: 'DDL', insert: 'DML', freeform: 'Freeform', schema_diff: 'Schema Diff',
      conversation: 'Assistant', runner: 'Runner', settings: 'Settings', home: 'Home',
    };

    const panel = vscode.window.createWebviewPanel(
      "dmcr.panel.tab",
      `DMCR — ${FORM_LABELS[form] || form}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "webview", "dist"),
          vscode.Uri.joinPath(extensionUri, "images"),
        ],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "images", "dmcr_bot.png");

    // Create a full DmcrPanel instance (independent, non-singleton) for message handling
    const instance = new DmcrPanel(panel, extensionUri);
    instance._isSecondary = true;
    // Don't assign to currentPanel — this is independent

    // Once webview is ready, navigate to the requested tab
    const readyDisposable = panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg.type === 'ready') {
        panel.webview.postMessage({ type: 'navigateToTab', payload: { tab: form } });
        readyDisposable.dispose();
      }
    });
  }

  public dispose() {
    if (!this._isSecondary) DmcrPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }

  /** Send a message to the webview */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public postMessage(msg: Record<string, any>) {
    this._panel.webview.postMessage(msg);
  }

  /* ── Build a context object that all handler modules share ── */
  private _buildHandlerContext(): HandlerContext {
    return {
      webview: this._panel.webview,
      extensionUri: this._extensionUri,
      extensionPath: this._extensionPath,
      disposables: this._disposables,
      state: this._state,
      extensionContext: DmcrPanel._context,
    };
  }

  /* ── Thin dispatch — delegates to handler modules ── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _handleMessage(msg: { type: string; payload?: any }) {
    const ctx = this._buildHandlerContext();
    if (await handleFormMessage(ctx, msg)) return;
    if (await handleChatMessage(ctx, msg)) return;
    if (await handleSettingsMessage(ctx, msg)) return;
    if (await handleRunnerMessage(ctx, msg)) return;
    if (await handleMcpMessage(ctx, msg)) return;
    if (await handleDataMessage(ctx, msg)) return;
    if (await handleConfigMessage(ctx, msg)) return;
  }

  /* ── HTML bootstrap ── */

  private _getHtml(): string {
    const webview = this._panel.webview;
    const distPath = path.join(this._extensionUri.fsPath, "webview", "dist");
    // Vite preserves the input subdirectory in the output, so the HTML
    // lands at dist/webview-ui/index.html (assets at dist/assets/ via ../assets/)
    const htmlDir  = path.join(distPath, "webview-ui");
    const indexPath = path.join(htmlDir, "index.html");

    if (!fs.existsSync(indexPath)) {
      return this._placeholderHtml();
    }

    let html = fs.readFileSync(indexPath, "utf8");

    // Rewrite asset paths to vscode-resource:// URIs
    html = html.replace(/(src|href)="((?:\.\.\/|\.\/|\/)[^"]+)"/g, (_match: string, attr: string, assetPath: string) => {
      let filePath: string;
      if (assetPath.startsWith("/")) {
        filePath = path.join(distPath, assetPath.slice(1));
      } else {
        filePath = path.resolve(htmlDir, assetPath);
      }
      const resourceUri = webview.asWebviewUri(vscode.Uri.file(filePath));
      return `${attr}="${resourceUri}"`;
    });

    html = html.replace(/\s+crossorigin/g, "");

    // Inject runtime bootstrap before </head>
    const injectScript = `<script>
  try { window.__DMCR_VSCODE_API__ = acquireVsCodeApi(); } catch(e) {}
  window.__DMCR_MODE__ = 'vscode-extension';
</script>`;
    html = html.replace("</head>", `${injectScript}\n</head>`);

    // CSP — replace existing tag if present, otherwise insert after <head>
    const csp = [
      `default-src 'none'`,
      `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'`,
      `style-src  ${webview.cspSource} 'unsafe-inline'`,
      `font-src   ${webview.cspSource} data:`,
      `img-src    ${webview.cspSource} data: https: blob:`,
      `connect-src 'none'`,
      `frame-src * blob: data:`,
      `child-src * blob: data:`,
    ].join("; ");

    html = html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
    if (!html.includes("Content-Security-Policy")) {
      html = html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    }

    return html;
  }

  private _placeholderHtml(): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<style>
  body { background:#111113; color:#888; font-family:system-ui,sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .box { text-align:center; }
  h2 { color:#7c6af7; margin-bottom:8px; }
  p  { font-size:12px; }
  code { background:#1c1c1f; padding:2px 6px; border-radius:4px; font-size:11px; }
</style>
</head><body>
<div class="box">
  <h2>DMCR</h2>
  <p>Webview not built yet.</p>
  <p>Run <code>npm run build:webview</code> and reload the extension.</p>
</div>
</body></html>`;
  }
}
