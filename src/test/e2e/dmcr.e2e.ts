/**
 * End-to-end tests inside a real VS Code extension host.
 *
 * - The bundled extension (dist/extension.js) is activated and its panel opened.
 * - The panel's message handlers are driven exactly as the webview drives them, with a
 *   recording webview, against:
 *     • a real PostgreSQL 16 (Docker container dmcr-test-pg; psql runs inside it through
 *       scripts/runner/tests/psql-shim.ps1 / .sh),
 *     • the real runner script (dmcr.ps1 on Windows, dmcr.sh elsewhere),
 *     • a local fake OpenAI-compatible model server, so every AI path runs for real.
 * - Secrets go to an in-memory SecretStorage (the extension's own context is not exported).
 *
 * Started by scripts/e2e/run-e2e.mjs (npm run test:e2e).
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';

import { initDb, getRawDb, findById, findAll } from '../../storage/db';
import { initPromptLibraryDb, getDefaultPromptText } from '../../storage/prompt-library';
import { initRunnerPaths, getUserCfgPath } from '../../storage/runner-paths';
import { initDangerRulesDir } from '../../storage/danger-rules';
import { initSecretStore, migrateLegacyApiKeys } from '../../services/llm/core/secret-store';
import { migrateProviderHeaders } from '../../services/llm/core/custom-providers';
import { initMcpSecrets, listServers } from '../../services/mcp/server/mcp';
import {
  handleConfigMessage, handleFormMessage, handleRunnerMessage, handleMcpMessage,
  handleDataMessage, handleSettingsMessage,
  type HandlerContext, type Message,
} from '../../panel/main/handlers';

const REPO = path.resolve(__dirname, '..', '..', '..');
const PG = 'dmcr-test-pg';
const PG_CONN = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest';

// ── test doubles ────────────────────────────────────────────────────────────
type Msg = { type: string; payload?: any };

class RecordingWebview {
  messages: Msg[] = [];
  postMessage(m: Msg) { this.messages.push(m); return Promise.resolve(true); }
  /** Wait for the first message after `from` matching `pred`. */
  async waitFor(pred: (m: Msg) => boolean, from = 0, ms = 120_000): Promise<Msg> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.messages.slice(from).find(pred);
      if (hit) { return hit; }
      if (Date.now() - t0 > ms) {
        throw new Error(`timed out waiting for message; got: ${this.messages.slice(from).map(m => m.type).join(', ')}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

const secretMap = new Map<string, string>();
const secrets: vscode.SecretStorage = {
  get: async k => secretMap.get(k),
  store: async (k, v) => { secretMap.set(k, v); },
  delete: async k => { secretMap.delete(k); },
  keys: async () => [...secretMap.keys()],
  onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
} as vscode.SecretStorage;

function memento(): vscode.Memento {
  const m = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: async (k: string, v: unknown) => { m.set(k, v); },
    keys: () => [...m.keys()],
    setKeysForSync: () => {},
  } as unknown as vscode.Memento;
}

/** Fake OpenAI-compatible server: records requests, answers with `reply(systemPrompt)`. */
type FakeModel = { url: string; requests: { system: string; user: string; headers: http.IncomingHttpHeaders }[]; close: () => void; reply: (system: string, user: string) => string };
let fakeModel: FakeModel | undefined;

function startFakeModel(initialReply: (system: string, user: string) => string): Promise<FakeModel> {
  const requests: { system: string; user: string; headers: http.IncomingHttpHeaders }[] = [];
  const model = { reply: initialReply } as FakeModel;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        return;
      }
      const j = JSON.parse(body || '{}') as { messages?: { role: string; content: string }[]; stream?: boolean };
      const system = j.messages?.find(m => m.role === 'system')?.content ?? '';
      const user = j.messages?.filter(m => m.role === 'user').map(m => m.content).join('\n') ?? '';
      requests.push({ system, user, headers: req.headers });
      const text = model.reply(system, user);
      if (j.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      }
    });
  });
  return new Promise<FakeModel>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      Object.assign(model, { url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() });
      resolve(model);
    });
  });
}

function sql(q: string): string {
  return execFileSync('docker', ['exec', '-i', PG, 'psql', PG_CONN, '-X', '-t', '-A', '-c', q], { encoding: 'utf8' }).trim();
}

// ── shared state ────────────────────────────────────────────────────────────
let webview: RecordingWebview;
let ctx: HandlerContext;
let wsRoot: string;

async function send(msg: Message): Promise<number> {
  const from = webview.messages.length;
  for (const h of [handleConfigMessage, handleFormMessage, handleRunnerMessage, handleMcpMessage, handleDataMessage, handleSettingsMessage]) {
    if (await h(ctx, msg)) { return from; }
  }
  throw new Error(`no handler for ${msg.type}`);
}

async function runRunner(args: string[]): Promise<{ code: number | null; json?: Msg }> {
  const from = await send({ type: 'runDmcr', payload: { args } });
  const exit = await webview.waitFor(m => m.type === 'terminalExit', from, 170_000);
  const json = webview.messages.slice(from).find(m => m.type === 'terminalJsonResult');
  return { code: exit.payload?.code ?? null, json };
}

suite('DMCR end to end', () => {
  suiteSetup(async () => {
    wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.ok(wsRoot, 'the test workspace is open');
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-e2e-global-'));
    const extensionContext = {
      secrets, globalState: memento(), workspaceState: memento(),
      globalStorageUri: vscode.Uri.file(globalDir), extensionPath: REPO,
      extensionUri: vscode.Uri.file(REPO), subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    webview = new RecordingWebview();
    ctx = {
      webview: webview as unknown as vscode.Webview,
      extensionUri: vscode.Uri.file(REPO), extensionPath: REPO, disposables: [],
      state: { activeFormType: null, pendingGenerations: {}, inlineConvSessionStartId: 0 },
      extensionContext,
    };
    // Same start-up order as extension.ts activate()
    await initDb(REPO);
    initPromptLibraryDb(getRawDb());
    initRunnerPaths(extensionContext);
    initDangerRulesDir(REPO);
    initSecretStore(secrets);
    await migrateLegacyApiKeys();
    await migrateProviderHeaders();
    await initMcpSecrets();
  });

  test('the packaged extension activates and opens its panel', async () => {
    const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'dmcr' && e.extensionPath.toLowerCase() === REPO.toLowerCase());
    assert.ok(ext, 'extension under test is loaded');
    await ext!.activate();
    assert.ok(ext!.isActive, 'activated without throwing');
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['dmcr.open', 'dmcr.conversation', 'dmcr.openSchemaExplorer']) { assert.ok(cmds.includes(c), `${c} registered`); }
    await vscode.commands.executeCommand('dmcr.open');
    await new Promise(r => setTimeout(r, 1500));
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label));
    assert.ok(tabs.includes('DMCR'), `DMCR panel open (tabs: ${tabs.join(', ')})`);
  });

  test('Settings → DMCR Config: URL in dmcr.cfg, password only in the keychain', async () => {
    await send({ type: 'saveDmcrConfig', payload: {
      env: 'dev', changesDir: 'db/changes', psqlPath: '', lockTimeout: '5s', statementTimeout: '2min',
      devConnUrl: 'postgresql://postgres@localhost:5432/dmcrtest', devPassword: 'Pw-e2e-only',
      prodConnUrl: null, prodPassword: null,
    } });
    assert.strictEqual(secretMap.get('dmcr.devPassword'), 'Pw-e2e-only');
    const cfg = fs.readFileSync(getUserCfgPath()!, 'utf8');
    assert.match(cfg, /postgresql:\/\/postgres@localhost:5432\/dmcrtest/);
    assert.ok(!cfg.includes('Pw-e2e-only'), 'password not written to dmcr.cfg');
  });

  test('saving a generated change creates 001_<name> in the workspace changes folder', async () => {
    const from = await send({ type: 'saveChange', payload: {
      changeName: 'add e2e widgets', requestId: 'r1',
      deploySql: 'CREATE TABLE public.e2e_widgets (id int);',
      verifySql: "DO $$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') <> (to_regclass('public.e2e_widgets') IS NOT NULL) THEN RAISE EXCEPTION 'mismatch'; END IF; END $$;",
      revertSql: 'DROP TABLE public.e2e_widgets;',
      metaJson: '{"description":"e2e"}',
    } });
    const saved = await webview.waitFor(m => m.type === 'saved', from);
    assert.strictEqual(saved.payload.folderId, '001_add_e2e_widgets');
    assert.strictEqual(saved.payload.requestId, 'r1');
    const dir = path.join(wsRoot, 'db', 'changes', '001_add_e2e_widgets');
    for (const f of ['deploy.sql', 'verify.sql', 'revert.sql', 'meta.json']) { assert.ok(fs.existsSync(path.join(dir, f)), f); }
    assert.ok(fs.readFileSync(path.join(dir, 'verify.sql'), 'utf8').includes("'001_add_e2e_widgets'"), 'change id substituted');
  });

  test('Runner tab: init, deploy and status through the real runner and PostgreSQL', async () => {
    sql('DROP SCHEMA IF EXISTS dmcr CASCADE; DROP TABLE IF EXISTS public.e2e_widgets;');
    const init = await runRunner(['init']);
    assert.strictEqual(init.code, 0, 'init exits 0');
    const deploy = await runRunner(['deploy']);
    assert.strictEqual(deploy.code, 0, `deploy exits 0: ${webview.messages.filter(m => m.type === 'terminalData').slice(-5).map(m => m.payload).join('')}`);
    assert.strictEqual(sql("SELECT count(*) FROM dmcr.change_log WHERE change_id = '001_add_e2e_widgets';"), '1');
    assert.strictEqual(sql("SELECT to_regclass('public.e2e_widgets') IS NOT NULL;"), 't');
    const status = await runRunner(['status']);
    assert.strictEqual(status.code, 0);
    const rows = status.json?.payload?.data as { change_id: string; status: string }[];
    assert.deepStrictEqual(rows.map(r => `${r.change_id}:${r.status}`), ['001_add_e2e_widgets:applied']);
    const ls = await send({ type: 'lsChanges', payload: { requestId: 't1' } });
    const res = await webview.waitFor(m => m.type === 'lsChangesResult', ls);
    assert.deepStrictEqual(res.payload.folders.map((f: { name: string }) => f.name), ['001_add_e2e_widgets']);
  });

  test('MCP server secrets: keychain holds them, SQLite and the webview see masks, a masked save keeps them', async () => {
    const from = await send({ type: 'upsertMcpServer', payload: {
      name: 'e2e-secrets', transport: 'STDIO', category: 'general', command: 'node',
      args: ['-e', '0', 'postgresql://app:url-secret@db:5432/x'], env: { PGPASSWORD: 'env-secret', MODE: 'plain' },
    } });
    const posted = await webview.waitFor(m => m.type === 'mcpServers', from);
    const shown = (posted.payload as any[]).find(s => s.name === 'e2e-secrets');
    assert.strictEqual(shown.env.PGPASSWORD, '********');
    assert.strictEqual(shown.env.MODE, 'plain');
    assert.strictEqual(shown.args[2], 'postgresql://app:****@db:5432/x');
    const raw = JSON.stringify(findById('mcpServers', shown.id));
    assert.ok(!raw.includes('env-secret') && !raw.includes('url-secret'), 'SQLite record is masked');
    assert.ok((secretMap.get(`dmcr.mcp.${shown.id}`) ?? '').includes('env-secret'), 'keychain holds the real value');
    // The settings form sends the masked values back unchanged
    await send({ type: 'upsertMcpServer', payload: { ...shown, env: { ...shown.env, MODE: 'edited' } } });
    const full = listServers().find(s => s.id === shown.id)!;
    assert.strictEqual(full.env?.PGPASSWORD, 'env-secret');
    assert.strictEqual(full.env?.MODE, 'edited');
    assert.strictEqual(full.args?.[2], 'postgresql://app:url-secret@db:5432/x');
    await send({ type: 'deleteMcpServer', payload: { id: shown.id } });
    assert.strictEqual(secretMap.has(`dmcr.mcp.${shown.id}`), false, 'keychain entry removed with the server');
  });

  test('AI features: custom provider, Prompt Library edits, feature switches, per-change tools', async () => {
    const model = await startFakeModel(system =>
      system.startsWith('EDITED') ? 'EDITED-ANSWER' : 'FAKE-ANSWER');
    fakeModel = model; // the MCP test below reuses it; closed in suiteTeardown
    {
      // Provider with a secret header
      let from = await send({ type: 'addProvider', payload: {
        name: 'Fake LLM', type: 'openai', chatUrl: `${model.url}/chat/completions`, modelsUrl: `${model.url}/models`,
        apiKey: 'sk-e2e', headers: { 'X-Api-Key': 'hdr-secret' },
      } });
      const added = await webview.waitFor(m => m.type === 'providerAdded', from);
      assert.deepStrictEqual(added.payload.models.map((m: { id: string }) => m.id), ['fake-model']);
      const stored = findAll<{ key: string; headers?: Record<string, string>; apiKey?: string }>('custom_providers').find(p => p.key === 'fake_llm')!;
      assert.strictEqual(stored.headers?.['X-Api-Key'], '********', 'provider header masked in SQLite');
      assert.strictEqual(stored.apiKey, undefined, 'API key not in SQLite');
      await send({ type: 'activateProvider', payload: { key: 'fake_llm', model: 'fake-model' } });

      // Explainer uses the Prompt Library default and the real secrets
      from = await send({ type: 'explainChange', payload: { id: 1, command: 'deploy' } });
      let r = await webview.waitFor(m => m.type === 'changeExplainResult', from);
      assert.strictEqual(r.payload.explanation, 'FAKE-ANSWER');
      const last = model.requests[model.requests.length - 1];
      assert.strictEqual(last.headers['x-api-key'], 'hdr-secret', 'real header value sent');
      assert.strictEqual(last.headers['authorization'], 'Bearer sk-e2e');
      assert.ok(last.system.startsWith(getDefaultPromptText('AI_CHANGE_EXPLAINER').slice(0, 60)), 'default prompt from the library');

      // A Prompt Library edit takes effect
      await send({ type: 'savePromptLibrary', payload: { scenario: 'AI_CHANGE_EXPLAINER', prompt: 'EDITED explainer prompt' } });
      from = await send({ type: 'explainChange', payload: { id: 2, command: 'deploy' } });
      r = await webview.waitFor(m => m.type === 'changeExplainResult', from);
      assert.strictEqual(r.payload.explanation, 'EDITED-ANSWER');
      await send({ type: 'resetPromptLibrary', payload: { scenario: 'AI_CHANGE_EXPLAINER' } });

      // Switched off → refused before any model call
      await send({ type: 'saveAiFeatures', payload: { disabled: ['AI_CHANGE_EXPLAINER'] } });
      const calls = model.requests.length;
      from = await send({ type: 'explainChange', payload: { id: 3, command: 'deploy' } });
      r = await webview.waitFor(m => m.type === 'changeExplainResult', from);
      assert.match(r.payload.explanation, /turned off/);
      assert.strictEqual(model.requests.length, calls, 'no model call when off');
      from = await send({ type: 'getAiFeatures' });
      const feats = await webview.waitFor(m => m.type === 'aiFeatures', from);
      assert.deepStrictEqual(feats.payload.disabled, ['AI_CHANGE_EXPLAINER']);
      await send({ type: 'saveAiFeatures', payload: { disabled: [] } });

      // Per-change tools from the /status list, on the real change folder
      from = await send({ type: 'promotionGatekeep', payload: { changeName: '001_add_e2e_widgets', targetEnv: 'prod' } });
      const gate = await webview.waitFor(m => m.type === 'promotionGatekeeperResult', from);
      assert.strictEqual(gate.payload.changeName, '001_add_e2e_widgets');
      const checks = Object.fromEntries((gate.payload.checks as { name: string; passed: boolean }[]).map(c => [c.name, c.passed]));
      assert.strictEqual(checks['deploy.sql'], true);
      assert.strictEqual(checks['revert.sql'], true);
      assert.strictEqual(checks['Ticket reference'], false, 'no ticket in meta.json');
      assert.strictEqual(gate.payload.allPassed, false);
      assert.strictEqual(gate.payload.verdict, 'FAKE-ANSWER');
      for (const [type, result] of [['blueGreenPlan', 'blueGreenPlanResult'], ['checkCompliance', 'complianceCheckResult'], ['predictPerformanceImpact', 'performanceImpactResult'], ['estimateBlastRadius', 'blastRadiusResult'], ['canaryRolloutAdvisor', 'canaryRolloutResult']]) {
        from = await send({ type, payload: { changeName: '001_add_e2e_widgets', serverId: '', profiles: ['GDPR'] } });
        const res = await webview.waitFor(m => m.type === result, from);
        assert.strictEqual(res.payload.changeName, '001_add_e2e_widgets', `${type} answers for the change`);
        assert.ok(!res.payload.error, `${type}: ${res.payload.error}`);
      }
      // The model saw the change's real deploy.sql
      assert.ok(model.requests.some(q => q.user.includes('CREATE TABLE public.e2e_widgets')), 'deploy.sql read from the changes folder');
    }
  });

  test('database MCP server: the bundled pgsql_mcp validates, lists schemas, diffs DDL and runs health checks', async () => {
    const container = process.env.DMCR_E2E_MCP_CONTAINER;
    const pg = process.env.DMCR_E2E_MCP_PG;
    assert.ok(container && pg, 'started by scripts/e2e/run-e2e.mjs');
    // Registered the way a user would: a stdio command with the connection URL in its args
    let from = await send({ type: 'upsertMcpServer', payload: {
      name: 'pgsql_mcp (e2e)', transport: 'STDIO', category: 'database', command: 'docker',
      args: ['exec', '-i', '-w', '/srv/pgsql_mcp', container!, 'python', '-m', 'app_mcp.server', '--conn', pg!],
    } });
    const validation = await webview.waitFor(m => m.type === 'dbMcpValidation', from, 120_000);
    assert.strictEqual(validation.payload.compliant, true, `validation: ${validation.payload.error ?? ''} missing=${validation.payload.missing}`);
    const serverId = validation.payload.serverId as string;
    const listed = webview.messages.slice(from).filter(m => m.type === 'mcpServers').pop()?.payload as any[] | undefined;
    const shown = listed?.find(s => s.id === serverId);
    assert.ok(shown && !JSON.stringify(shown).includes(':dmcrtest@'), 'connection password masked in the webview');

    from = await send({ type: 'discoverMcpSchemas', payload: { serverId } });
    const schemas = await webview.waitFor(m => m.type === 'mcpSchemas' && m.payload?.serverId === serverId, from, 120_000);
    assert.strictEqual(schemas.payload.connected, true, schemas.payload.error);
    assert.ok((schemas.payload.schemas as string[]).includes('public'), `schemas: ${schemas.payload.schemas}`);

    // Schema Diff backend: DDL pairs for one table, same server on both sides
    from = await send({ type: 'fetchDdlPairs', payload: { sourceServerId: serverId, targetServerId: serverId, items: [{ schema: 'public', name: 'e2e_widgets', type: 'table' }] } });
    const pairs = await webview.waitFor(m => m.type === 'ddlPairsResult', from, 120_000);
    assert.strictEqual(pairs.payload.ok, true, pairs.payload.error);
    assert.match(pairs.payload.pairs[0].sourceDdl, /e2e_widgets/i);
    assert.strictEqual(pairs.payload.pairs[0].sourceDdl, pairs.payload.pairs[0].targetDdl);

    // Post-deploy health check: AI-written queries; only single read-only ones reach the database
    fakeModel!.reply = system => system.startsWith('Given this deploy.sql, generate')
      ? '["SELECT count(*) AS n FROM public.e2e_widgets", "DELETE FROM public.e2e_widgets"]'
      : 'HEALTH-SUMMARY';
    from = await send({ type: 'postDeployHealthCheck', payload: { changeName: '001_add_e2e_widgets', serverId } });
    const health = await webview.waitFor(m => m.type === 'postDeployHealthResult', from, 120_000);
    assert.ok(!health.payload.error, health.payload.error);
    const assessCall = fakeModel!.requests[fakeModel!.requests.length - 1];
    assert.match(assessCall.user, /"columns"/, 'the SELECT ran through run_readonly_query and its rows reached the model');
    assert.match(assessCall.user, /Skipped: only a single SELECT/, 'the DELETE was refused before reaching the database');
    assert.strictEqual(sql("SELECT to_regclass('public.e2e_widgets') IS NOT NULL;"), 't');

    await send({ type: 'deleteMcpServer', payload: { id: serverId } });
  });

  suiteTeardown(() => { fakeModel?.close(); });

  test('Runner tab: revertLast through the real runner', async () => {
    const rev = await runRunner(['revertLast']);
    assert.strictEqual(rev.code, 0);
    assert.strictEqual(sql("SELECT count(*) FROM dmcr.change_log;"), '0');
    assert.strictEqual(sql("SELECT to_regclass('public.e2e_widgets') IS NULL;"), 't');
  });
});
