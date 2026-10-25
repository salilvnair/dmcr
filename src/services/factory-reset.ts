/**
 * Settings › General › Reset to defaults: DMCR back to its first run, like a phone's factory reset.
 *
 * Everything DMCR keeps for itself goes: dmcr.cfg and the danger rules (back to the copies DMCR ships), the
 * environment passwords and the AI / MCP secrets in the keychain, every AI provider and MCP server, every row of its
 * own database (settings, DBA name, chats, AI footprint, runner history, drafts) and its saved UI state. DMCR then
 * opens on the setup wizard. The databases and the change files are the user's data and are not touched.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

/** Providers DMCR knows by id (their API keys are "dmcr.llm.<id>"), besides the ones saved as custom providers. */
const KNOWN_PROVIDER_IDS = ['deepseek', 'deepseek_e2e', 'openai', 'anthropic', 'gemini', 'ollama', 'mistral', 'groq', 'azure', 'openrouter'];

export async function factoryReset(ctx: vscode.ExtensionContext | undefined): Promise<{ steps: string[] }> {
  const steps: string[] = [];
  const { getUserCfgPath, getUserDangerRulesPath, getBundledRunnerDir } = await import('../storage/runner-paths.js');
  const { parseDmcrIni, cfgEnvList } = await import('../panel/main/handlers/dmcr-cfg.js');

  // 1 the keychain: worked out from what is stored, before it goes (a keychain cannot be listed)
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
  }
  steps.push(`passwords of ${[...envNames].join(', ')}, ${providers.length} AI provider(s) and ${servers.length} MCP server(s) removed`);

  // 2 its own database: every row
  const { deleteAllDmcrData } = await import('../storage/db.js');
  deleteAllDmcrData();
  steps.push('settings, DBA name, chats, AI footprint, runner history and drafts cleared');

  // 3 no dmcr.cfg, as on a first install (the setup wizard writes it again); the danger rules DMCR ships
  if (cfgPath && fs.existsSync(cfgPath)) fs.rmSync(cfgPath);
  const danger = getUserDangerRulesPath();
  const bundled = getBundledRunnerDir();
  const shipped = bundled ? path.join(bundled, 'dmcr_danger.json') : '';
  if (danger) {
    if (shipped && fs.existsSync(shipped)) fs.copyFileSync(shipped, danger);
    else if (fs.existsSync(danger)) fs.rmSync(danger);
  }
  steps.push('dmcr.cfg removed (the setup wizard makes it again), danger rules back to the defaults');

  // 4 saved UI state (theme, list sizes …)
  if (ctx) {
    for (const k of ctx.globalState.keys()) await ctx.globalState.update(k, undefined);
  }
  steps.push('saved UI state cleared');

  // 5 the database MCP servers follow the (default) environments again
  try {
    const { syncEnvMcpServers } = await import('./mcp/server/env-servers.js');
    await syncEnvMcpServers();
  } catch { /* none to sync */ }
  return { steps };
}
