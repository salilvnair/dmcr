/**
 * Config, danger rules, prompt library, workspace settings, and file picker handlers.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { loadDangerRules, saveDangerRules, resetDangerRules, getDangerRulesDir } from '../../../storage/danger-rules';
import { getUserCfgPath } from '../../../storage/runner-paths';
import { splitConnPassword, redactText } from '../../../services/security/redact';
import { getAllPrompts as getAllPromptsFromLib, savePrompt as savePromptToLib, resetPrompt as resetPromptInLib, resetAllPrompts } from '../../../storage/prompt-library';
import type { HandlerContext, Message } from "./types";
import { parseDmcrIni, buildDmcrCfg, cfgEnvList, cfgActiveEnv, cfgProduction, type EnvRules } from "./types";

/** Keychain key of an environment's password. */
const envPasswordKey = (name: string) => `dmcr.${name}Password`;
/** Old installs kept the whole URL of dev / prod in dmcr.devConn / dmcr.prodConn. */
const legacyConn = async (extCtx: vscode.ExtensionContext, name: string) =>
  name === 'dev' || name === 'prod' ? extCtx.secrets.get(`dmcr.${name}Conn`) : undefined;

export async function handleConfigMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;

  switch (msg.type) {

    /* ── DMCR Config (dmcr.cfg + SecretStorage for passwords only) ── */
    /* Setup wizard › psql: only psql_path under [dmcr], before any database exists (the full DMCR Config save needs
       at least one environment, so on a first run it refused and the step never moved on) */
    case "savePsqlPath": {
      try {
        const psqlPath = String((msg.payload as { psqlPath?: string } | undefined)?.psqlPath ?? '').trim();
        if (/[\r\n]/.test(psqlPath)) throw new Error('psql path must be one line');
        const cfgPath = getUserCfgPath();
        if (!cfgPath) throw new Error('DMCR has no storage folder for dmcr.cfg');
        const lines = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8').replace(/\r\n/g, '\n').split('\n') : [];
        let start = lines.findIndex(l => /^\s*\[dmcr\]\s*$/i.test(l));
        if (start < 0) { lines.unshift('[dmcr]', ''); start = 0; }
        let end = lines.findIndex((l, i) => i > start && /^\s*\[[^\]]+\]\s*$/.test(l));
        if (end < 0) end = lines.length;
        const at = lines.findIndex((l, i) => i > start && i < end && /^\s*psql_path\s*=/.test(l));
        if (at >= 0) lines[at] = `psql_path = ${psqlPath}`;
        else lines.splice(start + 1, 0, '# Absolute path to psql (leave blank to use PATH)', `psql_path = ${psqlPath}`);
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, lines.join('\n').replace(/\n*$/, '\n'), 'utf8');
        webview.postMessage({ type: 'dmcrConfigSaved', payload: { cfgPath } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'dmcrConfigError', payload: { message: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    case "getDmcrConfig": {
      const cfgPath = getUserCfgPath() ?? '';
      let parsed: Record<string, Record<string, string>> = {};
      if (cfgPath && fs.existsSync(cfgPath)) {
        parsed = parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'));
      }
      const dmcrSec    = parsed['dmcr']    ?? {};
      const compareSec = parsed['compare'] ?? {};
      const extCtx = ctx.extensionContext;
      // Every environment the cfg lists, any names, any number; passwords live in the keychain as dmcr.<name>Password
      const envs = await Promise.all(cfgEnvList(parsed).map(async e => ({
        ...e, hasPassword: extCtx ? !!(await extCtx.secrets.get(envPasswordKey(e.name))) || !!(await legacyConn(extCtx, e.name)) : false,
      })));
      // Release rules per environment (promotion gate, out-of-order guard, approvals)
      const envRules: Record<string, { promoteFrom: string; outOfOrder: string; approval: string; approvers: string }> = {};
      for (const { name: n } of envs) {
        envRules[n] = { promoteFrom: parsed[n]?.['promote_from'] ?? '', outOfOrder: parsed[n]?.['out_of_order'] ?? '', approval: parsed[n]?.['approval'] ?? '', approvers: parsed[n]?.['approvers'] ?? '' };
      }
      const { findById: findCfg } = await import('../../../storage/db.js');
      const dbCfgFull = findCfg<{ gitRemoteUrl?: string; gitAutoCommit?: boolean; gitBranch?: string }>('dmcr_config', 'main');
      webview.postMessage({
        type: 'dmcrConfig',
        payload: {
          env:              cfgActiveEnv(parsed),
          // the production environment: chosen in Settings ([envs] production), else guessed from the names
          production:       cfgProduction(parsed),
          productionSet:    !!(parsed['envs']?.['production'] ?? '').trim(),
          changesDir:       dmcrSec['changes_dir']       ?? '',
          psqlPath:         dmcrSec['psql_path']         ?? '',
          lockTimeout:      dmcrSec['lock_timeout']      ?? '30s',
          statementTimeout: dmcrSec['statement_timeout'] ?? '5min',
          runHistoryLimit:  String(dmcrSec['run_history_limit'] ?? (dbCfgFull as any)?.runHistoryLimit ?? 50),
          // URL (no password) from cfg; password stored separately in keychain
          envs,
          compareConnUrl: compareSec['conn'] ?? '',
          envRules,
          checksumPolicy:   dmcrSec['checksum_policy']   ?? '',
          conflictCheck:    dmcrSec['conflict_check']    ?? '',
          cfgPath: cfgPath || '',
          gitRemoteUrl:  dbCfgFull?.gitRemoteUrl  ?? '',
          gitAutoCommit: dbCfgFull?.gitAutoCommit ?? false,
          gitBranch:     dbCfgFull?.gitBranch     ?? '',
        },
      });
      return true;
    }

    // Settings › General › Danger zone › Erase local data: DMCR as on a fresh install (the databases and change files stay)
    case "factoryReset": {
      try {
        const { factoryReset } = await import('../../../services/factory-reset.js');
        const r = await factoryReset(ctx.extensionContext);
        webview.postMessage({ type: 'factoryResetDone', payload: { ok: true, steps: r.steps } });
      } catch (e) {
        webview.postMessage({ type: 'factoryResetDone', payload: { ok: false, error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    case "saveDmcrConfig": {
      try {
        const {
          env, changesDir: cd, psqlPath, lockTimeout, statementTimeout, runHistoryLimit,
          envs: envsIn, devConnUrl, devPassword, prodConnUrl, prodPassword,
          compareConnUrl, extraEnvs, envRules, checksumPolicy, conflictCheck,
          gitRemoteUrl, gitAutoCommit, gitBranch, production,
        } = msg.payload as {
          env: string; changesDir: string; psqlPath: string;
          lockTimeout: string; statementTimeout: string;
          runHistoryLimit?: number;
          /** The whole list of environments; one left out is removed (its section and its stored password) */
          envs?: { name: string; connUrl: string; schema?: string; password?: string | null }[];
          // older payload: fixed dev / prod plus extras
          devConnUrl?: string | null; devPassword?: string | null;
          prodConnUrl?: string | null; prodPassword?: string | null;
          compareConnUrl?: string | null;
          extraEnvs?: { name: string; connUrl: string; password?: string | null }[];
          envRules?: Record<string, EnvRules>;
          checksumPolicy?: string;
          conflictCheck?: string;
          gitRemoteUrl?: string; gitAutoCommit?: boolean; gitBranch?: string;
          /** the production environment ('' = none); left out: unchanged */
          production?: string;
        };
        if (checksumPolicy && !['warn', 'block', 'repair'].includes(checksumPolicy)) throw new Error(`checksum_policy must be warn, block or repair`);
        if (conflictCheck && !['block', 'warn', 'off'].includes(conflictCheck)) throw new Error(`conflict_check must be block, warn or off`);
        const envList = (envsIn ?? [
          ...(devConnUrl || devPassword ? [{ name: 'dev', connUrl: devConnUrl ?? '', password: devPassword }] : []),
          ...(prodConnUrl || prodPassword ? [{ name: 'prod', connUrl: prodConnUrl ?? '', password: prodPassword }] : []),
          ...(extraEnvs ?? []),
        ]).map(e => ({ name: (e.name ?? '').trim(), connUrl: (e.connUrl ?? '').trim(), schema: ((e as { schema?: string }).schema ?? '').trim(), password: e.password })).filter(e => e.name);
        const cfgPathForMerge = getUserCfgPath();
        const existingCfg = cfgPathForMerge && fs.existsSync(cfgPathForMerge) ? parseDmcrIni(fs.readFileSync(cfgPathForMerge, 'utf8')) : {};
        // validates the names (unique, usable as [section] and keychain key) before anything is stored
        const cfgContent = buildDmcrCfg({
          env: env ?? '',
          changesDir: cd ?? '',
          psqlPath:   psqlPath ?? '',
          lockTimeout: lockTimeout ?? '30s',
          statementTimeout: statementTimeout ?? '5min',
          envs: envList.map(e => ({ name: e.name, connUrl: e.connUrl, schema: e.schema })),
          compareConnUrl: compareConnUrl ?? '',
          envRules,
          checksumPolicy,
          conflictCheck,
          production,
          existing: existingCfg,
        });
        const extCtx = ctx.extensionContext;
        if (extCtx) {
          for (const e of envList) {
            if (e.password) await extCtx.secrets.store(envPasswordKey(e.name), e.password);
          }
          // an environment taken out of the list takes its stored password with it
          for (const gone of cfgEnvList(existingCfg).map(e => e.name).filter(n => !envList.some(e => e.name === n))) {
            await extCtx.secrets.delete(envPasswordKey(gone));
          }
        }
        const hasPassword: Record<string, boolean> = {};
        for (const e of envList) hasPassword[e.name] = extCtx ? !!(await extCtx.secrets.get(envPasswordKey(e.name))) || !!(await legacyConn(extCtx, e.name)) : !!e.password;
        const cfgPath = getUserCfgPath();
        if (!cfgPath) throw new Error('DMCR runner directory is not initialised.');
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, cfgContent, 'utf8');

        // Create the changes folder now, so status / deploy work before the first change is saved
        const changesDirRaw = (cd ?? '').trim();
        if (changesDirRaw) {
          const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const changesAbs = path.isAbsolute(changesDirRaw) ? changesDirRaw : (wsRoot ? path.join(wsRoot, changesDirRaw) : '');
          if (changesAbs) { try { fs.mkdirSync(changesAbs, { recursive: true }); } catch { /* reported by the runner if it matters */ } }
        }

        // Persist config to SQLite so DB Explorer can show it
        // and saveChangeToDisk can resolve changesDir without a workspace open.
        const { upsert } = await import('../../../storage/db.js');
        upsert('dmcr_config', 'main', {
          env:              parseDmcrIni(cfgContent)['dmcr']?.['env'] ?? '',
          changesDir:       cd              ?? '',
          psqlPath:         psqlPath        ?? '',
          lockTimeout:      lockTimeout     ?? '30s',
          statementTimeout: statementTimeout ?? '5min',
          envs:             JSON.stringify(envList.map(e => ({ name: e.name, connUrl: e.connUrl, schema: e.schema }))),
          compareConnUrl:   compareConnUrl  ?? '',
          runHistoryLimit:  runHistoryLimit ?? 50,
          gitRemoteUrl:     gitRemoteUrl    ?? '',
          gitAutoCommit:    gitAutoCommit   ?? false,
          gitBranch:        gitBranch       ?? '',
        });

        if (gitRemoteUrl) {
          try {
            const { setRemoteUrl } = await import('../../../services/git/git-service.js');
            await setRemoteUrl(gitRemoteUrl);
          } catch { /* git not available or not a repo */ }
        }
        // the promote from production may have started on: the page shows what was saved
        const saved = parseDmcrIni(cfgContent);
        const promoteFrom = Object.fromEntries(envList.map(e => [e.name, saved[e.name]?.['promote_from'] ?? '']));
        webview.postMessage({ type: 'dmcrConfigSaved', payload: { hasPassword, cfgPath, promoteFrom } });
        // the database MCP servers follow the environments (added / renamed / removed)
        try { const { syncEnvMcpServers } = await import('../../../services/mcp/server/env-servers.js'); await syncEnvMcpServers(); } catch { /* no program: nothing to sync */ }
        // a running database server keeps the password and URL it started with: restart each on its next call
        try {
          const { managedId } = await import('../../../services/mcp/server/env-servers.js');
          const { reconnectServer } = await import('../../../services/mcp/server/mcp.js');
          for (const e of envList) reconnectServer(managedId(e.name));
        } catch { /* nothing running */ }
      } catch (err: unknown) {
        // Always unblock the save button — never leave the UI in a stuck "Saving…" state
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'dmcrConfigError', payload: { message: errMsg } });
      }
      return true;
    }

    // Setup wizard: which psql DMCR would use (the path typed there first, then dmcr.cfg's, DMCR_PSQL, PATH, install folders)
    case "findPsql": {
      const typedPath = String((msg.payload as { psqlPath?: string } | undefined)?.psqlPath ?? '').trim();
      const candidates = psqlCandidatesFor(typedPath);
      let found: { path: string; version: string; installed: boolean } | null = null;
      for (const c of candidates) {
        const version = await psqlVersion(c);
        if (version !== null) { found = { path: c, version, installed: psqlInstallPaths().includes(c) }; break; }
      }
      webview.postMessage({ type: 'psqlFound', payload: { typed: typedPath, found } });
      return true;
    }

    case "testDbConnection": {
      const { conn, env, password: typed, psqlPath: typedPsql } = msg.payload as { conn: string; env: string; password?: string; psqlPath?: string };

      // Resolve full connection string: URL from payload/cfg + the password just typed (not saved yet), else the keychain's
      let connString = conn?.trim() ?? '';
      if (ctx.extensionContext) {
        const password = typed || (await ctx.extensionContext.secrets.get(envPasswordKey(env))) || '';
        if (connString && password) {
          // Inject password into the URL
          try {
            const u = new URL(connString);
            u.password = password;
            connString = u.toString();
          } catch { /* malformed URL, use as-is */ }
        }
        // Legacy fallback: full URL stored in dmcr.devConn / dmcr.prodConn
        if (!connString) connString = (await legacyConn(ctx.extensionContext, env)) ?? '';
      }

      if (!connString) {
        webview.postMessage({ type: 'testDbConnectionResult', payload: { ok: false, message: 'No connection string configured', env } });
        return true;
      }

      // Discover psql: the path typed in the setup wizard, dmcr.cfg's, DMCR_PSQL, PATH, then where this OS's installers put it
      const psqlCandidates = psqlCandidatesFor(String(typedPsql ?? '').trim());

      const testPsql = (psqlBin: string): Promise<{ ok: boolean; missing?: boolean; message: string }> =>
        new Promise(resolve => {
          // Password goes through PGPASSWORD, not argv (argv is visible to every local user).
          const { conn: connNoPw, password } = splitConnPassword(connString);
          const env = password ? { ...process.env, PGPASSWORD: password } : process.env;
          const psqlArgs = [connNoPw, '-c', 'SELECT 1', '-t', '-A', '--no-password'];
          // A PowerShell psql wrapper (DMCR_PSQL=…\psql-docker.ps1) runs the way the runner runs it
          const [bin, args] = /\.ps1$/i.test(psqlBin)
            ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psqlBin, ...psqlArgs]]
            : [psqlBin, psqlArgs];
          execFile(bin, args, { timeout: 15000, env }, (err, stdout, stderr) => {
            // not there: the next candidate
            if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { resolve({ ok: false, missing: true, message: '' }); return; }
            if (err) {
              const msg = redactText((stderr || err.message || 'Unknown error').trim().replace(/\n/g, ' ')).slice(0, 200);
              resolve({ ok: false, message: msg });
            } else {
              resolve({ ok: true, message: `psql reachable (${psqlBin})` });
            }
          });
        });

      let lastError = 'psql not found: install the PostgreSQL client (psql), or set its path in DMCR Config › psql program';
      for (const candidate of psqlCandidates) {
        const result = await testPsql(candidate);
        if (result.ok) {
          webview.postMessage({ type: 'testDbConnectionResult', payload: { ok: true, message: result.message, env } });
          return true;
        }
        if (result.missing) continue;
        lastError = result.message;
        break; // psql found but connection failed — no point trying other paths
      }
      webview.postMessage({ type: 'testDbConnectionResult', payload: { ok: false, message: lastError, env } });
      return true;
    }

    case "fetchGitBranches": {
      const url = (msg.payload as { url?: string })?.url || '';
      let branches: string[] = [];
      try {
        const { listRemoteBranches, setRemoteUrl, isGitAvailable, isGitRepo } = await import('../../../services/git/git-service.js');
        if (await isGitAvailable() && await isGitRepo()) {
          if (url) { await setRemoteUrl(url); }
          branches = await listRemoteBranches();
        }
      } catch { /* git not available */ }
      webview.postMessage({ type: 'gitBranches', payload: { branches } });
      return true;
    }

    /* ── File / folder pickers ── */
    case "pickFile": {
       
      const filters: Record<string, string[]> = (msg.payload as any)?.filters ?? { 'All Files': ['*'] };
      const fileRequestId = (msg.payload as { requestId?: string })?.requestId;
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        openLabel: 'Select file', filters,
      });
      if (result?.[0]) {
        webview.postMessage({ type: 'filePicked', payload: { path: result[0].fsPath, requestId: fileRequestId } });
      }
      return true;
    }

    case "pickFolder": {
      const folderRequestId = (msg.payload as { requestId?: string })?.requestId;
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Select changes folder',
      });
      if (result?.[0]) {
        const folderPath = vscode.workspace.asRelativePath(result[0]);
        webview.postMessage({ type: "folderPicked", payload: { path: folderPath, requestId: folderRequestId } });
      }
      return true;
    }

    /* ── Home: reveal output folder in Explorer ── */
    case "revealFolder": {
      const { folderRel } = msg.payload as { folderRel: string };
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        const folderUri = vscode.Uri.file(path.join(ws.uri.fsPath, folderRel));
        vscode.commands.executeCommand("revealInExplorer", folderUri);
      }
      return true;
    }

    /* ── Danger Rules ── */
    case "loadDangerRules": {
      const rules = loadDangerRules();
      const dangerDir = getDangerRulesDir() ?? '';
      webview.postMessage({ type: 'dangerRulesLoaded', payload: { rules, dangerRulesDir: dangerDir } });
      return true;
    }

    case "saveDangerRules": {
      try {
        const { rules: rulesToSave } = msg.payload as { rules: import('../../../storage/danger-rules').DangerRulesFile };
        saveDangerRules(rulesToSave);
        const savedDir = getDangerRulesDir() ?? '';
        webview.postMessage({ type: 'dangerRulesSaved', payload: { dangerRulesDir: savedDir } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `Save failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    case "resetDangerRules": {
      const defaults = resetDangerRules();
      const dirR = getDangerRulesDir() ?? '';
      webview.postMessage({ type: 'dangerRulesLoaded', payload: { rules: defaults, dangerRulesDir: dirR } });
      return true;
    }

    /* ── Prompt Library ── */
    case "loadPromptLibrary": {
      const entries = getAllPromptsFromLib();
      webview.postMessage({ type: 'promptLibraryLoaded', payload: entries });
      return true;
    }

    case "savePromptLibrary": {
      try {
        const { scenario, prompt, agentName, userPrompt, variables } = msg.payload as { scenario: string; prompt: string; agentName?: string; userPrompt?: string; variables?: Record<string, { description: string; source: string }> };
        savePromptToLib(scenario as import('../../../storage/prompt-library').PromptScenario, prompt, agentName, userPrompt, variables);
        const entries = getAllPromptsFromLib();
        webview.postMessage({ type: 'promptLibraryLoaded', payload: entries });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `Save prompt failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    // Prompt Library › Reset defaults: every edited prompt back to DMCR's own
    case "resetAllPrompts": {
      try {
        resetAllPrompts();
        webview.postMessage({ type: 'promptLibraryLoaded', payload: getAllPromptsFromLib() });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `Reset prompts failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    case "resetPromptLibrary": {
      try {
        const { scenario } = msg.payload as { scenario: string };
        resetPromptInLib(scenario as import('../../../storage/prompt-library').PromptScenario);
        const entries = getAllPromptsFromLib();
        webview.postMessage({ type: 'promptLibraryLoaded', payload: entries });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `Reset prompt failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    default:
      return false;
  }
}

/** Where the PostgreSQL client usually lives when it is not on PATH, for this OS only (newest version first on Windows) */
function psqlInstallPaths(): string[] {
  if (process.platform === 'darwin') return ['/opt/homebrew/bin/psql', '/usr/local/bin/psql', '/Applications/Postgres.app/Contents/Versions/latest/bin/psql'];
  if (process.platform !== 'win32') return ['/usr/bin/psql', '/usr/local/bin/psql'];
  const out: string[] = [];
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    const base = root && path.join(root, 'PostgreSQL');
    if (!base || !fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).sort((a, b) => (parseFloat(b) || 0) - (parseFloat(a) || 0));
    for (const v of versions) out.push(path.join(base, v, 'bin', 'psql.exe'));
  }
  // pgAdmin 4 ships its own psql (per-user or for all users)
  for (const root of [process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs'), process.env['ProgramFiles']]) {
    const exe = root && path.join(root, 'pgAdmin 4', 'runtime', 'psql.exe');
    if (exe && fs.existsSync(exe)) out.push(exe);
  }
  return out;
}

/** psql to try, in order: a path just typed (not saved yet), dmcr.cfg's psql_path, DMCR_PSQL, PATH, this OS's install folders */
function psqlCandidatesFor(typed: string): string[] {
  let saved = '';
  try {
    const cfgPath = getUserCfgPath();
    if (cfgPath && fs.existsSync(cfgPath)) saved = String(parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'))['dmcr']?.['psql_path'] ?? '').trim();
  } catch { /* unreadable dmcr.cfg: the other places */ }
  return [...new Set([typed, saved, process.env.DMCR_PSQL, 'psql', ...psqlInstallPaths()].filter(Boolean) as string[])];
}

/** `psql --version` of one candidate: its first line, or null when it is not there or does not run */
function psqlVersion(psqlBin: string): Promise<string | null> {
  const [bin, args] = /\.ps1$/i.test(psqlBin)
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psqlBin, '--version']]
    : [psqlBin, ['--version']];
  return new Promise(resolve => {
    execFile(bin, args, { timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout).trim().split(/\r?\n/)[0] || 'psql'));
  });
}
