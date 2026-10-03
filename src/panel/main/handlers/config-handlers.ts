/**
 * Config, danger rules, prompt library, workspace settings, and file picker handlers.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { loadDangerRules, saveDangerRules, resetDangerRules, getDangerRulesDir } from '../../../storage/danger-rules';
import { getUserCfgPath } from '../../../storage/runner-paths';
import { getAllPrompts as getAllPromptsFromLib, savePrompt as savePromptToLib, resetPrompt as resetPromptInLib } from '../../../storage/prompt-library';
import type { HandlerContext, Message } from "./types";
import { parseDmcrIni, buildDmcrCfg } from "./types";

export async function handleConfigMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;

  switch (msg.type) {

    /* ── DMCR Config (dmcr.cfg + SecretStorage for passwords only) ── */
    case "getDmcrConfig": {
      const cfgPath = getUserCfgPath() ?? '';
      let parsed: Record<string, Record<string, string>> = {};
      if (cfgPath && fs.existsSync(cfgPath)) {
        parsed = parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'));
      }
      const dmcrSec    = parsed['dmcr']    ?? {};
      const devSec     = parsed['dev']     ?? {};
      const prodSec    = parsed['prod']    ?? {};
      const compareSec = parsed['compare'] ?? {};
      const envsSec    = parsed['envs']    ?? {};
      const knownSections = new Set(['dmcr', 'dev', 'prod', 'compare', 'envs']);
      const namesStr = envsSec['names'] ?? '';
      const envNames = namesStr.split(',').map((n: string) => n.trim()).filter(Boolean);
      const extraEnvs = envNames
        .filter((n: string) => !knownSections.has(n))
        .map((n: string) => ({ name: n, connUrl: parsed[n]?.['conn'] ?? '' }));
      const extCtx = ctx.extensionContext;
      // New model: password in keychain, URL in cfg. Legacy fallback: full URL in dmcr.devConn.
      const hasDevPassword  = extCtx ? !!(await extCtx.secrets.get('dmcr.devPassword'))  : false;
      const hasProdPassword = extCtx ? !!(await extCtx.secrets.get('dmcr.prodPassword')) : false;
      const hasDevConn      = extCtx ? !!(await extCtx.secrets.get('dmcr.devConn'))      : false;
      const hasProdConn     = extCtx ? !!(await extCtx.secrets.get('dmcr.prodConn'))     : false;
      const { findById: findCfg } = await import('../../../storage/db.js');
      const dbCfgFull = findCfg<{ gitRemoteUrl?: string; gitAutoCommit?: boolean; gitBranch?: string }>('dmcr_config', 'main');
      webview.postMessage({
        type: 'dmcrConfig',
        payload: {
          env:              dmcrSec['env']               ?? 'dev',
          changesDir:       dmcrSec['changes_dir']       ?? '',
          psqlPath:         dmcrSec['psql_path']         ?? '',
          lockTimeout:      dmcrSec['lock_timeout']      ?? '30s',
          statementTimeout: dmcrSec['statement_timeout'] ?? '5min',
          runHistoryLimit:  String(dmcrSec['run_history_limit'] ?? (dbCfgFull as any)?.runHistoryLimit ?? 50),
          // URL (no password) from cfg; password stored separately in keychain
          devConnUrl:     devSec['conn']     ?? '',
          prodConnUrl:    prodSec['conn']    ?? '',
          compareConnUrl: compareSec['conn'] ?? '',
          extraEnvs,
          hasDevPassword,
          hasProdPassword,
          // Legacy flags so UI can show "already stored" for old installs
          hasDevConn,
          hasProdConn,
          cfgPath: cfgPath || '',
          gitRemoteUrl:  dbCfgFull?.gitRemoteUrl  ?? '',
          gitAutoCommit: dbCfgFull?.gitAutoCommit ?? false,
          gitBranch:     dbCfgFull?.gitBranch     ?? '',
        },
      });
      return true;
    }

    case "saveDmcrConfig": {
      try {
        const {
          env, changesDir: cd, psqlPath, lockTimeout, statementTimeout, runHistoryLimit,
          devConnUrl, devPassword, prodConnUrl, prodPassword,
          compareConnUrl, extraEnvs,
          gitRemoteUrl, gitAutoCommit, gitBranch,
        } = msg.payload as {
          env: string; changesDir: string; psqlPath: string;
          lockTimeout: string; statementTimeout: string;
          runHistoryLimit?: number;
          devConnUrl: string | null; devPassword: string | null;
          prodConnUrl: string | null; prodPassword: string | null;
          compareConnUrl?: string | null;
          extraEnvs?: { name: string; connUrl: string }[];
          gitRemoteUrl?: string; gitAutoCommit?: boolean; gitBranch?: string;
        };
        const extCtx = ctx.extensionContext;
        if (extCtx) {
          if (devPassword)  await extCtx.secrets.store('dmcr.devPassword',  devPassword);
          if (prodPassword) await extCtx.secrets.store('dmcr.prodPassword', prodPassword);
        }
        const hasDevPassword  = extCtx ? !!(await extCtx.secrets.get('dmcr.devPassword'))  : !!devPassword;
        const hasProdPassword = extCtx ? !!(await extCtx.secrets.get('dmcr.prodPassword')) : !!prodPassword;
        const cfgContent = buildDmcrCfg({
          env: env ?? 'dev',
          changesDir: cd ?? '',
          psqlPath:   psqlPath ?? '',
          lockTimeout: lockTimeout ?? '30s',
          statementTimeout: statementTimeout ?? '5min',
          devConnUrl:     devConnUrl     ?? '',
          prodConnUrl:    prodConnUrl    ?? '',
          compareConnUrl: compareConnUrl ?? '',
          extraEnvs: (extraEnvs ?? []).filter(e => e.name.trim()),
        });
        const cfgPath = getUserCfgPath();
        if (!cfgPath) throw new Error('DMCR runner directory is not initialised.');
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, cfgContent, 'utf8');

        // Persist config to SQLite so DB Explorer can show it
        // and saveChangeToDisk can resolve changesDir without a workspace open.
        const { upsert } = await import('../../../storage/db.js');
        upsert('dmcr_config', 'main', {
          env:              env              ?? 'dev',
          changesDir:       cd              ?? '',
          psqlPath:         psqlPath        ?? '',
          lockTimeout:      lockTimeout     ?? '30s',
          statementTimeout: statementTimeout ?? '5min',
          devConnUrl:       devConnUrl      ?? '',
          prodConnUrl:      prodConnUrl     ?? '',
          compareConnUrl:   compareConnUrl  ?? '',
          extraEnvs:        JSON.stringify((extraEnvs ?? []).filter(e => e.name.trim())),
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
        webview.postMessage({ type: 'dmcrConfigSaved', payload: { hasDevPassword, hasProdPassword, cfgPath } });
      } catch (err: unknown) {
        // Always unblock the save button — never leave the UI in a stuck "Saving…" state
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'dmcrConfigError', payload: { message: errMsg } });
      }
      return true;
    }

    case "testDbConnection": {
      const { conn, env } = msg.payload as { conn: string; env: 'dev' | 'prod' };

      // Resolve full connection string: URL from payload/cfg + password from keychain
      let connString = conn?.trim() ?? '';
      if (ctx.extensionContext) {
        const passwordKey = env === 'prod' ? 'dmcr.prodPassword' : 'dmcr.devPassword';
        const password = (await ctx.extensionContext.secrets.get(passwordKey)) ?? '';
        if (connString && password) {
          // Inject password into the URL
          try {
            const u = new URL(connString);
            u.password = password;
            connString = u.toString();
          } catch { /* malformed URL, use as-is */ }
        }
        // Legacy fallback: full URL stored in dmcr.devConn / dmcr.prodConn
        if (!connString) {
          const legacyKey = env === 'prod' ? 'dmcr.prodConn' : 'dmcr.devConn';
          connString = (await ctx.extensionContext.secrets.get(legacyKey)) ?? '';
        }
      }

      if (!connString) {
        webview.postMessage({ type: 'testDbConnectionResult', payload: { ok: false, message: 'No connection string configured', env } });
        return true;
      }

      // Discover psql
      const psqlCandidates = [
        process.env.DMCR_PSQL,
        '/opt/homebrew/bin/psql',
        '/usr/local/bin/psql',
        'psql',
      ].filter(Boolean) as string[];

      // Also check the saved psql_path from dmcr.cfg
      try {
        const cfgPath = getUserCfgPath();
        if (cfgPath && fs.existsSync(cfgPath)) {
          const parsed = parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'));
          const saved = parsed['dmcr']?.['psql_path'];
          if (saved) psqlCandidates.unshift(saved);
        }
      } catch { /* ignore */ }

      const testPsql = (psqlBin: string): Promise<{ ok: boolean; message: string }> =>
        new Promise(resolve => {
          execFile(psqlBin, [connString, '-c', 'SELECT 1', '-t', '-A', '--no-password'], { timeout: 8000 }, (err, stdout, stderr) => {
            if (err) {
              const msg = (stderr || err.message || 'Unknown error').trim().replace(/\n/g, ' ').slice(0, 200);
              resolve({ ok: false, message: msg });
            } else {
              resolve({ ok: true, message: `psql reachable (${psqlBin})` });
            }
          });
        });

      let lastError = 'psql not found in PATH or common locations';
      for (const candidate of psqlCandidates) {
        try {
          const result = await testPsql(candidate);
          if (result.ok) {
            webview.postMessage({ type: 'testDbConnectionResult', payload: { ok: true, message: result.message, env } });
            return true;
          }
          lastError = result.message;
          break; // psql found but connection failed — no point trying other paths
        } catch {
          // binary not found, try next
        }
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    case "pickDangerRulesFolder": {
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: 'Use as danger rules folder',
      });
      if (result?.[0]) {
        const folderPath = vscode.workspace.asRelativePath(result[0], false);
        webview.postMessage({ type: 'dangerRulesFolderPicked', payload: { path: folderPath } });
      }
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
