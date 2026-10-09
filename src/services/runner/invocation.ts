/**
 * How to start the DMCR runner (dmcr.ps1 / dmcr.sh): which script, which executor, the config file
 * and the environment (connection built from dmcr.cfg + the password in the keychain).
 * Shared by the Runner tab and the generation self-check, so both run the runner the same way.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { parseDmcrIni } from "../../panel/main/handlers/types";
import { getUserCfgPath, getUserDangerRulesPath } from "../../storage/runner-paths";

export type RunnerInvocation = {
  executor: string;
  spawnArgs: string[];
  env: NodeJS.ProcessEnv;
  cwd: string | undefined;
  script: string;
  /** --json (unless the command is 'parse') */
  jsonArgs: string[];
  /** -c <cfg> */
  extraArgs: string[];
  cfgPath?: string;
};

export type RunnerInvocationError = { error: 'script-not-found' | 'config-needed'; scriptName: string };

/** The dmcr.cfg the runner will use ('' when there is none). */
export function findRunnerConfig(script: string): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const candidates: string[] = [];
  const userCfg = getUserCfgPath();
  if (userCfg) candidates.push(userCfg);
  if (ws) {
    candidates.push(path.join(ws.uri.fsPath, 'dmcr.cfg'));
    candidates.push(path.join(ws.uri.fsPath, 'dmcr', 'dmcr.cfg'));
    candidates.push(path.join(ws.uri.fsPath, 'v2', 'dmcr.cfg'));
  }
  candidates.push(path.join(path.dirname(script), 'dmcr.cfg'));
  return candidates.find(c => fs.existsSync(c)) ?? '';
}

export function resolveRunnerScript(extensionPath: string, customScript?: string): { script: string | null; scriptName: string } {
  const isWindows = process.platform === 'win32';
  const scriptName = isWindows ? 'dmcr.ps1' : 'dmcr.sh';
  const bundledScript = path.join(extensionPath, 'scripts', 'runner', scriptName);
  if (customScript && fs.existsSync(customScript)) return { script: customScript, scriptName };
  const cfgScript = vscode.workspace.getConfiguration('dmcr').get<string>('scriptPath', '');
  if (cfgScript && fs.existsSync(cfgScript)) return { script: cfgScript, scriptName };
  if (fs.existsSync(bundledScript)) return { script: bundledScript, scriptName };
  // Try the alternate extension in case the workspace only has one variant
  const altName = isWindows ? 'dmcr.sh' : 'dmcr.ps1';
  const altBundled = path.join(extensionPath, 'scripts', 'runner', altName);
  if (fs.existsSync(altBundled)) return { script: altBundled, scriptName };
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (ws) {
    for (const c of [path.join(ws.uri.fsPath, scriptName), path.join(ws.uri.fsPath, 'dmcr', scriptName), path.join(ws.uri.fsPath, 'v2', scriptName)]) {
      if (fs.existsSync(c)) return { script: c, scriptName };
    }
  }
  return { script: null, scriptName };
}

/**
 * @param changesDirOverride run against another changes folder (the self-check's temporary copy):
 *        a copy of the config with changes_dir pointing there is written next to it.
 */
export async function buildRunnerInvocation(opts: {
  extensionPath: string;
  extensionContext?: vscode.ExtensionContext;
  args: string[];
  customScript?: string;
  changesDirOverride?: string;
}): Promise<RunnerInvocation | RunnerInvocationError> {
  const { args } = opts;
  const { script: resolvedScript, scriptName } = resolveRunnerScript(opts.extensionPath, opts.customScript);
  if (!resolvedScript) return { error: 'script-not-found', scriptName };
  const bundledScript = path.join(opts.extensionPath, 'scripts', 'runner', scriptName);

  const runEnv: NodeJS.ProcessEnv = { ...process.env, DMCR_ANSI_OUTPUT: '1' };
  const extraArgs: string[] = [];
  let cfgPath: string | undefined;
  const wsRootForRun = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Relative changes_dir in dmcr.cfg is "from workspace root" — tell the script where that is.
  if (wsRootForRun && !runEnv['DMCR_BASE_DIR']) runEnv['DMCR_BASE_DIR'] = wsRootForRun;
  // Danger rules edited in Settings live in global storage, not next to the script.
  const userDangerRules = getUserDangerRulesPath();
  if (userDangerRules && fs.existsSync(userDangerRules) && !runEnv['DMCR_DANGER_RULES']) {
    runEnv['DMCR_DANGER_RULES'] = userDangerRules;
  }
  if (!runEnv['DMCR_CONFIG'] && !runEnv['DMCR_CONN']) {
    const foundCfg = findRunnerConfig(resolvedScript);
    if (foundCfg) {
      const cfgText = fs.readFileSync(foundCfg, 'utf8');
      cfgPath = foundCfg;
      if (opts.changesDirOverride) {
        // Same config, other changes folder: rewrite changes_dir in a private copy
        const lines = cfgText.split(/\r?\n/);
        let inDmcr = false; let replaced = false;
        for (let i = 0; i < lines.length; i++) {
          const sec = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
          if (sec) { if (inDmcr && !replaced) { lines.splice(i, 0, `changes_dir = ${opts.changesDirOverride}`); replaced = true; i++; } inDmcr = sec[1].trim() === 'dmcr'; continue; }
          if (inDmcr && /^\s*changes_dir\s*=/.test(lines[i])) { lines[i] = `changes_dir = ${opts.changesDirOverride}`; replaced = true; }
        }
        if (!replaced) lines.push(inDmcr ? `changes_dir = ${opts.changesDirOverride}` : `[dmcr]\nchanges_dir = ${opts.changesDirOverride}`);
        const tmpCfg = path.join(path.dirname(opts.changesDirOverride), 'dmcr.cfg');
        fs.writeFileSync(tmpCfg, lines.join(os.EOL), 'utf8');
        cfgPath = tmpCfg;
      }
      extraArgs.push('-c', cfgPath);
      if (opts.extensionContext) {
        const parsedCfg = parseDmcrIni(cfgText);
        // The script prefers DMCR_CONN over the cfg, so build it for the env this run
        // actually targets: an explicit `--env <name>` wins over [dmcr].env.
        const envFlagIdx = args.indexOf('--env');
        const envFlag = envFlagIdx >= 0 ? args[envFlagIdx + 1] : undefined;
        const activeEnv = envFlag || parsedCfg['dmcr']?.['env'] || 'dev';
        // New model: URL in cfg + password in keychain.
        // Password key: dev → dmcr.devPassword, prod → dmcr.prodPassword, extra env → dmcr.<envName>Password
        const secrets = opts.extensionContext.secrets;
        const connForEnv = async (envName: string): Promise<string | undefined> => {
          const connUrl = parsedCfg[envName]?.['conn'] ?? '';
          const passwordKey =
            envName === 'dev'  ? 'dmcr.devPassword' :
            envName === 'prod' ? 'dmcr.prodPassword' :
            `dmcr.${envName}Password`;
          const password = (await secrets.get(passwordKey)) ?? '';
          if (connUrl && password) {
            try {
              const u = new URL(connUrl);
              u.password = password;
              return u.toString();
            } catch { return connUrl; }
          }
          if (connUrl) return connUrl;
          // Legacy fallback: full URL stored in dmcr.devConn / dmcr.prodConn
          return (await secrets.get(envName === 'prod' ? 'dmcr.prodConn' : 'dmcr.devConn')) || undefined;
        };
        const activeConn = await connForEnv(activeEnv);
        if (activeConn) runEnv['DMCR_CONN'] = activeConn;
        // Promotion gate: the runner reads the source env's registry (promote_from = <env>)
        const promoteFrom = (parsedCfg[activeEnv]?.['promote_from'] ?? '').trim();
        if (promoteFrom && promoteFrom !== activeEnv && !runEnv['DMCR_PROMOTE_FROM_CONN']) {
          const srcConn = await connForEnv(promoteFrom);
          if (srcConn) runEnv['DMCR_PROMOTE_FROM_CONN'] = srcConn;
        }
        // Pass DMCR_PSQL if a custom psql path is configured — dmcr.sh will use it
        const cfgPsqlPath = parsedCfg['dmcr']?.['psql_path'] ?? '';
        if (cfgPsqlPath && !runEnv['DMCR_PSQL']) {
          runEnv['DMCR_PSQL'] = cfgPsqlPath;
        }
      }
    } else if (resolvedScript === bundledScript) {
      const devPassword = opts.extensionContext ? await opts.extensionContext.secrets.get('dmcr.devPassword') : null;
      const devLegacy   = opts.extensionContext ? await opts.extensionContext.secrets.get('dmcr.devConn')    : null;
      if (devPassword) {
        runEnv['DMCR_CONN'] = devPassword; // password alone; script should handle bare-pass or URL will be in cfg
      } else if (devLegacy) {
        runEnv['DMCR_CONN'] = devLegacy;
      } else {
        return { error: 'config-needed', scriptName };
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
    // -ExecutionPolicy Bypass (this process only): Windows PowerShell's default policy on
    // client machines is Restricted, which refuses to run dmcr.ps1. -NoProfile keeps user
    // profiles from changing the runner's behaviour or slowing it down.
    spawnArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolvedScript, ...args, ...jsonArgs, ...extraArgs];
  }

  return { executor, spawnArgs, env: runEnv, cwd: wsRootForRun, script: resolvedScript, jsonArgs, extraArgs, cfgPath };
}
