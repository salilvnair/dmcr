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
import { buildRunnerInvocation } from "../../../services/runner/invocation";
import { callMcpTool } from "../../../services/mcp/agent/mcp-agent";
import { hasServerConn, serverConnUrl } from "../../../services/mcp/server/conn-url";
import { compareChangeIds, isChangeFolder } from '../../../storage/change-order';
import { getUserCfgPath } from '../../../storage/runner-paths';
import type { UnresolvedConflict } from '../../../services/conflicts/deploy-gate';

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

/** A read-only query on one database server (pgsql_mcp's run_readonly_query: `{ columns, rows }`, 1000 rows a call) */
function mcpQuery(serverId: string) {
  return async (sql: string): Promise<{ columns: string[]; rows: (string | null)[][] }> => {
    const r = await callMcpTool('run_readonly_query', { sql, limit: 1000 }, serverId);
    let d = r.data as { columns?: string[]; rows?: (string | null)[][]; error?: string } | string | null;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* not JSON: an error text */ } }
    const o = (d && typeof d === 'object' ? d : {}) as { columns?: string[]; rows?: (string | null)[][]; error?: string };
    if (!r.success || o.error || !Array.isArray(o.rows)) throw new Error(String(o.error ?? r.error ?? (typeof d === 'string' ? d : 'the query returned no rows')));
    return { columns: o.columns ?? [], rows: o.rows };
  };
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

    /* ── Runner > test picker: how often each change passed a round trip (0 when its files changed since) ── */
    case "getTestPasses": {
      const { ids = [], requestId } = (msg.payload ?? {}) as { ids?: string[]; requestId?: string };
      try {
        const { resolveChangesDir } = await import('../../../storage/changes-dir.js');
        const { readTestPasses } = await import('../../../services/runner/test-passes.js');
        webview.postMessage({ type: 'testPasses', payload: { requestId, passes: readTestPasses(resolveChangesDir() ?? '', ids) } });
      } catch (e) {
        webview.postMessage({ type: 'testPasses', payload: { requestId, passes: {}, error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    /* ── Runner tab: list changes directory ── */
    case "lsChanges": {
      const { pattern, mode, requestId, latest, commits } = (msg.payload ?? {}) as { pattern?: string; mode?: 'ls' | 'it'; requestId?: string; latest?: number; commits?: boolean };

      // Same resolution as every other feature (DMCR Config > dmcr.cfg > VS Code setting)
      const { resolveChangesDir } = await import('../../../storage/changes-dir.js');
      const changesAbs = resolveChangesDir();
      if (!changesAbs || !fs.existsSync(changesAbs)) {
        webview.postMessage({ type: 'lsChangesResult', payload: { requestId, error: `Changes dir not found: ${changesAbs}` } });
        return true;
      }
      let folders = fs.readdirSync(changesAbs, { withFileTypes: true })
        .filter(d => d.isDirectory() && isChangeFolder(d.name) && d.name.length > d.name.indexOf('_') + 1) // 001_x … 999_x, 1000_x …
        .sort((a, b) => compareChangeIds(a.name, b.name))
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
      const total = folders.length;
      // the newest N, newest first (Settings > DMCR Config)
      if (latest && latest > 0) folders = folders.slice(-latest).reverse();
      // each folder's last commit (hash, message, when, who): one git log over the changes folder
      let withCommits: Array<{ name: string; files: string[]; commit?: { hash: string; subject: string; when: string; author: string } }> = folders;
      if (commits) {
        const out = await new Promise<string>(resolve => cp.execFile('git', ['log', '-n', '1000', '--format=%x1e%h%x1f%s%x1f%ar%x1f%an', '--name-only', '--', '.'], { cwd: changesAbs, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout))));
        const last = new Map<string, { hash: string; subject: string; when: string; author: string }>();
        const names = new Set(folders.map(f => f.name));
        for (const rec of out.split('\x1e')) {
          const [head, ...files] = rec.split('\n');
          const [hash, subject, when, author] = (head ?? '').split('\x1f');
          if (!hash) continue;
          for (const f of files) {
            const seg = f.trim().split('/').find(p => names.has(p));
            if (seg && !last.has(seg)) last.set(seg, { hash, subject: subject ?? '', when: when ?? '', author: author ?? '' });
          }
          if (last.size === names.size) break;
        }
        withCommits = folders.map(f => ({ ...f, commit: last.get(f.name) }));
      }
      webview.postMessage({ type: 'lsChangesResult', payload: { requestId, changesDir: changesAbs, folders: withCommits, mode, total } });
      return true;
    }

    /* ── Runner tab: spawn dmcr.sh (macOS/Linux) or dmcr.ps1 (Windows) and stream output ── */
    case "runDmcr": {
      const { args = [], scriptPath: customScript, captureId } = msg.payload as { args?: string[]; scriptPath?: string; captureId?: string };
      // captureId: a read-only run for another page (Releases: release list, dry runs). Nothing reaches
      // the Runner terminal or its history; the JSON result comes back as dmcrCaptureResult.
      const capture = typeof captureId === 'string' && captureId ? captureId : null;
      let captureText = '';
      let captureSent = false;
      const post = (m: { type: string; payload?: unknown }) => {
        if (!capture) { webview.postMessage(m); return; }
        if (m.type === 'terminalData') { captureText += String(m.payload ?? ''); return; }
        if (m.type === 'terminalJsonResult') {
          captureSent = true;
          webview.postMessage({ type: 'dmcrCaptureResult', payload: { ...(m.payload as Record<string, unknown>), captureId: capture } });
          return;
        }
        if (m.type === 'terminalExit' && !captureSent) {
          captureSent = true;
          const code = (m.payload as { code?: number | null })?.code ?? 1;
          const text = captureText.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '').replace(/\r/g, '').trim();
          webview.postMessage({ type: 'dmcrCaptureResult', payload: { captureId: capture, command: args[0] ?? '', args, exitCode: code, data: { __synthetic: true, status: code === 0 ? 'ok' : 'error', message: text || `Command failed (exit ${code})` } } });
        }
      };
      const track = !capture;   // only terminal runs are the panel's active child and go to run history

      const inv = await buildRunnerInvocation({ extensionPath: ctx.extensionPath, extensionContext: ctx.extensionContext, args, customScript });
      if ('error' in inv) {
        if (inv.error === 'script-not-found') {
          post({
            type: 'terminalData',
            payload: `\x1b[31m✗  Script not found: ${inv.scriptName}\x1b[0m\r\n` +
              `\x1b[37m   Set dmcr.scriptPath in VS Code settings, or place ${inv.scriptName} in the workspace root.\x1b[0m\r\n`,
          });
        } else {
          post({
            type: 'terminalData',
            payload: [
              '\x1b[33m▲  Configuration needed\x1b[0m\r\n',
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
        }
        post({ type: 'terminalExit', payload: { code: 1, expected: true } });
        return true;
      }
      const { executor, spawnArgs, env: runEnv, cwd: wsRootForRun, script: resolvedScript, jsonArgs, extraArgs } = inv;
      const isWindows = process.platform === 'win32';
      const baseCommand = args[0]?.toLowerCase() ?? '';

      // A deploy (and its dry run) is refused while a pending change has no project or no requested by:
      // a change outside every project never goes with a release, and nobody would know who asked for it
      // It is also refused while a conflict between changes it would deploy (Releases › Conflicts) is not resolved by
      // a merge change: the later change would silently replace the earlier one
      if (baseCommand === 'deploy') {
        const { resolveChangesDir } = await import('../../../storage/changes-dir.js');
        const dir = resolveChangesDir();
        const rows = dir ? await readDeployStatus(ctx, args, customScript) : null;
        const missing = rows && dir ? pendingWithoutReleaseFields(rows, dir) : [];
        // the same setting the runners read: conflict_check = block (default) | warn | off under [dmcr] in dmcr.cfg
        const mode = conflictCheckMode();
        const found = rows && dir && mode !== 'off' ? await unresolvedConflictsFor(rows, args, dir).catch(() => [] as UnresolvedConflict[]) : [];
        if (found.length && mode === 'warn') {
          post({ type: 'terminalData', payload: `[33m⚠  ${found.length} conflict${found.length > 1 ? 's' : ''} between changes ${found.length > 1 ? 'are' : 'is'} not resolved; conflict_check = warn: deploying anyway[0m
`
            + found.map(c => `[37m   ${c.object}[0m  [33m${c.label}: ${c.ours.change_id} vs ${c.theirs.change_id}[0m
`).join('') });
        }
        const conflicts = mode === 'block' ? found : [];
        if (missing.length || conflicts.length) {
          const env = args[args.indexOf('--env') + 1] && args.includes('--env') ? args[args.indexOf('--env') + 1] : '';
          const why = [
            ...(missing.length ? [`${missing.length} pending change${missing.length > 1 ? 's have' : ' has'} no project or no requested by (set them in Releases › Changes, the pencil on the row, and commit)`] : []),
            ...(conflicts.length ? [`${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} between changes ${conflicts.length > 1 ? 'are' : 'is'} not resolved (Releases › Conflicts: Merge, which commits the merge change)`] : []),
          ];
          const message = `Deploy refused: ${why.join('; ')}. Then deploy again.`;
          post({ type: 'terminalData', payload: `\x1b[31m✗  ${message}\x1b[0m\r\n`
            + missing.map(m => `\x1b[37m   ${m.change_id}\x1b[0m  \x1b[33mno ${m.missing.join(', no ')}\x1b[0m\r\n`).join('')
            + conflicts.map(c => `\x1b[37m   ${c.object}\x1b[0m  \x1b[33m${c.label}: ${c.ours.change_id} vs ${c.theirs.change_id}\x1b[0m\r\n`).join('') });
          post({ type: 'terminalJsonResult', payload: { command: 'deploy', args, exitCode: 1,
            data: { status: 'error', code: missing.length ? 'release_fields_missing' : 'conflicts_unresolved', env, message, missing, conflicts } } });
          post({ type: 'terminalExit', payload: { code: 1, expected: true } });
          return true;
        }
      }
      const useJsonMode = baseCommand !== 'parse';

      const cmdLabel = args.join(' ');
      const startedAt = Date.now();
      if (track) {
        _activeCommand = cmdLabel;
        _activeStartTime = startedAt;
        insertRunnerEvent({ action: 'run', status: 'info', message: `Started: ${cmdLabel}`, command: cmdLabel });
      }

      const child = cp.spawn(executor, spawnArgs, { env: runEnv, shell: false, cwd: wsRootForRun });
      if (track) _activeChild = child;

      // In JSON mode: buffer stdout (clean JSON), stream stderr as ANSI progress lines
      // In text mode (parse): stream both stdout+stderr as ANSI
      let stdoutBuffer = '';
      let stderrCapture = '';
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '').replace(/\r/g, '');

      const sendAnsi = (data: Buffer | string) => {
        const str = data.toString().replace(/\r?\n/g, '\r\n');
        post({ type: 'terminalData', payload: str });
      };
      const sendStderr = (data: Buffer | string) => {
        const raw = data.toString();
        stderrCapture += raw;
        const str = raw.replace(/\r?\n/g, '\r\n');
        post({ type: 'terminalData', payload: str });
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
        if (track) {
          const dur = Date.now() - startedAt;
          insertRunnerEvent({ action: 'exit', status: code === 0 ? 'success' : 'failure', command: _activeCommand, exit_code: code, duration_ms: dur });
          _activeChild = null; _activeStartTime = null; _activeCommand = null;
        }

        if (useJsonMode) {
          if (stdoutBuffer.trim()) {
            try {
              const parsed = JSON.parse(stdoutBuffer.trim());
              // a round trip that passed counts for the test picker (its files' fingerprint with it)
              if (baseCommand === 'test' && Array.isArray(parsed?.changes)) {
                void (async () => {
                  try {
                    const { resolveChangesDir } = await import('../../../storage/changes-dir.js');
                    const { recordTestPasses } = await import('../../../services/runner/test-passes.js');
                    const dir = resolveChangesDir();
                    if (dir) recordTestPasses(dir, parsed.changes);
                  } catch { /* the count is a convenience */ }
                })();
              }
              post({ type: 'terminalJsonResult', payload: { command: baseCommand, args, exitCode: code, data: parsed } });
            } catch {
              // Stdout wasn't valid JSON — treat as error
              const msg = stripAnsi(stdoutBuffer).trim();
              post({ type: 'terminalJsonResult', payload: { command: baseCommand, args, exitCode: code, data: { __synthetic: true, status: 'error', message: msg } } });
            }
          } else {
            // No stdout — build synthetic result from exit code + captured stderr
            const stderrLines = stripAnsi(stderrCapture)
              .split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 0);
            // dmcr.ps1 reports a failure as "✗  <message>" (possibly several lines), then the
            // PowerShell position ("At C:\…ps1:123 char:9") and "Stack trace:". Use that message.
            const markIdx = stderrLines.findIndex(l => /^[✗✕]\s/.test(l));
            const endIdx = markIdx >= 0 ? stderrLines.findIndex((l, i) => i > markIdx && (/^At .+:\d+ char:\d+$/.test(l) || l === 'Stack trace:')) : -1;
            const psMessage = markIdx >= 0 ? stderrLines.slice(markIdx, endIdx > markIdx ? endIdx : markIdx + 1).join('\n') : null;
            // Otherwise prefer the last error-looking line as the summary message
            const errorLine = code !== 0
              ? (psMessage ?? stderrLines.filter(l => l.includes('✗') || l.includes('✕') || /error/i.test(l)).pop()
                ?? stderrLines[stderrLines.length - 1]
                ?? `Command failed (exit ${code})`)
              : (stderrLines[stderrLines.length - 1] ?? 'Done');
            // Include full stderr as stackTrace so the UI can render it
            const stackTrace = code !== 0 && stderrLines.length > 0 ? stderrLines.join('\n') : undefined;
            post({
              type: 'terminalJsonResult',
              payload: {
                command: baseCommand, args, exitCode: code,
                data: { __synthetic: true, status: code === 0 ? 'ok' : 'error', message: errorLine, ...(stackTrace ? { stackTrace } : {}) },
              },
            });
          }
        }

        post({ type: 'terminalExit', payload: { code } });
        void retryChild;
      };

      child.on('error', (err) => {
        if (settled) return;
        // Windows only: if pwsh not found, fall back to powershell.exe
        if (isWindows && (err as NodeJS.ErrnoException).code === 'ENOENT' && executor === 'pwsh') {
          awaitingRetry = true;
          post({
            type: 'terminalData',
            payload: '\x1b[93mWARN: pwsh not found, retrying with powershell.exe…\x1b[0m\r\n',
          });
          stdoutBuffer = ''; stderrCapture = '';
          const child2 = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolvedScript!, ...args, ...jsonArgs, ...extraArgs], { env: runEnv, shell: false, cwd: wsRootForRun });
          if (track) _activeChild = child2;
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
            if (track) {
              insertRunnerEvent({ action: 'error', status: 'failure', message: e2.message, command: _activeCommand });
              _activeChild = null; _activeStartTime = null; _activeCommand = null;
            }
            post({ type: 'terminalData', payload: `\x1b[91mERROR: ${e2.message}\x1b[0m\r\n` });
            post({ type: 'terminalExit', payload: { code: 1 } });
          });
        } else {
          settled = true;
          if (track) {
            insertRunnerEvent({ action: 'error', status: 'failure', message: err.message, command: _activeCommand });
            _activeChild = null; _activeStartTime = null; _activeCommand = null;
          }
          post({ type: 'terminalData', payload: `\x1b[91mERROR: ${err.message}\x1b[0m\r\n` });
          post({ type: 'terminalExit', payload: { code: 1 } });
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
        const { resolveChangesDir: resolveGitSyncDir } = await import('../../../storage/changes-dir.js');
        const changesAbs = resolveGitSyncDir();
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
              meta: JSON.stringify({ changesDir: changesAbs, branch, trigger: '/sync' }),
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
          connAvailable: hasServerConn(s),
        }));
        webview.postMessage({ type: 'diffMcpServers', payload: servers });
      } catch {
        webview.postMessage({ type: 'diffMcpServers', payload: [] });
      }
      return true;
    }

    case "compareSchemasMcp": {
      const { sourceServerId, targetServerId, schema, targetSchema, objectTypes } = msg.payload as {
        sourceServerId?: string;
        targetServerId?: string;
        schema?: string;
        /** the target's schema when its name differs (prod zp vs test zp_st) */
        targetSchema?: string;
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
          const tgtConn = await serverConnUrl(tgtServer);
          if (tgtConn) {
            args['second_conn'] = tgtConn;
          } else {
            webview.postMessage({ type: 'schemaMcpResult', payload: { ok: false, error: `Cannot extract a PostgreSQL connection URL from "${tgtServer.name}". Add a postgresql:// URL to the server args in Settings → MCP Servers.` } });
            return true;
          }
        }
        if (schema?.trim()) args['schema'] = schema.trim();
        if (targetSchema?.trim()) args['second_schema'] = targetSchema.trim();
        if (objectTypes && objectTypes.length > 0) args['object_types'] = objectTypes;

        webview.postMessage({ type: 'schemaMcpProgress', payload: { text: `Running compare_schemas on ${srcServer.name}…` } });
        const result = await callMcpTool('compare_schemas', args, srcServer.id);
        if (!result.success) {
          webview.postMessage({ type: 'schemaMcpResult', payload: { ok: false, error: result.error || 'compare_schemas failed' } });
          return true;
        }

        // Changes kept to some environments (meta.json "environments"): what one creates only on one side is an
        // expected difference, not drift. Needs both sides to be DMCR environment servers (dmcr-env-<env>).
        try {
          const envOf = (id: string) => /^dmcr-env-(.+)$/.exec(id)?.[1] ?? '';
          const srcEnv = envOf(srcServer.id), tgtEnv = tgtServer ? envOf(tgtServer.id) : '';
          if (srcEnv && tgtEnv && result.data && typeof result.data === 'object') {
            const fs = await import('fs');
            const path = await import('path');
            const { requireChangesDir } = await import('../../../storage/changes-dir.js');
            const { isChangeFolder } = await import('../../../storage/change-order.js');
            const { expectedDifferences, annotateCompare } = await import('../../../services/schema/env-only.js');
            const dir = await requireChangesDir();
            const read = (id: string, f: string) => { try { return fs.readFileSync(path.join(dir, id, f), 'utf8').replace(/^﻿/, ''); } catch { return ''; } };
            const changes = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && isChangeFolder(d.name)).map(d => {
              let environments: string[] | undefined;
              try { const m = JSON.parse(read(d.name, 'meta.json') || '{}') as { environments?: unknown }; if (Array.isArray(m.environments)) environments = m.environments.map(String); }
              catch { /* meta.json not JSON: every environment */ }
              return { id: d.name, environments, deploySql: read(d.name, 'deploy.sql') };
            });
            result.data = annotateCompare(result.data as Record<string, unknown>, expectedDifferences(changes, srcEnv, tgtEnv));
          }
        } catch { /* no workspace or unreadable changes: the compare as it came */ }

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
      const { sourceServerId: srcId, targetServerId: tgtId, items, targetSchema } = msg.payload as {
        sourceServerId: string; targetServerId: string;
        items: Array<{ schema: string; name: string; type: string }>;
        /** the target's schema when its name differs (prod zp vs test zp_st) */
        targetSchema?: string;
      };
      webview.postMessage({ type: 'schemaMcpProgress', payload: { text: `Fetching DDL for ${items.length} object(s)…` } });
      try {
        const pairs = [];
        for (const item of items) {
          const ddlArgs = { schema: item.schema, name: item.name, object_type: item.type };
          const [srcRes, tgtRes] = await Promise.all([
            callMcpTool('get_ddl', ddlArgs, srcId),
            callMcpTool('get_ddl', targetSchema ? { ...ddlArgs, schema: targetSchema } : ddlArgs, tgtId),
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

    // Data Diff: a database's schemas, and with `schema` its tables (estimated rows)
    case "dataDiffMeta": {
      const { serverId, schema } = msg.payload as { serverId: string; schema?: string };
      try {
        const q = mcpQuery(serverId);
        const schemas = (await q(`SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema', 'dmcr') ORDER BY nspname`)).rows.map(r => String(r[0]));
        // what has data to compare, by kind like a database browser: tables, views, materialized views, sequences
        const kinds: Record<string, string> = { r: 'table', p: 'table', v: 'view', m: 'matview', S: 'sequence' };
        const tables = schema ? (await q(`SELECT c.relname, c.relkind::text, greatest(c.reltuples, 0)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${schema.replace(/'/g, "''")}' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND NOT c.relispartition ORDER BY c.relname`))
          .rows.map(r => ({ name: String(r[0]), kind: kinds[String(r[1])] ?? 'table', rows: Number(r[2]) })) : undefined;
        // functions and procedures by name(argument types), not the ones an extension brings
        if (tables) {
          const { FUNCTION_SIGNATURE } = await import('../../../services/schema/data-diff.js');
          tables.push(...(await q(`SELECT ${FUNCTION_SIGNATURE} FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = '${schema!.replace(/'/g, "''")}' AND p.prokind IN ('f', 'p')
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') ORDER BY 1`))
            .rows.map(r => ({ name: String(r[0]), kind: 'function', rows: 0 })));
        }
        webview.postMessage({ type: 'dataDiffMetaResult', payload: { serverId, schema, schemas, tables } });
      } catch (err) {
        webview.postMessage({ type: 'dataDiffMetaResult', payload: { serverId, schema, schemas: [], error: err instanceof Error ? err.message.split('\n')[0] : String(err) } });
      }
      return true;
    }

    // Data Diff: the objects you sync (kind|name, and rules like rule|prefix_*); the tree shows only those. Kept in
    // data-sync.json in the changes folder, next to releases.json, so every DBA on the repo shares one list
    case "getDataSyncList": {
      const { readDataSyncList } = await import('../../../storage/data-sync-list.js');
      webview.postMessage({ type: 'dataSyncList', payload: await readDataSyncList() });
      return true;
    }
    case "saveDataSyncList": {
      const { writeDataSyncList, readDataSyncList } = await import('../../../storage/data-sync-list.js');
      try {
        writeDataSyncList((msg.payload as { items?: string[] }).items ?? []);
        webview.postMessage({ type: 'dataSyncList', payload: await readDataSyncList() });
      } catch (err) {
        webview.postMessage({ type: 'dataSyncList', payload: { ...(await readDataSyncList()), error: err instanceof Error ? err.message : String(err) } });
      }
      return true;
    }
    // commit data-sync.json (and push, when there is a remote), so the other DBAs get it on their next pull
    case "commitDataSyncList": {
      const { readDataSyncList, dataSyncFile } = await import('../../../storage/data-sync-list.js');
      const { commitAndPush } = await import('../../../services/git/git-service.js');
      const r = await commitAndPush(dataSyncFile(), 'chore(dmcr): update data-sync.json (Data Diff sync list)');
      webview.postMessage({ type: 'dataSyncList', payload: { ...(await readDataSyncList()),
        commit: { ok: r.ok, committed: r.committed, pushed: r.pushed, hash: r.commitHash, note: r.note, error: r.error?.split('\n')[0] } } });
      return true;
    }

    // Data Diff: one table's rows on two databases, matched by key
    case "compareTableData": {
      const p = msg.payload as { sourceServerId: string; targetServerId: string; sourceSchema: string; targetSchema: string; table: string; kind?: string; ignore?: string[]; key?: string[] };
      try {
        const { diffTableData, syncChangeSql, diffSequence, syncSequenceSql, diffFunction, syncFunctionSql } = await import('../../../services/schema/data-diff.js');
        // the source by its environment's name (a change never names a schema)
        const { getConfiguredMcpServers } = await import('../../../services/mcp/agent/mcp-agent.js');
        const sourceName = /^dmcr-env-(.+)$/.exec(p.sourceServerId)?.[1] ?? getConfiguredMcpServers().find(s => s.id === p.sourceServerId)?.name ?? '';
        if (p.kind === 'sequence') {
          const result = await diffSequence({ source: mcpQuery(p.sourceServerId), target: mcpQuery(p.targetServerId), sourceSchema: p.sourceSchema, targetSchema: p.targetSchema, sequence: p.table });
          // only ever moved forward: moving prod's sequence back could hand out values already used
          const sql = result.sourceAhead ? syncSequenceSql(result, { sourceName }) : null;
          webview.postMessage({ type: 'dataDiffResult', payload: { ok: true, result, sync: sql && { withDeletes: sql, keepExtra: sql } } });
          return true;
        }
        if (p.kind === 'function') {
          const result = await diffFunction({ source: mcpQuery(p.sourceServerId), target: mcpQuery(p.targetServerId), sourceSchema: p.sourceSchema, targetSchema: p.targetSchema, signature: p.table });
          const sql = result.same ? null : syncFunctionSql(result, { sourceName });
          webview.postMessage({ type: 'dataDiffResult', payload: { ok: true, result, sync: sql && { withDeletes: sql, keepExtra: sql } } });
          return true;
        }
        const result = await diffTableData({
          source: mcpQuery(p.sourceServerId), target: mcpQuery(p.targetServerId),
          sourceSchema: p.sourceSchema, targetSchema: p.targetSchema, table: p.table, ignore: p.ignore, key: p.key,
          progress: text => webview.postMessage({ type: 'dataDiffProgress', payload: { text } }),
        });
        // the change that makes the target match, with and without deleting the target's extra rows; a view's rows come from its tables
        const sync = result.complete && (!p.kind || p.kind === 'table') ? { withDeletes: syncChangeSql(result, { deletes: true, sourceName }), keepExtra: syncChangeSql(result, { deletes: false, sourceName }) } : null;
        webview.postMessage({ type: 'dataDiffResult', payload: { ok: true, result, sync } });
      } catch (err) {
        webview.postMessage({ type: 'dataDiffResult', payload: { ok: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) } });
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

/**
 * The changes a deploy would pick up (status: pending, not dropped) whose meta.json has no project or no
 * requested_by. Read with the same script and environment as the deploy; a status that can't be read
 * blocks nothing (the deploy itself then reports what is wrong).
 */
type StatusRow = { change_id?: string; status?: string; dropped?: boolean };

/** `status --json` on the deploy's environment (same invocation), or null when it cannot be read. */
async function readDeployStatus(ctx: HandlerContext, deployArgs: string[], customScript?: string): Promise<StatusRow[] | null> {
  const i = deployArgs.indexOf('--env');
  const statusArgs = ['status', ...(i >= 0 && deployArgs[i + 1] ? ['--env', deployArgs[i + 1]] : []), '--json'];
  const inv = await buildRunnerInvocation({ extensionPath: ctx.extensionPath, extensionContext: ctx.extensionContext, args: statusArgs, customScript });
  if ('error' in inv) return null;
  // like the run itself: pwsh missing on Windows falls back to powershell.exe
  const read = (executor: string) => new Promise<string | null>(resolve => {
    let text = '';
    let done = false;
    const end = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = cp.spawn(executor, inv.spawnArgs, { env: inv.env, shell: false, cwd: inv.cwd });
      child.stdout.on('data', (c: Buffer | string) => { text += c.toString(); });
      child.on('error', (e: NodeJS.ErrnoException) => end(e.code === 'ENOENT' ? null : ''));
      child.on('close', () => end(text));
    } catch { end(''); }
  });
  let out = await read(inv.executor);
  if (out === null && process.platform === 'win32' && inv.executor === 'pwsh') out = await read('powershell.exe');
  if (!out) return null;
  try { const rows = JSON.parse(out.trim()); return Array.isArray(rows) ? rows : null; } catch { return null; }
}

/** What this deploy would apply: pending, not dropped and not kept off this environment. */
const pendingIds = (rows: StatusRow[]) => rows.filter(r => r.status === 'pending' && !r.dropped && r.change_id && isChangeFolder(r.change_id)).map(r => r.change_id!);

const readMeta = (dir: string, id: string): Record<string, unknown> => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')); } catch { return {}; }
};

/** Pending changes without a project or a requested by: a deploy refuses them. */
function pendingWithoutReleaseFields(rows: StatusRow[], dir: string): { change_id: string; missing: string[]; created_by?: string }[] {
  const result: { change_id: string; missing: string[]; created_by?: string }[] = [];
  for (const id of pendingIds(rows)) {
    const meta = readMeta(dir, id);   // no meta.json: both missing
    if (meta.status === 'dropped') continue;
    const missing = [
      ...(String(meta.project ?? '').trim() ? [] : ['project']),
      ...(String(meta.requested_by ?? '').trim() ? [] : ['requested by']),
    ];
    if (missing.length) result.push({ change_id: id, missing, ...(meta.created_by ? { created_by: String(meta.created_by) } : {}) });
  }
  return result.sort((a, b) => compareChangeIds(a.change_id, b.change_id));
}

/**
 * The deploy gate (services/conflicts/deploy-gate.ts) for the changes this deploy applies: pending ones, narrowed by
 * --release / --project (a release range keeps every pending one). The runners run the same gate through
 * dmcr_conflicts.cjs.
 */
async function unresolvedConflictsFor(rows: StatusRow[], deployArgs: string[], dir: string): Promise<UnresolvedConflict[]> {
  const pending = new Set(pendingIds(rows));
  if (!pending.size) return [];
  const list = (flag: string) => {
    const i = deployArgs.indexOf(flag);
    const v = i >= 0 ? deployArgs[i + 1] ?? '' : '';
    return v && !v.includes('..') ? v.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : [];
  };
  const releases = list('--release'), projects = list('--project');
  const { unresolvedConflicts } = await import('../../../services/conflicts/deploy-gate.js');
  return unresolvedConflicts(dir, x => pending.has(x.changeId)
    && (!releases.length || releases.includes(x.release.toLowerCase()))
    && (!projects.length || projects.includes(x.project.toLowerCase())));
}

/** conflict_check under [dmcr] in dmcr.cfg, as the runners read it: block (default), warn or off */
function conflictCheckMode(): 'block' | 'warn' | 'off' {
  try {
    const p = getUserCfgPath();
    const v = p && fs.existsSync(p) ? String(parseDmcrIni(fs.readFileSync(p, 'utf8'))['dmcr']?.['conflict_check'] ?? '').trim().toLowerCase() : '';
    return v === 'warn' || v === 'off' ? v : 'block';
  } catch { return 'block'; }
}
