/**
 * DmcrWikiViewProvider — serves the React-based WikiPanel in the sidebar.
 * The webview content is built by Vite (wiki.html entry point).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class DmcrWikiViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'dmcr.wikiView';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const distPath = path.join(this._extensionUri.fsPath, 'webview', 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(distPath),
        vscode.Uri.joinPath(this._extensionUri, 'images'),
      ],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview, distPath);

    webviewView.webview.onDidReceiveMessage((msg: { type?: string; payload?: { command?: string } }) => {
      if (msg.type === 'executeCommand' && msg.payload?.command) {
        void vscode.commands.executeCommand(msg.payload.command);
      }
    });
  }

  private _getHtml(webview: vscode.Webview, distPath: string): string {
    const htmlDir = path.join(distPath, 'webview-ui');
    const indexPath = path.join(htmlDir, 'wiki.html');

    if (!fs.existsSync(indexPath)) {
      return `<html><body><p style="padding:16px;color:#94a3b8;">Wiki panel not built yet. Run the Vite build.</p></body></html>`;
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