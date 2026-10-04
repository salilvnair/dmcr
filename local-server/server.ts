/**
 * DMCR Web — the DMCR UI in a browser, driven by the same backend code as the VS Code
 * extension (src/panel/main/handlers/*, src/storage/*, the runners in scripts/runner).
 *
 *   npm run web                      → http://127.0.0.1:7799
 *
 * The webview bundle (webview/dist) is served as-is, with a small bridge injected that
 * stands in for acquireVsCodeApi(): messages go to this server over a WebSocket, and the
 * replies come back as window 'message' events — exactly what the page gets inside VS Code.
 * `vscode` itself is replaced by local-server/vscode-shim.ts at bundle time.
 *
 * AI: no Copilot outside VS Code. If the .env (DMCR_WEB_ENV_FILE, else the repo's .env) has
 * DEEPSEEK_API_KEY, DeepSeek is set up as the active provider; key names only are logged.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
// The shim by path: at bundle time `vscode` (imported by src/) resolves to this same file.
import { Uri, workspace, WEB_HOME, WORKSPACE_DIR, fileSecretStorage, fileMemento, webHooks } from './vscode-shim';

import { initDb, getRawDb, getDbPath, closeDb } from '../src/storage/db';
import { initPromptLibraryDb } from '../src/storage/prompt-library';
import { initRunnerPaths } from '../src/storage/runner-paths';
import { initDangerRulesDir } from '../src/storage/danger-rules';
import { initSecretStore, migrateLegacyApiKeys } from '../src/services/llm/core/secret-store';
import { migrateProviderHeaders, saveCustomProvider, getAllCustomProviders, fetchAndCacheModels } from '../src/services/llm/core/custom-providers';
import { loadActiveFamilyFromDb, saveActiveCustomProviderToDb } from '../src/services/llm/core/llm-settings';
import { initMcpService, initMcpSecrets, disposeMcpService } from '../src/services/mcp/server/mcp';
import {
  handleFormMessage, handleChatMessage, handleSettingsMessage, handleRunnerMessage,
  handleMcpMessage, handleDataMessage, handleConfigMessage,
  type HandlerContext, type Message, type PanelState,
} from '../src/panel/main/handlers';

const PORT = Number(process.env.DMCR_WEB_PORT) || 7799;
// The bundle runs from local-server/dist/server.js; the repo root is two levels up.
const REPO = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO, 'webview', 'dist');

// ─── .env (DeepSeek) ───────────────────────────────────────────────────────────
function readEnvFile(): Record<string, string> {
  const file = process.env.DMCR_WEB_ENV_FILE || path.join(REPO, '.env');
  if (!fs.existsSync(file)) { return {}; }
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) { out[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
  }
  console.log(`[dmcr-web] .env ${file}: ${Object.keys(out).join(', ') || '(empty)'}`);
  return out;
}

/** DeepSeek from .env becomes the active provider (key goes to the secret store only). */
async function setUpDeepSeek(env: Record<string, string>) {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) { console.log('[dmcr-web] no DEEPSEEK_API_KEY — AI features need a provider in Settings → LLM Provider'); return; }
  const base = (env.DEEPSEEK_API_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';
  const existing = getAllCustomProviders().find(p => p.key === 'deepseek');
  await saveCustomProvider({
    key: 'deepseek', name: 'DeepSeek', type: 'deepseek',
    chatUrl: `${base}/chat/completions`, modelsUrl: `${base}/models`,
    apiKey: key, headers: existing?.headers ?? {}, activeModel: model,
    cachedModels: existing?.cachedModels,
  } as never);
  try { await fetchAndCacheModels('deepseek'); } catch (e) { console.warn(`[dmcr-web] DeepSeek model list: ${e instanceof Error ? e.message : e}`); }
  saveActiveCustomProviderToDb('deepseek');
  console.log(`[dmcr-web] AI provider: DeepSeek (${model})`);
}

// ─── the page bridge ───────────────────────────────────────────────────────────
const BRIDGE = `<script>
(function () {
  var queue = [], ws = null, open = false, state = null;
  try { state = JSON.parse(localStorage.getItem('dmcr-web-state') || 'null'); } catch (e) {}
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = function () { open = true; queue.splice(0).forEach(function (m) { ws.send(m); }); document.documentElement.dataset.dmcrWeb = 'connected'; };
    ws.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } window.dispatchEvent(new MessageEvent('message', { data: m })); };
    ws.onclose = function () { open = false; document.documentElement.dataset.dmcrWeb = 'reconnecting'; setTimeout(connect, 1000); };
  }
  window.__DMCR_VSCODE_API__ = {
    postMessage: function (m) { var s = JSON.stringify(m); if (open) ws.send(s); else queue.push(s); },
    getState: function () { return state; },
    setState: function (s) { state = s; try { localStorage.setItem('dmcr-web-state', JSON.stringify(s)); } catch (e) {} }
  };
  window.__DMCR_MODE__ = 'vscode-extension';
  window.__DMCR_WEB__ = true;
  connect();
})();
</script>`;

function page(file: string, res: express.Response) {
  const p = path.join(DIST, 'webview-ui', file);
  if (!fs.existsSync(p)) { res.status(500).send(`Build the webview first: npm run build:webview (missing ${p})`); return; }
  const html = fs.readFileSync(p, 'utf8').replace('</head>', `${BRIDGE}\n<title>DMCR Web</title>\n</head>`);
  res.type('html').send(html);
}

// ─── start ─────────────────────────────────────────────────────────────────────
async function main() {
  const env = readEnvFile();
  const globalDir = path.join(WEB_HOME, 'global');
  fs.mkdirSync(globalDir, { recursive: true });
  const context = {
    secrets: fileSecretStorage(),
    globalState: fileMemento(path.join(WEB_HOME, 'global-state.json')),
    workspaceState: fileMemento(path.join(WEB_HOME, 'workspace-state.json')),
    globalStorageUri: Uri.file(globalDir),
    extensionPath: REPO,
    extensionUri: Uri.file(REPO),
    subscriptions: [] as { dispose(): unknown }[],
  } as unknown as import('vscode').ExtensionContext;

  // DMCR Web keeps its own database (never the VS Code extension's ~/.dmcr/db/dmcr.db),
  // unless settings.json in DMCR_WEB_HOME names one explicitly.
  const dbSetting = workspace.getConfiguration('dmcr');
  if (!dbSetting.get<string>('dbPath', '')) { await dbSetting.update('dbPath', path.join(WEB_HOME, 'db', 'dmcr.db')); }

  // Same start-up order as src/extension.ts activate()
  await initDb(REPO);
  initPromptLibraryDb(getRawDb());
  initRunnerPaths(context);
  initDangerRulesDir(REPO);
  initSecretStore(context.secrets);
  await migrateLegacyApiKeys();
  await migrateProviderHeaders();
  loadActiveFamilyFromDb();
  initMcpService(REPO);
  await initMcpSecrets();
  await setUpDeepSeek(env);

  const app = express();
  app.get('/health', (_req, res) => { res.json({ ok: true, db: getDbPath(), workspace: WORKSPACE_DIR }); });
  app.get(['/', '/index.html', '/webview-ui/index.html'], (_req, res) => page('index.html', res));
  app.get('/webview-ui/schema-explorer.html', (_req, res) => page('schema-explorer.html', res));
  app.get('/webview-ui/conversation.html', (_req, res) => page('conversation.html', res));
  app.get('/webview-ui/wiki.html', (_req, res) => page('wiki.html', res));
  app.get('/schema-explorer', (_req, res) => res.redirect('/webview-ui/schema-explorer.html'));
  // Assets referenced as ../assets/… from /webview-ui/*.html
  app.use(express.static(DIST, { index: false }));
  app.use('/images', express.static(path.join(REPO, 'images')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sockets = new Set<WebSocket>();
  webHooks.notify = (level, message) => {
    if (level === 'info') { return; }
    for (const s of sockets) { if (s.readyState === s.OPEN) { s.send(JSON.stringify({ type: 'error', payload: message })); } }
  };

  wss.on('connection', ws => {
    sockets.add(ws);
    const state: PanelState = { activeFormType: null, pendingGenerations: {}, inlineConvSessionStartId: 0 };
    const disposables: { dispose(): unknown }[] = [];
    const webview = {
      postMessage: async (m: unknown) => { if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify(m)); } return true; },
      asWebviewUri: (u: unknown) => u,
      cspSource: '',
      onDidReceiveMessage: () => ({ dispose() {} }),
    };
    const ctx: HandlerContext = {
      webview: webview as unknown as import('vscode').Webview,
      extensionUri: Uri.file(REPO) as unknown as import('vscode').Uri,
      extensionPath: REPO, disposables: disposables as never, state, extensionContext: context,
    };
    ws.on('message', async raw => {
      let msg: Message;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        // Same order as DmcrPanel._handleMessage
        if (await handleFormMessage(ctx, msg)) { return; }
        if (await handleChatMessage(ctx, msg)) { return; }
        if (await handleSettingsMessage(ctx, msg)) { return; }
        if (await handleRunnerMessage(ctx, msg)) { return; }
        if (await handleMcpMessage(ctx, msg)) { return; }
        if (await handleDataMessage(ctx, msg)) { return; }
        await handleConfigMessage(ctx, msg);
      } catch (e) {
        console.error(`[dmcr-web] ${msg.type}:`, e);
        webview.postMessage({ type: 'error', payload: `${msg.type}: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
    ws.on('close', () => { sockets.delete(ws); for (const d of disposables) { try { d.dispose(); } catch { /* closing */ } } });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[dmcr-web] DMCR Web on http://127.0.0.1:${PORT}`);
    console.log(`[dmcr-web] workspace ${WORKSPACE_DIR} · db ${getDbPath()} · home ${WEB_HOME}`);
  });
}

function shutdown() {
  try { disposeMcpService(); } catch { /* best effort */ }
  try { closeDb(); } catch (e) { console.error('[dmcr-web] could not save the database:', e); }
  process.exit(0);
}
process.on('message', m => { if (m === 'shutdown') { shutdown(); } });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(e => { console.error('[dmcr-web] startup failed:', e); process.exit(1); });
