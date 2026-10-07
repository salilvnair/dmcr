/**
 * QuickAccessViewProvider — styled webview in the DMCR activity-bar sidebar.
 * Shows quick-action buttons with colorful styling matching the wiki panel.
 */
import * as vscode from 'vscode';

export class QuickAccessViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'dmcr.canvasView';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  get view() { return this._view; }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'images')],
    };

    const botUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'images', 'dmcr_bot.png'),
    );

    // Register the message handler BEFORE setting HTML
    webviewView.webview.onDidReceiveMessage((msg: { command: string; arg?: string }) => {
      if (msg.command) {
        if (msg.arg !== undefined) {
          vscode.commands.executeCommand(msg.command, msg.arg);
        } else {
          vscode.commands.executeCommand(msg.command);
        }
      }
    });

    webviewView.webview.html = this._getHtml(webviewView.webview, botUri);

    // Re-set HTML when the view becomes visible again (prevents empty sidebar)
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        webviewView.webview.html = this._getHtml(webviewView.webview, botUri);
      }
    });
  }

  private _getHtml(webview: vscode.Webview, botUri: vscode.Uri): string {
    const nonce = this._getNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  :root {
    --bg:       var(--vscode-sideBar-background, #1e1e1e);
    --fg:       var(--vscode-sideBarForeground, #cccccc);
    --muted:    var(--vscode-descriptionForeground, #888);
    --accent:   var(--vscode-textLink-foreground, #6366f1);
    --border:   var(--vscode-widget-border, #3c3c3c);
    --code-bg:  var(--vscode-textCodeBlock-background, #2d2d2d);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-size: 12px; font-family: var(--vscode-font-family, system-ui, sans-serif);
    line-height: 1.6; padding: 10px 12px 16px; overflow-y: auto;
  }

  .qa-hero {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 12px;
  }
  .qa-hero img { width: 36px; height: 36px; object-fit: contain; border-radius: 8px; flex-shrink: 0; }
  .qa-hero-title { font-size: 14px; font-weight: 700; color: var(--accent); }

  .qa-grid {
    display: flex; flex-direction: column; gap: 6px;
    margin-bottom: 14px;
  }

  .qa-btn {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 9px 12px;
    border-radius: 8px; border: 1px solid var(--border);
    background: var(--code-bg);
    color: var(--fg); font-size: 12px; font-weight: 500;
    font-family: inherit; cursor: pointer;
    transition: all 150ms;
    text-align: left;
  }
  .qa-btn:hover {
    border-color: var(--accent);
    background: rgba(99,102,241,0.10);
    color: #c7d2fe;
  }

  .qa-btn-icon {
    width: 28px; height: 28px; border-radius: 7px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
  }
  .qa-btn-icon--db   { background: rgba(99,102,241,0.14); color: #818cf8; }
  .qa-btn-icon--chat { background: rgba(168,85,247,0.14); color: #c084fc; }
  .qa-btn-icon--gear { background: rgba(251,191,36,0.14); color: #fbbf24; }
  .qa-btn-icon--fold { background: rgba(52,211,153,0.14); color: #34d399; }

  .qa-btn-text { display: flex; flex-direction: column; gap: 1px; }
  .qa-btn-label { font-weight: 600; font-size: 12px; }
  .qa-btn-desc { font-size: 10.5px; color: var(--muted); font-weight: 400; }

  .qa-divider {
    border: none; border-top: 1px solid var(--border);
    margin: 10px 0;
  }

  .qa-tip {
    display: flex; gap: 7px; padding: 8px 10px; border-radius: 6px;
    background: rgba(99,102,241,0.08);
    border: 1px solid rgba(99,102,241,0.15);
    font-size: 11px; color: var(--muted); line-height: 1.5;
  }
  .qa-tip-icon { font-size: 13px; flex-shrink: 0; }
  .qa-tip code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--code-bg); color: var(--accent);
    padding: 1px 4px; border-radius: 3px; font-size: 10.5px;
  }
  .qa-tip strong { color: var(--fg); }
</style>
</head>
<body>

<div class="qa-hero">
  <img src="${botUri}" alt="DMCR" width="36" height="36" style="border-radius:8px;flex-shrink:0;"/>
  <span class="qa-hero-title">DMCR</span>
</div>

<div class="qa-grid">
  <button class="qa-btn" id="btnOpen">
    <span class="qa-btn-icon qa-btn-icon--db"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg></span>
    <span class="qa-btn-text">
      <span class="qa-btn-label">Open Change Builder</span>
      <span class="qa-btn-desc">DDL · DML · Freeform SQL</span>
    </span>
  </button>

  <button class="qa-btn" id="btnConv">
    <span class="qa-btn-icon qa-btn-icon--chat"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
    <span class="qa-btn-text">
      <span class="qa-btn-label">Open Conversation</span>
      <span class="qa-btn-desc">Chat with Copilot to build DMCR changes</span>
    </span>
  </button>

  <button class="qa-btn" id="btnSettings">
    <span class="qa-btn-icon qa-btn-icon--gear"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></span>
    <span class="qa-btn-text">
      <span class="qa-btn-label">DMCR Settings</span>
      <span class="qa-btn-desc">LLM provider, change folder config</span>
    </span>
  </button>

  <button class="qa-btn" id="btnDbLoc">
    <span class="qa-btn-icon qa-btn-icon--fold"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
    <span class="qa-btn-text">
      <span class="qa-btn-label">Change DB Location</span>
      <span class="qa-btn-desc">Set SQLite storage path</span>
    </span>
  </button>

  <button class="qa-btn" id="btnExplorer">
    <span class="qa-btn-icon qa-btn-icon--db"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
    <span class="qa-btn-text">
      <span class="qa-btn-label">Schema Explorer</span>
      <span class="qa-btn-desc">Browse DB schemas, tables & columns via MCP</span>
    </span>
  </button>
</div>

<hr class="qa-divider"/>

<div class="qa-tip">
  <span>Use <code>@dmcr</code> in Copilot Chat or click 
  <span class="qa-tip-icon" style="display:inline-flex;align-items:center;vertical-align:middle;">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="8" cy="4" rx="6" ry="2.5" fill="none" stroke="#6366f1" stroke-width="1.2"/>
      <path d="M2 4v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V4" stroke="#6366f1" stroke-width="1.2" fill="none"/>
      <path d="M2 8v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V8" stroke="#6366f1" stroke-width="1.2" fill="none"/>
    </svg>
  </span>
  <strong> DMCR</strong> in the status bar (bottom-right).</span>
</div>

<script nonce="\${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const commands = {
      btnOpen: 'dmcr.open',
      btnConv: 'dmcr.conversation',
      btnSettings: 'workbench.action.openSettings',
      btnDbLoc: 'dmcr.changeDbLocation',
      btnExplorer: 'dmcr.openSchemaExplorer',
    };
    document.body.addEventListener('click', function(e) {
      var btn = e.target;
      while (btn && btn !== document.body) {
        if (btn.classList && btn.classList.contains('qa-btn')) break;
        btn = btn.parentElement;
      }
      if (!btn || !btn.id || !commands[btn.id]) return;
      var msg = { command: commands[btn.id] };
      if (btn.id === 'btnSettings') msg.arg = 'dmcr';
      vscode.postMessage(msg);
    });
  })();
</script>
</body>
</html>`;
  }

  private _getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
  }
}
