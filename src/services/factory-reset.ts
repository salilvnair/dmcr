/**
 * Settings › General › Danger zone › Erase local data: DMCR as if it were uninstalled and installed again.
 *
 * Everything DMCR keeps on this machine goes: the environment passwords and the AI / MCP secrets in the keychain,
 * every AI provider and MCP server, its local database file (a new, empty one takes its place), its storage folder
 * (dmcr.cfg, danger rules; the danger rules DMCR ships come back), its saved UI state and its dmcr.* settings
 * (except dmcr.dbPath, where the new database is written). DMCR then opens on the setup wizard. The databases DMCR
 * deploys to (the dmcr registry included) and the change files are the user's data and are not touched.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

/** Providers DMCR knows by id (their API keys are "dmcr.llm.<id>"), besides the ones saved as custom providers. */
const KNOWN_PROVIDER_IDS = ['deepseek', 'deepseek_e2e', 'openai', 'anthropic', 'gemini', 'ollama', 'mistral', 'groq', 'azure', 'openrouter'];

export async function factoryReset(ctx: vscode.ExtensionContext | undefined): Promise<{ steps: string[] }> {
  const steps: string[] = [];
  const { getUserCfgPath, getUserRunnerDir, getUserDangerRulesPath, getBundledRunnerDir } = await import('../storage/runner-paths.js');
  const { parseDmcrIni, cfgEnvList } = await import('../panel/main/handlers/dmcr-cfg.js');

  // 1 the keychain: worked out from what is stored, before it goes (VS Code's keychain cannot always be listed)
  const cfgPath = getUserCfgPath();
  const envNames = new Set(['dev', 'test', 'prod']);
  if (cfgPath && fs.existsSync(cfgPath)) {
    for (const e of cfgEnvList(parseDmcrIni(fs.readFileSync(cfgPath, 'utf8')))) envNames.add(e.name);
  }
  const { getAllCustomProviders, deleteCustomProvider } = await import('./llm/core/custom-providers.js');
  const { deleteApiKey } = await import('./llm/core/secret-store.js');
  const { listServers, deleteServer } = await import('./mcp/server/mcp.js');
  const providers = getAllCustomProviders();
  for (const p of providers) await deleteCustomProvider(p.key);
  for (const id of KNOWN_PROVIDER_IDS) await deleteApiKey(id);
  const servers = listServers();
  for (const s of servers) deleteServer(s.id);
  if (ctx) {
    for (const n of envNames) {
      for (const key of [`dmcr.${n}Password`, `dmcr.${n}Conn`]) await ctx.secrets.delete(key);
    }
    // whatever else is in DMCR's keychain, where it can be listed
    const listable = ctx.secrets as vscode.SecretStorage & { keys?: () => Thenable<string[]> };
    if (typeof listable.keys === 'function') {
      for (const key of await listable.keys()) await ctx.secrets.delete(key);
    }
  }
  steps.push(`passwords of ${[...envNames].join(', ')}, ${providers.length} AI provider(s) and ${servers.length} MCP server(s) removed`);

  // 2 its local database: every row (other open windows follow), then a new, empty file in its place
  const { deleteAllDmcrData, recreateDb, getDbPath } = await import('../storage/db.js');
  deleteAllDmcrData();
  await recreateDb();
  steps.push(`local database ${getDbPath()} erased and created empty`);

  // 3 its storage folder (dmcr.cfg, danger rules …) emptied; the danger rules DMCR ships come back, as on install
  const runnerDir = getUserRunnerDir();
  const storageDir = ctx?.globalStorageUri.fsPath || (runnerDir ? path.dirname(runnerDir) : '');
  if (storageDir && fs.existsSync(storageDir)) {
    for (const name of fs.readdirSync(storageDir)) fs.rmSync(path.join(storageDir, name), { recursive: true, force: true });
  }
  if (runnerDir) fs.mkdirSync(runnerDir, { recursive: true });
  const danger = getUserDangerRulesPath();
  const bundled = getBundledRunnerDir();
  const shipped = bundled ? path.join(bundled, 'dmcr_danger.json') : '';
  if (danger && shipped && fs.existsSync(shipped)) fs.copyFileSync(shipped, danger);
  steps.push(`storage folder ${storageDir || '(none)'} emptied: dmcr.cfg removed (the setup wizard makes it again), danger rules back to the defaults`);

  // 4 saved UI state (theme, list sizes …)
  if (ctx) {
    for (const k of ctx.globalState.keys()) await ctx.globalState.update(k, undefined);
    for (const k of ctx.workspaceState?.keys?.() ?? []) await ctx.workspaceState.update(k, undefined);
  }
  steps.push('saved UI state cleared');

  // 5 dmcr.* settings back to their defaults; dmcr.dbPath stays (the new database is there)
  if (ctx) {
    const vs = await import('vscode');
    const settings = vs.workspace.getConfiguration('dmcr');
    const keys = settingKeys(ctx.extensionPath).filter(k => k !== 'dbPath');
    const target = vs.ConfigurationTarget?.Global;
    for (const k of keys) {
      if (settings.has(k)) { try { await settings.update(k, undefined, target); } catch { /* not set there */ } }
    }
    steps.push('DMCR settings back to their defaults (where the database file lives is kept)');
  }

  // 6 the database MCP servers follow the (default) environments again
  try {
    const { syncEnvMcpServers } = await import('./mcp/server/env-servers.js');
    await syncEnvMcpServers();
  } catch { /* none to sync */ }
  return { steps };
}

/** The dmcr.* settings this extension contributes (package.json), without the "dmcr." prefix */
function settingKeys(extensionPath: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
    const conf = pkg?.contributes?.configuration;
    const blocks = Array.isArray(conf) ? conf : conf ? [conf] : [];
    return blocks.flatMap((b: { properties?: Record<string, unknown> }) => Object.keys(b.properties ?? {}))
      .filter((k: string) => k.startsWith('dmcr.')).map((k: string) => k.slice('dmcr.'.length));
  } catch { return []; }
}
