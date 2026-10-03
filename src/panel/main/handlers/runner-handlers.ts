/**
 * Runner message handlers: lsChanges, runDmcr.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import type { HandlerContext, Message } from "./types";
import { parseDmcrIni } from "./types";
import { insertRunnerEvent } from "../../../storage/db";
import { getUserCfgPath, getUserDangerRulesPath } from "../../../storage/runner-paths";
import { callMcpTool } from "../../../services/mcp/agent/mcp-agent";

/** Extract the DDL string from a get_ddl MCP tool response.
 *  The tool returns either a plain string or { ddl: string, ... }.
 *  Returns '' when the object has no DDL or data is null/undefined. */
function extractDdlText(data: unknown): string {
  if (!data) return '';
  if (typeof data === 'string') {
    // Could itself be a JSON string wrapping the object
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && 'ddl' in parsed) {
        return String((parsed as { ddl?: string }).ddl ?? '');
      }
    } catch { /* not JSON — treat as raw DDL text */ }
    return data;
  }
  if (typeof data === 'object' && 'ddl' in data) {
    return String((data as { ddl?: string }).ddl ?? '');
  }
  return '';
}

/** Scan a McpServerConfig for an embedded PostgreSQL connection URL. */
function extractServerConnUrl(server: { args?: string[]; env?: Record<string, string> }): string | null {
  if (server.args) {
    for (const arg of server.args) {
      if (/^(postgresql|postgres):\/\//.test(arg)) return arg;
    }
  }
  if (server.env) {
    for (const key of ['DATABASE_URL', 'PG_CONN', 'PG_DSN', 'POSTGRES_URL', 'DB_URL']) {
      const val = server.env[key];
      if (val && /^(postgresql|postgres):\/\//.test(val)) return val;
    }
  }
  return null;
}

/** Track the active dmcr child process so it can be killed on panel dispose / VS Code exit. */
let _activeChild: cp.ChildProcess | null = null;
let _activeStartTime: number | null = null;
let _activeCommand: string | null = null;

/** Kill the active runner child process (called from panel dispose / extension deactivate). */
export function killActiveRunnerChild(): void {
  if (_activeChild && !_activeChild.killed) {
    _activeChild.kill();
    insertRunnerEvent({ action: 'kill', status: 'info', message: 'Process killed on deactivate/dispose', command: _activeCommand });
    _activeChild = null;
    _activeStartTime = null;
    _activeCommand = null;
  }
}

export async function handleRunnerMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;

  switch (msg.type) {

    /* ── Runner tab: list changes directory ── */
    case "lsChanges": {
      const { pattern, mode } = msg.payload as { pattern?: string; mode?: 'ls' | 'it' };

      // Resolve changesDir: SQLite dmcr_config (absolute) > dmcr.cfg > workspace fallback
      const { findById: findDbCfg } = await import('../../../storage/db.js');
      const dbStoredCfg = findDbCfg<{ changesDir?: string }>('dmcr_config', 'main');
      let changesDirRel = dbStoredCfg?.changesDir ?? '';

      if (!changesDirRel) {
        const userCfgLs = getUserCfgPath();
        const cfgCandidatesLs = userCfgLs ? [userCfgLs] : [];
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws) {
          cfgCandidatesLs.push(
            path.join(ws.uri.fsPath, 'dmcr.cfg'),
            path.join(ws.uri.fsPath, 'dmcr', 'dmcr.cfg'),
            path.join(ws.uri.fsPath, 'v2', 'dmcr.cfg'),
          );
        }
        for (const c of cfgCandidatesLs) {
          if (fs.existsSync(c)) {
            const parsed = parseDmcrIni(fs.readFileSync(c, 'utf8'));
            const fromIni = parsed['dmcr']?.['changes_dir'];
            if (fromIni) { changesDirRel = fromIni; break; }
          }
        }
      }

      if (!changesDirRel) {
        webview.postMessage({ type: 'lsChangesResult', payload: { error: 'No changes directory configured. Set one in Settings → DMCR Config.' } });
        return true;
      }

      const wsRoot = vscode.workspace.workspaceFolders?.[0];
      const changesAbs = path.isAbsolute(changesDirRel)
        ? changesDirRel
        : wsRoot ? path.join(wsRoot.uri.fsPath, changesDirRel) : '';
      if (!changesAbs || !fs.existsSync(changesAbs)) {
        webview.postMessage({ type: 'lsChangesResult', payload: { error: `Changes dir not found: ${changesAbs}` } });
        return true;
      }
      let folders = fs.readdirSync(changesAbs, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^\d{3}_.+/.test(d.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => {
          const files = (() => { try { return fs.readdirSync(path.join(changesAbs, d.name)); } catch { return []; } })();
          return { name: d.name, files };
        });
      if (pattern) {
        const hasWildcard = pattern.includes('*');
        const globPat = hasWildcard ? pattern : `*${pattern}*`;
        const rx = new RegExp('^' + globPat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
        folders = folders.filter(f => rx.test(f.name));
      }
      webview.postMessage({ type: 'lsChangesResult', payload: { changesDir: changesDirRel, folders, mode } });
      return true;
    }

    /* ── Runner tab: spawn dmcr.sh (macOS/Linux) or dmcr.ps1 (Windows) and stream output ── */
    case "runDmcr": {
      const { args = [], scriptPath: customScript } = msg.payload as { args?: string[]; scriptPath?: string };

      const isWindows = process.platform === 'win32';
      const scriptName = isWindows ? 'dmcr.ps1' : 'dmcr.sh';
      const bundledScript = path.join(ctx.extensionPath, 'scripts', 'runner', scriptName);

      let resolvedScript: string | null = null;
      if (customScript && fs.existsSync(customScript)) {
        resolvedScript = customScript;
      } else {
        const cfgScript = vscode.workspace.getConfiguration('dmcr').get<string>('scriptPath', '');
        if (cfgScript && fs.existsSync(cfgScript)) {
          resolvedScript = cfgScript;
        } else if (fs.existsSync(bundledScript)) {
          resolvedScript = bundledScript;
        } else {
          // Try the alternate extension in case the workspace only has one variant
          const altName = isWindows ? 'dmcr.sh' : 'dmcr.ps1';
          const altBundled = path.join(ctx.extensionPath, 'scripts', 'runner', altName);
          if (fs.existsSync(altBundled)) {
            resolvedScript = altBundled;
          } else {
            const ws = vscode.workspace.workspaceFolders?.[0];
            const candidates: string[] = [];
            if (ws) {
              candidates.push(path.join(ws.uri.fsPath, scriptName));
              candidates.push(path.join(ws.uri.fsPath, 'dmcr', scriptName));
              candidates.push(path.join(ws.uri.fsPath, 'v2', scriptName));
            }
            for (const c of candidates) {
              if (fs.existsSync(c)) { resolvedScript = c; break; }
            }
          }
        }
      }

      if (!resolvedScript) {
        webview.postMessage({
          type: 'terminalData',
          payload: `\x1b[31m✗  Script not found: ${scriptName}\x1b[0m\r\n` +
            `\x1b[37m   Set dmcr.scriptPath in VS Code settings, or place ${scriptName} in the workspace root.\x1b[0m\r\n`,
        });
        webview.postMessage({ type: 'terminalExit', payload: { code: 1, expected: true } });
        return true;
      }

      const runEnv: NodeJS.ProcessEnv = { ...process.env, DMCR_ANSI_OUTPUT: '1' };
      const extraArgs: string[] = [];
      const wsRootForRun = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      // Relative changes_dir in dmcr.cfg is "from workspace root" — tell the script where that is.
      if (wsRootForRun && !runEnv['DMCR_BASE_DIR']) runEnv['DMCR_BASE_DIR'] = wsRootForRun;
      // Danger rules edited in Settings live in global storage, not next to the script.
      const userDangerRules = getUserDangerRulesPath();
      if (userDangerRules && fs.existsSync(userDangerRules) && !runEnv['DMCR_DANGER_RULES']) {
        runEnv['DMCR_DANGER_RULES'] = userDangerRules;
      }
      if (!runEnv['DMCR_CONFIG'] && !runEnv['DMCR_CONN']) {
        const ws = vscode.workspace.workspaceFolders?.[0];
        const cfgCandidates: string[] = [];
        const userCfg = getUserCfgPath();
        if (userCfg) cfgCandidates.push(userCfg);
        if (ws) {
          cfgCandidates.push(path.join(ws.uri.fsPath, 'dmcr.cfg'));
          cfgCandidates.push(path.join(ws.uri.fsPath, 'dmcr', 'dmcr.cfg'));
          cfgCandidates.push(path.join(ws.uri.fsPath, 'v2', 'dmcr.cfg'));
        }
        cfgCandidates.push(path.join(path.dirname(resolvedScript), 'dmcr.cfg'));
        const foundCfg = cfgCandidates.find(c => fs.existsSync(c));
        if (foundCfg) {
          extraArgs.push('-c', foundCfg);
          if (ctx.extensionContext) {
            const parsedCfg = parseDmcrIni(fs.readFileSync(foundCfg, 'utf8'));
            // The script prefers DMCR_CONN over the cfg, so build it for the env this run
            // actually targets: an explicit `--env <name>` wins over [dmcr].env.
            const envFlagIdx = args.indexOf('--env');
            const envFlag = envFlagIdx >= 0 ? args[envFlagIdx + 1] : undefined;
            const activeEnv = envFlag || parsedCfg['dmcr']?.['env'] || 'dev';
            // New model: URL in cfg + password in keychain
            const connUrl = parsedCfg[activeEnv]?.['conn'] ?? '';
            // Password key: dev → dmcr.devPassword, prod → dmcr.prodPassword, extra env → dmcr.<envName>Password
            const standardPasswordKey =
              activeEnv === 'dev'  ? 'dmcr.devPassword' :
              activeEnv === 'prod' ? 'dmcr.prodPassword' :
              `dmcr.${activeEnv}Password`;
            const password = (await ctx.extensionContext.secrets.get(standardPasswordKey)) ?? '';
            if (connUrl && password) {
              try {
                const u = new URL(connUrl);
                u.password = password;
                runEnv['DMCR_CONN'] = u.toString();
              } catch { runEnv['DMCR_CONN'] = connUrl; }
            } else if (connUrl) {
              runEnv['DMCR_CONN'] = connUrl;
            } else {
              // Legacy fallback: full URL stored in dmcr.devConn / dmcr.prodConn
              const legacyKey = activeEnv === 'prod' ? 'dmcr.prodConn' : 'dmcr.devConn';
              const legacy = await ctx.extensionContext.secrets.get(legacyKey);
              if (legacy) runEnv['DMCR_CONN'] = legacy;
            }
            // Pass DMCR_PSQL if a custom psql path is configured — dmcr.sh will use it
            const cfgPsqlPath = parsedCfg['dmcr']?.['psql_path'] ?? '';
            if (cfgPsqlPath && !runEnv['DMCR_PSQL']) {
              runEnv['DMCR_PSQL'] = cfgPsqlPath;
            }
          }
        } else if (resolvedScript === bundledScript) {
          const devPassword = ctx.extensionContext ? await ctx.extensionContext.secrets.get('dmcr.devPassword') : null;
          const devLegacy   = ctx.extensionContext ? await ctx.extensionContext.secrets.get('dmcr.devConn')    : null;
          if (devPassword) {
            runEnv['DMCR_CONN'] = devPassword; // password alone; script should handle bare-pass or URL will be in cfg
          } else if (devLegacy) {
            runEnv['DMCR_CONN'] = devLegacy;
          } else {
            webview.postMessage({
              type: 'terminalData',
              payload: [
                '\x1b[33m⚠  Configuration needed\x1b[0m\r\n',
                '\x1b[37m   No dmcr.cfg found and no connection string configured.\x1b[0m\r\n',
                '\x1b[37m   Go to Settings → DMCR Config to add your connection, or create a dmcr.cfg\x1b[0m\r\n',
                '\x1b[37m   in your workspace root.\x1b[0m\r\n\r\n',
                '\x1b[90m   Minimal dmcr.cfg example:\x1b[0m\r\n',
                '\x1b[36m   [dmcr]\x1b[0m\r\n',
                '\x1b[36m   env = dev\x1b[0m\r\n',
                '\x1b[36m   changes_dir = db/changes\x1b[0m\r\n\r\n',
                '\x1b[36m   [dev]\x1b[0m\r\n',
                '\x1b[36m   conn = postgresql://user:pass@host:5432/mydb?sslmode=require\x1b[0m\r\n',
              ].join(''),
            });
            webview.postMessage({ type: 'terminalExit', payload: { code: 1, expected: true } });
            return true;
          }
        }
      }

      // Determine executor: bash on macOS/Linux, pwsh/powershell on Windows
      const isBashScript = resolvedScript.endsWith('.sh');
      let executor: string;
      let spawnArgs: string[];

      // Use JSON mode for all commands except 'parse' (which outputs psql text)
      const baseCommand = args[0]?.toLowerCase() ?? '';
      const useJsonMode = baseCommand !== 'parse';
      const jsonArgs = useJsonMode && !args.includes('--json') ? ['--json'] : [];

      if (isBashScript) {
        // Prefer Homebrew bash (4.x) on macOS — ships with associative array support
        const brewBash = '/opt/homebrew/bin/bash';
        executor = fs.existsSync(brewBash) ? brewBash : '/bin/bash';
        spawnArgs = [resolvedScript, ...args, ...jsonArgs, ...extraArgs];
        try { fs.chmodSync(resolvedScript, 0o755); } catch { /* ignore */ }
      } else {
        const cfgPwsh = vscode.workspace.getConfiguration('dmcr').get<string>('pwshPath', '');
        executor = cfgPwsh || 'pwsh';
        spawnArgs = ['-NonInteractive', '-File', resolvedScript, ...args, ...jsonArgs, ...extraArgs];
      }

      const cmdLabel = args.join(' ');
      _activeCommand = cmdLabel;
      _activeStartTime = Date.now();
      insertRunnerEvent({ action: 'run', status: 'info', message: `Started: ${cmdLabel}`, command: cmdLabel });

      const child = cp.spawn(executor, spawnArgs, { env: runEnv, shell: false, cwd: wsRootForRun });
      _activeChild = child;

      // In JSON mode: buffer stdout (clean JSON), stream stderr as ANSI progress lines
      // In text mode (parse): stream both stdout+stderr as ANSI
      let stdoutBuffer = '';
      let stderrCapture = '';
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '').replace(/\r/g, '');

      const sendAnsi = (data: Buffer | string) => {
        const str = data.toString().replace(/\r?\n/g, '\r\n');
        webview.postMessage({ type: 'terminalData', payload: str });
      };
      const sendStderr = (data: Buffer | string) => {
        const raw = data.toString();
        stderrCapture += raw;
        const str = raw.replace(/\r?\n/g, '\r\n');
        webview.postMessage({ type: 'terminalData', payload: str });
      };

      if (useJsonMode) {
        child.stdout.on('data', (chunk: Buffer | string) => { stdoutBuffer += chunk.toString(); });
        child.stderr.on('data', sendStderr);
      } else {
        child.stdout.on('data', sendAnsi);
        child.stderr.on('data', sendStderr);
      }

      // Node can emit BOTH 'error' and 'close' for a spawn that fails to start (e.g. ENOENT) —
      // `settled` guards against sending a duplicate/stale result once one path has won.
      // `awaitingRetry` additionally suppresses the original child's stale 'close' event while
      // we've abandoned it in favor of the pwsh→powershell.exe fallback child.
      let settled = false;
      let awaitingRetry = false;

      const finalize = (code: number | null, retryChild?: cp.ChildProcess) => {
        if (settled) return;
        settled = true;
        const dur = _activeStartTime ? Date.now() - _activeStartTime : null;
        insertRunnerEvent({ action: 'exit', status: code === 0 ? 'success' : 'failure', command: _activeCommand, exit_code: code, duration_ms: dur });
        _activeChild = null; _activeStartTime = null; _activeCommand = null;

        if (useJsonMode) {
          if (stdoutBuffer.trim()) {
            try {
              const parsed = JSON.parse(stdoutBuffer.trim());
              webview.postMessage({ type: 'terminalJsonResult', payload: { command: baseCommand, args, exitCode: code, data: parsed } });
            } catch {
              // Stdout wasn't valid JSON — treat as error
              const msg = stripAnsi(stdoutBuffer).trim();
              webview.postMessage({ type: 'terminalJsonResult', payload: { command: baseCommand, args, exitCode: code, data: { __synthetic: true, status: 'error', message: msg } } });
            }
          } else {
            // No stdout — build synthetic result from exit code + captured stderr
            const stderrLines = stripAnsi(stderrCapture)
              .split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 0);
            // For errors, prefer the last error-looking line as the summary message
            const errorLine = code !== 0
              ? (stderrLines.filter(l => l.includes('✗') || l.includes('✕') || /error/i.test(l)).pop()
                ?? stderrLines[stderrLines.length - 1]
                ?? `Command failed (exit ${code})`)
              : (stderrLines[stderrLines.length - 1] ?? 'Done');
            // Include full stderr as stackTrace so the UI can render it
            const stackTrace = code !== 0 && stderrLines.length > 0 ? stderrLines.join('\n') : undefined;
            webview.postMessage({
              type: 'terminalJsonResult',
              payload: {
                command: baseCommand, args, exitCode: code,
                data: { __synthetic: true, status: code === 0 ? 'ok' : 'error', message: errorLine, ...(stackTrace ? { stackTrace } : {}) },
              },
            });
          }
        }

        webview.postMessage({ type: 'terminalExit', payload: { code } });
        void retryChild;
      };

      child.on('error', (err) => {
        if (settled) return;
        // Windows only: if pwsh not found, fall back to powershell.exe
        if (isWindows && (err as NodeJS.ErrnoException).code === 'ENOENT' && executor === 'pwsh') {
          awaitingRetry = true;
          webview.postMessage({
            type: 'terminalData',
            payload: '\x1b[93mWARN: pwsh not found, retrying with powershell.exe…\x1b[0m\r\n',
          });
          stdoutBuffer = ''; stderrCapture = '';
          const child2 = cp.spawn('powershell', ['-NonInteractive', '-File', resolvedScript!, ...args, ...jsonArgs, ...extraArgs], { env: runEnv, shell: false, cwd: wsRootForRun });
          _activeChild = child2;
          if (useJsonMode) {
            child2.stdout.on('data', (chunk: Buffer | string) => { stdoutBuffer += chunk.toString(); });
            child2.stderr.on('data', sendStderr);
          } else {
            child2.stdout.on('data', sendAnsi);
            child2.stderr.on('data', sendStderr);
          }
          child2.on('close', (code2) => finalize(code2));
          child2.on('error', (e2) => {
            if (settled) return;
            settled = true;
            insertRunnerEvent({ action: 'error', status: 'failure', message: e2.message, command: _activeCommand });
            _activeChild = null; _activeStartTime = null; _activeCommand = null;
            webview.postMessage({ type: 'terminalData', payload: `\x1b[91mERROR: ${e2.message}\x1b[0m\r\n` });
            webview.postMessage({ type: 'terminalExit', payload: { code: 1 } });
          });
        } else {
          settled = true;
          insertRunnerEvent({ action: 'error', status: 'failure', message: err.message, command: _activeCommand });
          _activeChild = null; _activeStartTime = null; _activeCommand = null;
          webview.postMessage({ type: 'terminalData', payload: `\x1b[91mERROR: ${err.message}\x1b[0m\r\n` });
          webview.postMessage({ type: 'terminalExit', payload: { code: 1 } });
        }
      });

      child.on('close', (code) => {
        // Stale close from the original child after we've already moved on to the
        // powershell.exe retry — child2's own 'close' owns the final result.
        if (awaitingRetry) return;
        finalize(code);
      });
      return true;
    }

    /* ── Git sync: pull, stage all changes, AI commit, push ── */
    case "gitSync": {
      try {
        const { isGitAvailable, isGitRepo, fullSync, getChangesSummary, getCurrentBranch } = await import('../../../services/git/git-service.js');
        if (!(await isGitAvailable())) {
          webview.postMessage({ type: 'gitSyncResult', payload: { ok: false, error: 'git is not installed or not in PATH' } });
          return true;
        }
        if (!(await isGitRepo())) {
          webview.postMessage({ type: 'gitSyncResult', payload: { ok: false, error: 'Current workspace is not a git repository' } });
          return true;
        }

        // Resolve changes directory from SQLite
        const { findById: findGitSyncCfg } = await import('../../../storage/db.js');
        const gitSyncStoredCfg = findGitSyncCfg<{ changesDir?: string }>('dmcr_config', 'main');
        const changesDirRel = gitSyncStoredCfg?.changesDir ?? '';
        const wsGit = vscode.workspace.workspaceFolders?.[0];
        const changesAbs = changesDirRel && path.isAbsolute(changesDirRel)
          ? changesDirRel
          : wsGit && changesDirRel ? path.join(wsGit.uri.fsPath, changesDirRel) : '';
        if (!changesAbs) {
          webview.postMessage({ type: 'gitSyncResult', payload: { ok: false, error: 'No changes directory configured. Set one in Settings → DMCR Config.' } });
          return true;
        }

        // Generate AI commit message
        let commitMsg = 'chore(db): sync changes';
        try {
          const { getResolvedPrompt, getResolvedUserPrompt } = await import('../../../storage/prompt-library.js');
          const summary = await getChangesSummary(changesAbs);
          const branch = await getCurrentBranch();
          const systemPrompt = getResolvedPrompt('GIT_COMMIT_MESSAGE', {});
          const userPrompt = getResolvedUserPrompt('GIT_COMMIT_MESSAGE', {
            folderName: 'multiple',
            deploySql: summary.slice(0, 2000),
            changeSummary: summary,
            branch,
          });
          const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
          const t0 = Date.now();
          const aiMsg = await callActiveLlm(systemPrompt, userPrompt, 0.1);
          if (aiMsg && aiMsg.trim().length > 5 && aiMsg.trim().length < 200) {
            commitMsg = aiMsg.trim();
          }
          // Audit log the LLM call
          try {
            const { insertAudit } = await import('../../../storage/db.js');
            insertAudit({
              conversation_id: 'git-sync-manual',
              stage: 'GIT_COMMIT_MESSAGE',
              system_prompt: systemPrompt.slice(0, 2000),
              user_prompt: userPrompt.slice(0, 2000),
              response_payload: JSON.stringify({ commitMessage: commitMsg }),
              duration_ms: Date.now() - t0,
              meta: JSON.stringify({ changesDir: changesDirRel, branch, trigger: '/sync' }),
            });
          } catch { /* audit is best-effort */ }
        } catch {
          // Use default commit message
        }

        const result = await fullSync(changesAbs, commitMsg);
        webview.postMessage({ type: 'gitSyncResult', payload: result });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'gitSyncResult', payload: { ok: false, error: errMsg } });
      }
      return true;
    }

    case "listMcpServers": {
      try {
        const { getConfiguredMcpServers } = await import('../../../services/mcp/agent/mcp-agent.js');
        const allServers = getConfiguredMcpServers();
        const servers = allServers.map(s => ({
          id: s.id,
          name: s.name,
          connAvailable: !!extractServerConnUrl(s),
        }));
        webview.postMessage({ type: 'mcpServers', payload: servers });
      } catch {
        webview.postMessage({ type: 'mcpServers', payload: [] });
      }
      return true;
    }

    case "compareSchemasMcp": {
      const { sourceServerId, targetServerId, schema, objectTypes } = msg.payload as {
        sourceServerId?: string;
        targetServerId?: string;
        schema?: string;
        objectTypes?: string[];
      };
      webview.postMessage({ type: 'schemaMcpProgress', payload: { text: 'Looking up MCP servers…' } });
      try {
        const { getConfiguredMcpServers } = await import('../../../services/mcp/agent/mcp-agent.js');
        const allServers = getConfiguredMcpServers();

        const srcServer = sourceServerId ? allServers.find(s => s.id === sourceServerId) : allServers[0];
        const tgtServer = targetServerId ? allServers.find(s => s.id === targetServerId) : undefined;

        if (!srcServer) {
          webview.postMessage({ type: 'schemaMcpResult', payload: { ok: false, error: 'No source MCP server found. Configure at least one in Settings → MCP Servers.' } });
          return true;
        }

        const args: Record<string, unknown> = {};
        if (tgtServer) {
          const tgtConn = extractServerConnUrl(tgtServer);
          if (tgtConn) {
            args['second_conn'] = tgtConn;
          } else {
            webview.postMessage({ type: 'schemaMcpResult', payload: { ok: false, error: `Cannot extract a PostgreSQL connection URL from "${tgtServer.name}". Add a postgresql:// URL to the server args in Settings → MCP Servers.` } });
            return true;
          }
        }
        if (schema?.trim()) args['schema'] = schema.trim();
        if (objectTypes && objectTypes.length > 0) args['object_types'] = objectTypes;

        webview.postMessage({ type: 'schemaMcpProgress', payload: { text: `Running compare_schemas on ${srcServer.name}…` } });
        const result = await callMcpTool('compare_schemas', args, srcServer.id);
        if (!result.success) {
          webview.postMessage({ type: 'schemaMcpResult', payload: { ok: false, error: result.error || 'compare_schemas failed' } });
          return true;
        }

        // AI summary
        webview.postMessage({ type: 'schemaMcpProgress', payload: { text: 'Generating AI drift analysis…' } });
        let aiAnalysis: Record<string, unknown> | null = null;
        try {
          const { getResolvedPrompt, getResolvedUserPrompt } = await import('../../../storage/prompt-library.js');
          const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
          const sysPrompt = getResolvedPrompt('SCHEMA_DRIFT_SUMMARY');
          const userPrompt = getResolvedUserPrompt('SCHEMA_DRIFT_SUMMARY', {
            driftJson: JSON.stringify(result.data, null, 2),
          });
          const t0 = Date.now();
          const aiRaw = await callActiveLlm(sysPrompt, userPrompt, 0.1);
          try { aiAnalysis = JSON.parse(aiRaw.trim()); } catch { /* non-JSON response — skip */ }
          try {
            const { insertAudit } = await import('../../../storage/db.js');
            insertAudit({
              conversation_id: 'schema-drift-analysis',
              stage: 'SCHEMA_DRIFT_SUMMARY',
              system_prompt: sysPrompt.slice(0, 2000),
              user_prompt: userPrompt.slice(0, 2000),
              response_payload: JSON.stringify({ aiAnalysis }),
              duration_ms: Date.now() - t0,
              meta: JSON.stringify({ sourceServerId, targetServerId, schema }),
            });
          } catch { /* audit best-effort */ }
        } catch { /* AI summary is best-effort */ }

        webview.postMessage({ type: 'schemaMcpResult', payload: { ok: true, data: result.data, aiAnalysis } });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'schemaMcpResult', payload: { ok: false, error: errMsg } });
      }
      return true;
    }

    case "fetchDdlPairs": {
      const { sourceServerId: srcId, targetServerId: tgtId, items } = msg.payload as {
        sourceServerId: string; targetServerId: string;
        items: Array<{ schema: string; name: string; type: string }>;
      };
      webview.postMessage({ type: 'schemaMcpProgress', payload: { text: `Fetching DDL for ${items.length} object(s)…` } });
      try {
        const pairs = [];
        for (const item of items) {
          const ddlArgs = { schema: item.schema, name: item.name, object_type: item.type };
          const [srcRes, tgtRes] = await Promise.all([
            callMcpTool('get_ddl', ddlArgs, srcId),
            callMcpTool('get_ddl', ddlArgs, tgtId),
          ]);
          const srcDdl = extractDdlText(srcRes.success ? srcRes.data : null);
          const tgtDdl = extractDdlText(tgtRes.success ? tgtRes.data : null);
          pairs.push({ id: `${item.schema}|${item.type}|${item.name}`, schema: item.schema, name: item.name, type: item.type, sourceDdl: srcDdl, targetDdl: tgtDdl });
        }
        webview.postMessage({ type: 'ddlPairsResult', payload: { ok: true, pairs } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'ddlPairsResult', payload: { ok: false, error: errMsg } });
      }
      return true;
    }

    case "clearDmcrLock": {
      const os = await import('os');
      const lockDir = path.join(os.tmpdir(), 'dmcr_locks');
      try {
        const files = fs.readdirSync(lockDir).filter((f: string) => /^dmcr_.*\.lock$/.test(f));
        for (const f of files) {
          try { fs.unlinkSync(path.join(lockDir, f)); } catch { /* best-effort */ }
        }
        webview.postMessage({ type: 'clearLockResult', payload: { ok: true, cleared: files.length } });
      } catch {
        webview.postMessage({ type: 'clearLockResult', payload: { ok: true, cleared: 0 } });
      }
      return true;
    }

    default:
      return false;
  }
}
