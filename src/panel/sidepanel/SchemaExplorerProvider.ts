/**
 * SchemaExplorerProvider — WebviewViewProvider that serves the React-based
 * SchemaExplorerPage in the sidebar. Data fetching is handled by mcp-handlers.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { handleMcpMessage } from '../main/handlers/mcp-handlers';
import { handleDataMessage } from '../main/handlers/data-handlers';
import type { HandlerContext, Message, PanelState } from '../main/handlers/types';

export class SchemaExplorerProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'dmcr.schemaExplorer';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  refresh(): void {
    if (this._view) {
      this._view.webview.postMessage({ type: 'schemaExplorerRefresh' });
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    const distPath = path.join(this._extensionUri.fsPath, 'webview', 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(distPath),
        vscode.Uri.joinPath(this._extensionUri, 'images'),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview, distPath);

    // Route messages through mcp-handlers
    webviewView.webview.onDidReceiveMessage(async (msg: Message) => {
      const ctx: HandlerContext = {
        webview: webviewView.webview,
        extensionUri: this._extensionUri,
        extensionPath: this._extensionUri.fsPath,
        disposables: [],
        state: { activeFormType: null, pendingGeneration: null, inlineConvSessionStartId: 0 } as PanelState,
        extensionContext: undefined,
      };
      if (await handleMcpMessage(ctx, msg)) return;
      await handleDataMessage(ctx, msg);
    });
  }

  private _getHtml(webview: vscode.Webview, distPath: string): string {
    const htmlDir = path.join(distPath, 'webview-ui');
    const indexPath = path.join(htmlDir, 'schema-explorer.html');

    if (!fs.existsSync(indexPath)) {
      return `<html><body><p style="padding:16px;color:#94a3b8;">Schema Explorer not built yet. Run the Vite build.</p></body></html>`;
    }

    let html = fs.readFileSync(indexPath, 'utf8');

    // Rewrite asset paths to vscode-resource URIs
    html = html.replace(/(src|href)="((?:\.\.\/|\.\/|\/)[^"]+)"/g, (_match: string, attr: string, assetPath: string) => {
      let filePath: string;
      if (assetPath.startsWith('/')) {
        filePath = path.join(distPath, assetPath.slice(1));
      } else {
        filePath = path.resolve(htmlDir, assetPath);
      }
      const resourceUri = webview.asWebviewUri(vscode.Uri.file(filePath));
      return `${attr}="${resourceUri}"`;
    });

    html = html.replace(/\s+crossorigin/g, '');

    // Inject vscode API bootstrap
    const injectScript = `<script>
  try { window.__DMCR_VSCODE_API__ = acquireVsCodeApi(); } catch(e) {}
  window.__DMCR_MODE__ = 'vscode-extension';
</script>`;
    html = html.replace('</head>', `${injectScript}\n</head>`);

    // CSP
    const csp = [
      `default-src 'none'`,
      `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'`,
      `style-src  ${webview.cspSource} 'unsafe-inline'`,
      `font-src   ${webview.cspSource} data:`,
      `img-src    ${webview.cspSource} data: https: blob:`,
      `connect-src 'none'`,
    ].join('; ');
    const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
    html = html.replace('<head>', `<head>\n${cspTag}`);

    return html;
  }
}
