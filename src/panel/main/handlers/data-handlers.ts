/**
 * Data / diagnostics message handlers: DB info, system info, audit footprint, SQLite rebuild.
 */
import { getPrompt } from '../../../storage/prompt-library';
import { resolveChangesDir } from '../../../storage/changes-dir';
import { assertAiFeatureEnabled, getDisabledAiFeatures, saveDisabledAiFeatures, hasStoredAiFeatureToggles } from '../../../storage/ai-features';
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import * as os from "os";
import {
  getDbPath,
  getSqliteVersion,
  getAuditEntries,
  getAuditEntriesSince,
  getAuditEntriesByConversation,
  getAiFootprintLimit,
  setAiFootprintLimit,
  getAiFootprintDisplayLimit,
  setAiFootprintDisplayLimit,
  deleteAuditEntry,
  deleteAuditEntries,
  getDbExplorerTables,
  getDbExplorerRows,
  deleteDbExplorerRows,
  listConversationSessions,
  deleteConversationSession,
  getConversationSqlHistory,
} from "../../../storage/db";
import type { HandlerContext, Message } from "./types";

/** Quote a value as a SQL string literal. */
function sqlLiteral(value: string | null | undefined): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** True for one SELECT / WITH / EXPLAIN statement with no further statements after it. */
function isSingleReadOnlyStatement(sql: unknown): boolean {
  if (typeof sql !== 'string') { return false; }
  const s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  return /^(SELECT|WITH|EXPLAIN)\b/i.test(s) && !s.includes(';');
}

export async function handleDataMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;

  switch (msg.type) {

    /* ── List existing change folders (for Requires multi-select) ── */
    case "listExistingChanges": {
      try {
        const ws = vscode.workspace.workspaceFolders?.[0];
        const changes: string[] = [];
        if (ws) {
          try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(resolveChangesDir()));
            for (const [name, kind] of entries) {
              if (kind === vscode.FileType.Directory && /^\d+_/.test(name)) changes.push(name);
            }
            changes.sort();
          } catch { /* no changes dir yet */ }
        }
        webview.postMessage({ type: 'existingChanges', payload: { changes } });
      } catch {
        webview.postMessage({ type: 'existingChanges', payload: { changes: [] } });
      }
      return true;
    }

    /* ── Settings: DB info ── */
    case "getDbInfo": {
      try {
        const dbPath = getDbPath() || path.join(ctx.extensionPath, 'dmcr.db');
        let dbSize = 0;
        try { dbSize = fs.statSync(dbPath).size; } catch { /* not found */ }
        // Use the running sql.js instance — no need for a second db connection
        const sqliteVersion = getSqliteVersion();
        const explorerTables = getDbExplorerTables();
        const tableRows = explorerTables.map(t => ({ name: t.name, count: t.rowCount }));
        webview.postMessage({
          type: 'dbInfo',
          payload: {
            dbPath,
            dbSizeBytes: dbSize,
            sqliteVersion,
            tables: tableRows,
            extensionPath: ctx.extensionPath,
            userDataPath: process.env.APPDATA ?? process.env.HOME ?? '',
          },
        });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `getDbInfo failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── AI Footprint: get audit rows ── */
    case "getAiFootprint": {
      try {
        const displayLimit = (msg.payload as { limit?: number })?.limit ?? getAiFootprintDisplayLimit();
        const entries = getAuditEntries(displayLimit);
        webview.postMessage({ type: 'aiFootprint', payload: { entries, limit: getAiFootprintLimit(), displayLimit: getAiFootprintDisplayLimit() } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `getAiFootprint failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── AI Footprint: get settings (limits only, no entries) ── */
    case "getAiFootprintSettings": {
      webview.postMessage({ type: 'aiFootprintSettings', payload: { keepLimit: getAiFootprintLimit(), showLimit: getAiFootprintDisplayLimit() } });
      return true;
    }

    /* ── Audit Timeline: conversation-scoped or session-scoped entries ── */
    case "getAuditTimeline": {
      const timelineRequestId = (msg.payload as { requestId?: string })?.requestId;
      try {
        const convId = (msg.payload as { conversationId?: string })?.conversationId;
        let entries;
        if (convId) {
          // Filter by the library's conversation UUID — all audit entries share this ID now
          entries = getAuditEntriesByConversation(convId);
        } else {
          // Fallback: session-scoped (since panel open)
          const since = ctx.state.inlineConvSessionStartId ?? 0;
          entries = getAuditEntriesSince(since);
        }
        // Own message type: the DevTools AI Footprint view also listens for 'aiFootprint'.
        webview.postMessage({ type: 'auditTimeline', payload: { entries, limit: entries.length, requestId: timelineRequestId } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'auditTimeline', payload: { entries: [], limit: 0, error: String(e), requestId: timelineRequestId } });
      }
      return true;
    }

    /* ── AI Footprint: save keep limit setting ── */
    case "saveAiFootprintLimit": {
      try {
        const { limit } = msg.payload as { limit: number };
        setAiFootprintLimit(Math.max(1, limit));
        webview.postMessage({ type: 'aiFootprintLimitSaved', payload: { keepLimit: getAiFootprintLimit(), showLimit: getAiFootprintDisplayLimit() } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `saveAiFootprintLimit failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── AI Footprint: save display limit setting ── */
    case "saveAiFootprintDisplayLimit": {
      try {
        const { limit } = msg.payload as { limit: number };
        setAiFootprintDisplayLimit(Math.max(1, limit));
        webview.postMessage({ type: 'aiFootprintLimitSaved', payload: { keepLimit: getAiFootprintLimit(), showLimit: getAiFootprintDisplayLimit() } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `saveAiFootprintDisplayLimit failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── AI Footprint: delete single entry ── */
    case "deleteAuditEntry": {
      try {
        const { auditId } = msg.payload as { auditId: number };
        deleteAuditEntry(auditId);
        const displayLimit = getAiFootprintDisplayLimit();
        webview.postMessage({ type: 'aiFootprint', payload: { entries: getAuditEntries(displayLimit), limit: getAiFootprintLimit(), displayLimit } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `deleteAuditEntry failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── AI Footprint: bulk delete ── */
    case "deleteAuditEntries": {
      try {
        const { auditIds } = msg.payload as { auditIds: number[] };
        deleteAuditEntries(auditIds);
        const displayLimit = getAiFootprintDisplayLimit();
        webview.postMessage({ type: 'aiFootprint', payload: { entries: getAuditEntries(displayLimit), limit: getAiFootprintLimit(), displayLimit } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `deleteAuditEntries failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── Settings: system / memory info ── */
    case "getSystemInfo": {
      try {
        const mem = process.memoryUsage();
        const cpuList = os.cpus();

        type ProcEntry = { name: string; pid: number; mem: number };
        let processList: ProcEntry[] = [];
        try {
          const isWin = os.platform() === 'win32';
          if (isWin) {
            const out = cp.execSync('tasklist /FO CSV /NH', { timeout: 5000, encoding: 'utf-8' });
            processList = out.trim().split('\n')
              .map(line => {
                const cols = line.trim().replace(/\r/g, '').split('","');
                if (cols.length < 5) return null;
                const name = cols[0].replace(/^"|"$/g, '');
                const pid  = parseInt(cols[1].replace(/[^0-9]/g, ''), 10) || 0;
                const memStr = cols[4].replace(/[^0-9]/g, '');
                const memVal = parseInt(memStr, 10) * 1024;
                return { name, pid, mem: memVal };
              })
              .filter((p): p is ProcEntry => p !== null && p.mem > 0)
              .sort((a, b) => b.mem - a.mem)
              .slice(0, 40);
          } else {
            const out = cp.execSync('ps -axo pid=,rss=,comm= --sort=-rss', { timeout: 5000, encoding: 'utf-8' });
            processList = out.trim().split('\n')
              .map(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) return null;
                const pid  = parseInt(parts[0], 10) || 0;
                const memVal = (parseInt(parts[1], 10) || 0) * 1024;
                const name = parts.slice(2).join(' ');
                return { name, pid, mem: memVal };
              })
              .filter((p): p is ProcEntry => p !== null && p.mem > 0)
              .slice(0, 40);
          }
        } catch { /* process list optional */ }

        webview.postMessage({
          type: 'systemInfo',
          payload: {
            heapUsed:     mem.heapUsed,
            heapTotal:    mem.heapTotal,
            rss:          mem.rss,
            external:     mem.external,
            arrayBuffers: mem.arrayBuffers,
            versions: {
              node:     process.versions.node,
              v8:       process.versions.v8,
              electron: process.versions.electron ?? 'n/a',
              openssl:  process.versions.openssl,
              uv:       process.versions.uv,
            },
            vscodeVersion: vscode.version,
            appName:       vscode.env.appName,
            appHost:       vscode.env.appHost,
            language:      vscode.env.language,
            remoteName:    vscode.env.remoteName ?? 'local',
            shell:         vscode.env.shell,
            platform:      os.platform(),
            release:       os.release(),
            arch:          os.arch(),
            hostname:      os.hostname(),
            totalMemBytes: os.totalmem(),
            freeMemBytes:  os.freemem(),
            cpuModel:      cpuList[0]?.model ?? 'unknown',
            cpuCount:      cpuList.length,
            cpuSpeed:      cpuList[0]?.speed ?? 0,
            uptime:        os.uptime(),
            extensionPath: ctx.extensionPath,
            tmpDir:        os.tmpdir(),
            homeDir:       os.homedir(),
            processList,
          },
        });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `getSystemInfo failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── SQLite: run rebuild script then restart extension host ── */
    case "rebuildSqlite": {
      const electronVersion = process.versions.electron;
      if (!electronVersion) {
        webview.postMessage({ type: "sqliteRebuildResult", payload: { ok: false, error: "process.versions.electron not available" } });
        return true;
      }
      const scriptPath = path.join(ctx.extensionPath, "scripts", "sqlite", "rebuild-sqlite.js");
      webview.postMessage({ type: "sqliteRebuildResult", payload: { ok: false, error: null, building: true } });
      cp.execFile(process.execPath, [scriptPath, electronVersion, ctx.extensionPath], { timeout: 120_000 }, (err, _stdout, stderr) => {
        if (err) {
          webview.postMessage({ type: "sqliteRebuildResult", payload: { ok: false, error: stderr || err.message } });
        } else {
          webview.postMessage({ type: "sqliteRebuildResult", payload: { ok: true, error: null } });
          vscode.window
            .showInformationMessage("SQLite rebuilt! Restart the extension host to activate it.", "Restart Now")
            .then(choice => {
              if (choice === "Restart Now") {
                vscode.commands.executeCommand("workbench.action.restartExtensionHost");
              }
            });
        }
      });
      return true;
    }

    /* ── Run a VS Code command from the webview ── */
    case "runCommand": {
      const command = (msg as any).command as string | undefined;
      if (command) {
        vscode.commands.executeCommand(command);
      }
      return true;
    }

    /* ── Open a form/tab in a new editor column ── */
    case "openInNewTab": {
      const form = (msg as any).payload?.form as string | undefined;
      if (form) {
        // Import DmcrPanel here to avoid circular deps at top level
        const { DmcrPanel } = await import("../DmcrPanel.js");
        DmcrPanel.openInNewTab(ctx.extensionUri, form, ctx.extensionContext);
      }
      return true;
    }

    /* ── DB Explorer: list tables ── */
    case "getDbExplorerTables": {
      try {
        const tables = getDbExplorerTables();
        webview.postMessage({ type: 'dbExplorerTables', payload: { tables } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `getDbExplorerTables failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── DB Explorer: fetch rows for a table ── */
    case "getDbExplorerRows": {
      try {
        const { table, limit, offset } = msg.payload as { table: string; limit?: number; offset?: number };
        const rows = getDbExplorerRows(table, limit ?? 100, offset ?? 0);
        webview.postMessage({ type: 'dbExplorerRows', payload: { table, rows } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `getDbExplorerRows failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── DB Explorer: delete rows ── */
    case "deleteDbExplorerRows": {
      try {
        const { table, rowids, pkColumn } = msg.payload as { table: string; rowids: (number | string)[]; pkColumn?: string };
        deleteDbExplorerRows(table, rowids, pkColumn);
        // Re-fetch updated data
        const tables = getDbExplorerTables();
        const rows = getDbExplorerRows(table, 100, 0);
        webview.postMessage({ type: 'dbExplorerTables', payload: { tables } });
        webview.postMessage({ type: 'dbExplorerRows', payload: { table, rows } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'error', payload: `deleteDbExplorerRows failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    /* ── Git user (for meta author auto-fill) ── */
    case "getGitUser": {
      const run = (cmd: string) => new Promise<string>(resolve => {
        cp.exec(cmd, { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
      });
      const [name, email] = await Promise.all([
        run('git config user.name'),
        run('git config user.email'),
      ]);
      webview.postMessage({ type: 'gitUser', payload: { name, email } });
      return true;
    }

    /* ── Git status (branch + dirty flag for Runner badge) ── */
    case "getGitStatus": {
      const run = (cmd: string) => new Promise<string>(resolve => {
        cp.exec(cmd, { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
      });
      try {
        const [branch, statusOut] = await Promise.all([
          run('git rev-parse --abbrev-ref HEAD'),
          run('git status --porcelain'),
        ]);
        webview.postMessage({ type: 'gitStatus', payload: { branch: branch || 'unknown', dirty: statusOut.trim().length > 0 } });
      } catch {
        webview.postMessage({ type: 'gitStatus', payload: { branch: 'unknown', dirty: false } });
      }
      return true;
    }

    case "getRunnerHistory": {
      const { getRunnerEvents, findById: findCfgDb } = await import('../../../storage/db.js');
      const dbCfgHist = findCfgDb<{ runHistoryLimit?: number }>('dmcr_config', 'main');
      const histLimit = dbCfgHist?.runHistoryLimit ?? 50;
      webview.postMessage({ type: 'runnerHistory', payload: getRunnerEvents(histLimit) });
      return true;
    }

    case "deleteRunnerHistory": {
      const { deleteAllRunnerEvents } = await import('../../../storage/db.js');
      deleteAllRunnerEvents();
      webview.postMessage({ type: 'runnerHistoryDeleted' });
      return true;
    }

    case "getConversationHistory": {
      const sessions = listConversationSessions(50);
      webview.postMessage({ type: 'conversationHistory', payload: { sessions } });
      return true;
    }

    case "deleteConversationSession": {
      const { conversationId } = msg.payload as { conversationId: string };
      deleteConversationSession(conversationId);
      const sessions = listConversationSessions(50);
      webview.postMessage({ type: 'conversationHistory', payload: { sessions } });
      return true;
    }

    case "getConversationSessionDetail": {
      const { conversationId } = msg.payload as { conversationId: string };
      const entries = getConversationSqlHistory(conversationId);
      webview.postMessage({ type: 'conversationSessionDetail', payload: { conversationId, entries } });
      return true;
    }

    case "getConvChips": {
      const { findById } = await import('../../../storage/db.js');
      const saved = findById<{ chips: { chipText: string; chatText: string }[] }>('settings', 'conv_chips');
      webview.postMessage({ type: 'convChips', payload: saved?.chips ?? null });
      return true;
    }

    case "saveConvChips": {
      const { upsert } = await import('../../../storage/db.js');
      const chips = msg.payload as { chipText: string; chatText: string }[];
      upsert('settings', 'conv_chips', { chips });
      webview.postMessage({ type: 'convChipsSaved' });
      return true;
    }

    /* ── AI Features: on/off switches (shared by every DMCR webview) ── */
    case "getAiFeatures": {
      webview.postMessage({ type: 'aiFeatures', payload: { disabled: getDisabledAiFeatures(), stored: hasStoredAiFeatureToggles() } });
      return true;
    }

    case "saveAiFeatures": {
      const { disabled } = (msg.payload ?? {}) as { disabled?: string[] };
      saveDisabledAiFeatures(Array.isArray(disabled) ? disabled : []);
      webview.postMessage({ type: 'aiFeatures', payload: { disabled: getDisabledAiFeatures(), stored: true } });
      return true;
    }

    case "getSqlPolicies": {
      const { findById: findPolicies } = await import('../../../storage/db.js');
      const stored = findPolicies<{ policies: string[] }>('sql_policies', 'main');
      webview.postMessage({ type: 'sqlPoliciesResult', payload: { policies: stored?.policies ?? [] } });
      return true;
    }

    case "saveSqlPolicies": {
      const { policies } = msg.payload as { policies: string[] };
      const { upsert: upsertPolicies } = await import('../../../storage/db.js');
      upsertPolicies('sql_policies', 'main', { policies });
      webview.postMessage({ type: 'sqlPoliciesSaved', payload: { ok: true } });
      return true;
    }

    case "validateSqlPolicy": {
      const { changeName, deploySql } = msg.payload as { changeName: string; deploySql: string };
      try {
        assertAiFeatureEnabled('AI_SQL_POLICY_GUARD');
        const { findById: findPol } = await import('../../../storage/db.js');
        const stored = findPol<{ policies: string[] }>('sql_policies', 'main');
        const policies = stored?.policies ?? [];

        if (policies.length === 0) {
          webview.postMessage({ type: 'policyValidationResult', payload: { changeName, violations: [] } });
          return true;
        }

        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');

        const systemPrompt = getPrompt('AI_SQL_POLICY_GUARD');

        const userMsg = `Policies:\n${policies.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nMigration SQL (${changeName}):\n\`\`\`sql\n${deploySql.slice(0, 3000)}\n\`\`\``;

        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const raw = await callActiveLlm(systemPrompt, userMsg, 0.1, cts.token, () => {}, undefined, undefined, `policy-${changeName}`);

        let violations: Array<{ policy: string; violation: string; severity: string }> = [];
        try {
          const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
          violations = JSON.parse(cleaned);
        } catch { /* no violations if parse fails */ }

        webview.postMessage({ type: 'policyValidationResult', payload: { changeName, violations } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'policyValidationResult', payload: { changeName, violations: [], error: errMsg } });
      }
      return true;
    }

    case "detectDeadColumns": {
      const { serverId, schema } = msg.payload as { serverId: string; schema: string };
      webview.postMessage({ type: 'deadColumnProgress', payload: { text: `Analyzing column usage in ${schema}…` } });
      try {
        assertAiFeatureEnabled('AI_DEAD_COLUMN_DETECTOR');
        const { callMcpTool } = await import('../../../services/mcp/agent/mcp-agent.js');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');

        // Get all tables in schema
        const objRes = await callMcpTool('discover_objects', { schema }, serverId);
        const rawObjs = ((objRes.data as { objects?: Array<{ name: string; type: string }> })?.objects ?? []) as Array<{ name: string; type: string }>;
        const tables = rawObjs.filter(o => o.type === 'table').map(o => o.name);

        if (tables.length === 0) {
          webview.postMessage({ type: 'deadColumnResult', payload: { schema, report: null, error: 'No tables found in schema' } });
          return true;
        }

        webview.postMessage({ type: 'deadColumnProgress', payload: { text: `Describing ${tables.length} tables…` } });

        // Describe tables to get column lists
        const tableColumns: Array<{ table: string; columns: string[] }> = [];
        for (const t of tables.slice(0, 30)) {
          try {
            const descRes = await callMcpTool('describe_table', { schema, name: t }, serverId);
            const data = descRes.data as { columns?: Array<{ name: string; type?: string }> } | null;
            const cols = (data?.columns ?? []).map(c => c.name);
            tableColumns.push({ table: t, columns: cols });
          } catch { /* skip */ }
        }

        // Try to get pg_stat_user_tables for row counts / sequential scans
        let statsContext = '';
        try {
          const statsQuery = `SELECT schemaname, relname, n_live_tup, seq_scan, idx_scan FROM pg_stat_user_tables WHERE schemaname = ${sqlLiteral(schema)} ORDER BY n_live_tup DESC LIMIT 50`;
          const statsRes = await callMcpTool('run_readonly_query', { sql: statsQuery }, serverId);
          if (statsRes.success) statsContext = `\n\nTable statistics (pg_stat_user_tables):\n${JSON.stringify(statsRes.data, null, 2).slice(0, 2000)}`;
        } catch { /* stats unavailable */ }

        webview.postMessage({ type: 'deadColumnProgress', payload: { text: 'Analyzing with AI…' } });

        const systemPrompt = getPrompt('AI_DEAD_COLUMN_DETECTOR');

        const userMsg = `Schema: ${schema}\n\nTables and columns:\n${tableColumns.map(tc => `${tc.table}: ${tc.columns.join(', ')}`).join('\n')}${statsContext}`;

        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const raw = await callActiveLlm(systemPrompt, userMsg, 0.1, cts.token, () => {}, undefined, undefined, `dead-cols-${schema}`);

        let findings: Array<{ table: string; column: string; confidence: string; reason: string }> = [];
        try {
          const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
          findings = JSON.parse(cleaned);
        } catch { /* empty report if parse fails */ }

        webview.postMessage({ type: 'deadColumnResult', payload: { schema, findings } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'deadColumnResult', payload: { schema, findings: [], error: errMsg } });
      }
      return true;
    }

    case "generateChangelog": {
      const { historyRows } = msg.payload as { historyRows: Array<{ change_id: string; applied_at: string; applied_by?: string; environment?: string; ticket_id?: string }> };
      try {
        assertAiFeatureEnabled('AI_CHANGELOG_GENERATOR');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const changesDir = resolveChangesDir();

        // Enrich each row with deploy.sql snippet for better AI context
        const enriched = historyRows.map(r => {
          let summary = '';
          if (changesDir) {
            const deployPath = path.join(changesDir, r.change_id, 'deploy.sql');
            const metaPath   = path.join(changesDir, r.change_id, 'meta.json');
            if (fs.existsSync(metaPath)) {
              try { const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); summary = m.description || ''; } catch { /* skip */ }
            }
            if (!summary && fs.existsSync(deployPath)) {
              summary = fs.readFileSync(deployPath, 'utf8').split('\n').slice(0, 3).join(' ').slice(0, 120);
            }
          }
          return { ...r, summary };
        });

        const systemPrompt = getPrompt('AI_CHANGELOG_GENERATOR');

        const userMsg = `Generate a CHANGELOG.md from these ${enriched.length} applied migrations:\n\n${enriched.map(r => `- ${r.change_id} (${r.applied_at?.slice(0, 10) ?? 'unknown date'}${r.environment ? `, ${r.environment}` : ''}): ${r.summary || '(no description)'}`).join('\n')}`;

        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const changelog = await callActiveLlm(systemPrompt, userMsg, 0.2, cts.token, () => {}, undefined, undefined, 'changelog-generator');

        webview.postMessage({ type: 'changelogResult', payload: { changelog } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'changelogResult', payload: { changelog: null, error: errMsg } });
      }
      return true;
    }

    case "analyzeDependencies": {
      const { changeName, deploySql } = msg.payload as { changeName: string; deploySql: string };
      try {
        assertAiFeatureEnabled('AI_DEPENDENCY_ANALYZER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const changesDir = resolveChangesDir();

        let existingChangeIds: string[] = [];
        if (changesDir && fs.existsSync(changesDir)) {
          existingChangeIds = fs.readdirSync(changesDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^\d+_.+/.test(d.name))
            .map(d => d.name)
            .filter(n => n !== changeName)
            .sort();
        }

        if (existingChangeIds.length === 0) {
          webview.postMessage({ type: 'dependencyResult', payload: { changeName, requires: [] } });
          return true;
        }

        const systemPrompt = getPrompt('AI_DEPENDENCY_ANALYZER');

        const userMsg = `New migration: ${changeName}\n\nSQL:\n\`\`\`sql\n${deploySql.slice(0, 2000)}\n\`\`\`\n\nExisting migrations (in order):\n${existingChangeIds.join('\n')}`;

        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const raw = await callActiveLlm(systemPrompt, userMsg, 0.1, cts.token, () => {}, undefined, undefined, `deps-${changeName}`);

        let requires: string[] = [];
        try {
          const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
          const parsed = JSON.parse(cleaned);
          requires = Array.isArray(parsed.requires) ? parsed.requires.filter((r: unknown) => typeof r === 'string') : [];
        } catch { /* no deps if parse fails */ }

        webview.postMessage({ type: 'dependencyResult', payload: { changeName, requires } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'dependencyResult', payload: { changeName, requires: [], error: errMsg } });
      }
      return true;
    }

    case "rollbackAdvisor": {
      const { id, command } = msg.payload as { id: number; command: string };
      try {
        assertAiFeatureEnabled('AI_ROLLBACK_ADVISOR');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const changesDir = resolveChangesDir();

        let deployContent = '';
        let revertContent = '';
        if (changesDir && command && !command.startsWith('-')) {
          const cmdSlug = command.trim().split(/\s+/)[0];
          const deployPath = path.join(changesDir, cmdSlug, 'deploy.sql');
          const revertPath = path.join(changesDir, cmdSlug, 'revert.sql');
          if (fs.existsSync(deployPath)) deployContent = fs.readFileSync(deployPath, 'utf8').slice(0, 3000);
          if (fs.existsSync(revertPath)) revertContent = fs.readFileSync(revertPath, 'utf8').slice(0, 3000);
        }

        const systemPrompt = getPrompt('AI_ROLLBACK_ADVISOR');

        const userMsg = [
          `Change: ${command}`,
          deployContent ? `\ndeploy.sql:\n\`\`\`sql\n${deployContent}\n\`\`\`` : '(no deploy.sql found)',
          revertContent ? `\nexisting revert.sql:\n\`\`\`sql\n${revertContent}\n\`\`\`` : '',
        ].filter(Boolean).join('\n');

        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const advisory = await callActiveLlm(systemPrompt, userMsg, 0.15, cts.token, () => {}, undefined, undefined, `rollback-${id}`);
        webview.postMessage({ type: 'rollbackAdvisoryResult', payload: { id, advisory } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'rollbackAdvisoryResult', payload: { id, advisory: `Error: ${errMsg}` } });
      }
      return true;
    }

    case "documentSchema": {
      const { serverId, schema } = msg.payload as { serverId: string; schema: string };
      webview.postMessage({ type: 'schemaDocProgress', payload: { text: `Discovering objects in ${schema}…` } });
      try {
        assertAiFeatureEnabled('AI_SCHEMA_DOCUMENTER');
        const { callMcpTool } = await import('../../../services/mcp/agent/mcp-agent.js');

        // 1. Discover objects
        const objRes = await callMcpTool('discover_objects', { schema }, serverId);
        const rawObjs = ((objRes.data as { objects?: Array<{ name: string; type: string }> })?.objects ?? []) as Array<{ name: string; type: string }>;
        const tables    = rawObjs.filter(o => o.type === 'table').map(o => o.name);
        const views     = rawObjs.filter(o => o.type === 'view').map(o => o.name);
        const functions = rawObjs.filter(o => o.type === 'function').map(o => o.name);

        webview.postMessage({ type: 'schemaDocProgress', payload: { text: `Found ${rawObjs.length} objects — describing tables…` } });

        // 2. Describe each table (columns)
        const tableDescriptions: Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean | undefined; default_value: string | null }> }> = [];
        for (const t of tables.slice(0, 50)) { // cap at 50 to avoid LLM token overflow
          try {
            const descRes = await callMcpTool('describe_table', { schema, name: t }, serverId);
            const data = descRes.data as { columns?: Array<{ name: string; type?: string; data_type?: string; is_nullable?: boolean; nullable?: boolean; column_default?: string; default_value?: string }> } | null;
            const columns = (data?.columns ?? []).map(c => ({
              name: c.name,
              type: c.type || c.data_type || 'unknown',
              nullable: c.nullable ?? c.is_nullable,
              default_value: c.default_value || c.column_default || null,
            }));
            tableDescriptions.push({ name: t, columns });
          } catch { /* skip tables that fail to describe */ }
        }

        webview.postMessage({ type: 'schemaDocProgress', payload: { text: 'Generating Markdown documentation…' } });

        // 3. Build context string for LLM
        const contextLines: string[] = [];
        contextLines.push(`Schema: ${schema}`);
        contextLines.push(`Tables (${tables.length}): ${tables.join(', ')}`);
        if (views.length) contextLines.push(`Views (${views.length}): ${views.join(', ')}`);
        if (functions.length) contextLines.push(`Functions (${functions.length}): ${functions.join(', ')}`);
        contextLines.push('');
        for (const td of tableDescriptions) {
          contextLines.push(`## ${td.name}`);
          for (const c of td.columns) {
            contextLines.push(`  - ${c.name}: ${c.type}${c.nullable === false ? ' NOT NULL' : ''}${c.default_value ? ` DEFAULT ${c.default_value}` : ''}`);
          }
          contextLines.push('');
        }

        const systemPrompt = getPrompt('AI_SCHEMA_DOCUMENTER');

        const userMsg = `Generate a Markdown data dictionary for this PostgreSQL schema:\n\n${contextLines.join('\n')}`;

        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const markdown = await callActiveLlm(systemPrompt, userMsg, 0.2, cts.token, () => {}, undefined, undefined, `schema-doc-${serverId}-${schema}`);

        try {
          const { insertAudit } = await import('../../../storage/db.js');
          insertAudit({
            conversation_id: `schema-doc-${serverId}`,
            stage: 'SCHEMA_DOCUMENTER',
            system_prompt: systemPrompt.slice(0, 2000),
            user_prompt: userMsg.slice(0, 2000),
            response_payload: markdown.slice(0, 2000),
            duration_ms: 0,
            meta: JSON.stringify({ serverId, schema, tableCount: tables.length }),
          });
        } catch { /* audit best-effort */ }

        webview.postMessage({ type: 'schemaDocResult', payload: { schema, markdown } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'schemaDocResult', payload: { schema, markdown: null, error: errMsg } });
      }
      return true;
    }

    case "analyzeRisk": {
      const { blockId, changes } = msg.payload as { blockId: number; changes: Array<{ change_id: string }> };
      try {
        assertAiFeatureEnabled('AI_RISK_SCORER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const changesDir = resolveChangesDir();

        const changesSql: Array<{ change_id: string; sql: string }> = [];
        for (const c of changes) {
          let sql = '';
          if (changesDir) {
            const deployPath = path.join(changesDir, c.change_id, 'deploy.sql');
            if (fs.existsSync(deployPath)) {
              sql = fs.readFileSync(deployPath, 'utf8').slice(0, 2000);
            }
          }
          changesSql.push({ change_id: c.change_id, sql });
        }

        const systemPrompt = getPrompt('AI_RISK_SCORER');

        const userMsg = `Score risk for these ${changesSql.length} pending migration(s):\n\n${changesSql.map(c => `**${c.change_id}**\n\`\`\`sql\n${c.sql || '(no deploy.sql found)'}\n\`\`\``).join('\n\n')}`;

        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const raw = await callActiveLlm(systemPrompt, userMsg, 0.1, cts.token, () => {}, undefined, undefined, `risk-${blockId}`);

        let scores: Array<{ change_id: string; risk: string; justification: string }> = [];
        try {
          const cleaned = raw.trim().replace(/^```json?\s*/i, '').replace(/```$/, '').trim();
          scores = JSON.parse(cleaned);
        } catch {
          scores = changesSql.map(c => ({ change_id: c.change_id, risk: 'UNKNOWN', justification: 'Could not parse AI response' }));
        }

        try {
          const { insertAudit } = await import('../../../storage/db.js');
          insertAudit({
            conversation_id: `risk-scorer-${blockId}`,
            stage: 'MIGRATION_RISK_SCORER',
            system_prompt: systemPrompt.slice(0, 2000),
            user_prompt: userMsg.slice(0, 2000),
            response_payload: JSON.stringify({ scores }),
            duration_ms: 0,
            meta: JSON.stringify({ blockId, changeCount: changes.length }),
          });
        } catch { /* audit best-effort */ }

        webview.postMessage({ type: 'riskScoreResult', payload: { blockId, scores } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'riskScoreResult', payload: { blockId, scores: [], error: errMsg } });
      }
      return true;
    }

    case "explainChange": {
      const { id, command } = msg.payload as { id: number; command: string };
      try {
        assertAiFeatureEnabled('AI_CHANGE_EXPLAINER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { getDbPath: _gdb } = await import('../../../storage/db.js');
        const changesDir = resolveChangesDir();
        // Try to read deploy.sql for the command (if it matches a change folder name)
        let deployContent = '';
        if (changesDir && command && !command.startsWith('-')) {
          const cmdSlug = command.replace(/^dmcr\s+/, '').trim().split(/\s+/)[0];
          const candidates = [
            path.join(changesDir, cmdSlug, 'deploy.sql'),
            path.join(changesDir, cmdSlug),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) {
              deployContent = fs.readFileSync(c, 'utf8').slice(0, 3000);
              break;
            }
          }
        }
        const systemPrompt = getPrompt('AI_CHANGE_EXPLAINER');
        const userMsg = `Command: ${command}\n${deployContent ? `\ndeploy.sql:\n\`\`\`sql\n${deployContent}\n\`\`\`` : '(no deploy.sql found — explain based on command name only)'}`;
        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const explanation = await callActiveLlm(systemPrompt, userMsg, 0.2, cts.token, () => {}, undefined, undefined, `explain-${id}`);
        webview.postMessage({ type: 'changeExplainResult', payload: { id, explanation } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'changeExplainResult', payload: { id, explanation: `Error: ${errMsg}` } });
      }
      return true;
    }

    case "saveTextFile": {
      const { content, filename } = msg.payload as { content: string; filename: string };
      const savePath = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), filename)),
        filters: { 'Markdown': ['md'], 'All Files': ['*'] },
        saveLabel: 'Export',
      });
      if (savePath) {
        fs.writeFileSync(savePath.fsPath, content, 'utf8');
        vscode.window.showInformationMessage(`Exported to ${path.basename(savePath.fsPath)}`);
      }
      return true;
    }

    /* ── D18.10 — AI Drift Detective (scheduled drift check) ── */
    case "scheduleDriftCheck": {
      const { sourceServerId, targetServerId, schema } = msg.payload as { sourceServerId: string; targetServerId: string; schema: string };
      try {
        assertAiFeatureEnabled('AI_DRIFT_DETECTIVE');
        const { upsert } = await import('../../../storage/db.js');
        upsert('drift_schedule', 'main', { sourceServerId, targetServerId, schema, scheduledAt: new Date().toISOString() });
        webview.postMessage({ type: 'driftScheduleAck', payload: { scheduled: true, schema } });
        // Run one-shot drift check now and post result
        const { callMcpTool } = await import('../../../services/mcp/agent/mcp-agent.js');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        webview.postMessage({ type: 'driftScheduleProgress', payload: { text: 'Discovering source schema objects…' } });
        const srcObjs = await callMcpTool('discover_objects', { schema }, sourceServerId);
        webview.postMessage({ type: 'driftScheduleProgress', payload: { text: 'Discovering target schema objects…' } });
        const tgtObjs = await callMcpTool('discover_objects', { schema }, targetServerId);
        const srcTables: string[] = (srcObjs as { tables?: string[] })?.tables ?? [];
        const tgtTables: string[] = (tgtObjs as { tables?: string[] })?.tables ?? [];
        const onlyInSrc = srcTables.filter(t => !tgtTables.includes(t));
        const onlyInTgt = tgtTables.filter(t => !srcTables.includes(t));
        const common = srcTables.filter(t => tgtTables.includes(t));
        webview.postMessage({ type: 'driftScheduleProgress', payload: { text: `Analysing ${common.length} shared tables for drift…` } });
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_DRIFT_DETECTIVE');
        const userMsg = `Schema: ${schema}
Source-only tables (missing from target): ${onlyInSrc.join(', ') || 'none'}
Target-only tables (extra in target): ${onlyInTgt.join(', ') || 'none'}
Common tables (may have column drift): ${common.slice(0, 20).join(', ')}
Total source tables: ${srcTables.length}, Total target tables: ${tgtTables.length}`;
        const raw = await callActiveLlm(systemPrompt, userMsg, 0.2, cts.token, () => {}, undefined, undefined, `drift-${Date.now()}`);
        let analysis: Record<string, string> = {};
        try {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) analysis = JSON.parse(m[0]);
        } catch { analysis = { riskLevel: 'medium', headline: raw.slice(0, 120), migrationAdvice: raw }; }
        webview.postMessage({ type: 'driftScheduleResult', payload: { analysis, onlyInSrc, onlyInTgt, common: common.length, schema } });
        // Show VS Code notification for significant drift
        if ((analysis.riskLevel === 'high' || onlyInSrc.length + onlyInTgt.length > 0)) {
          vscode.window.showWarningMessage(`DMCR Drift Detective: ${analysis.headline || 'Schema drift detected between environments'}`);
        } else {
          vscode.window.showInformationMessage(`DMCR Drift Detective: Schemas are in sync (${schema})`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'driftScheduleResult', payload: { error: errMsg } });
      }
      return true;
    }

    /* ── D19.2 — AI Environment Diff Explainer ── */
    case "explainDiff": {
      const { diffData, sourceServerId, targetServerId, schema } = msg.payload as { diffData: Record<string, unknown>; sourceServerId: string; targetServerId: string; schema: string };
      try {
        assertAiFeatureEnabled('AI_ENV_DIFF_EXPLAINER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        // Gather applied change history for context
        let historyCtx = '';
        if (changesDir && fs.existsSync(changesDir)) {
          const folders = fs.readdirSync(changesDir).filter(f => /^\d+_/.test(f)).sort().slice(-10);
          historyCtx = folders.map(f => {
            const metaPath = path.join(changesDir, f, 'meta.json');
            if (fs.existsSync(metaPath)) {
              try { const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); return `${f}: ${m.description || ''} (env: ${m.environment || 'unknown'})`; } catch { return f; }
            }
            return f;
          }).join('\n');
        }
        const onlyInSrc = (diffData['only_in_source'] as { name: string }[] | undefined)?.map(o => o.name) ?? [];
        const onlyInTgt = (diffData['only_in_target'] as { name: string }[] | undefined)?.map(o => o.name) ?? [];
        const drifted = (diffData['drifted'] as { name: string }[] | undefined)?.map(o => o.name) ?? [];
        const systemPrompt = getPrompt('AI_ENV_DIFF_EXPLAINER');
        const userMsg = `Schema: ${schema}
Source: ${sourceServerId}, Target: ${targetServerId}
Missing from target: ${onlyInSrc.join(', ') || 'none'}
Extra in target: ${onlyInTgt.join(', ') || 'none'}
DDL drifted: ${drifted.join(', ') || 'none'}
Recent applied changes:\n${historyCtx || 'none'}`;
        const cts = new CancellationTokenSource();
        const explanation = await callActiveLlm(systemPrompt, userMsg, 0.3, cts.token, () => {}, undefined, undefined, `explain-diff-${Date.now()}`);
        webview.postMessage({ type: 'diffExplanationResult', payload: { explanation } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'diffExplanationResult', payload: { explanation: `Error: ${errMsg}` } });
      }
      return true;
    }

    /* ── D19.1 — AI Promotion Gatekeeper ── */
    case "promotionGatekeep": {
      const { changeName, targetEnv } = msg.payload as { changeName: string; targetEnv: string };
      try {
        assertAiFeatureEnabled('AI_PROMOTION_GATEKEEPER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { callMcpTool: callMcpGate } = await import('../../../services/mcp/agent/mcp-agent.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        const changeDir = path.join(changesDir, changeName);
        const checks: { name: string; passed: boolean; detail: string }[] = [];
        // Check 1: meta.json exists + has ticket number
        let metaJson: Record<string, unknown> = {};
        const metaPath = path.join(changeDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          try { metaJson = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
          const hasTicket = !!(metaJson.ticket || metaJson.jira || metaJson.linear || metaJson.issue);
          checks.push({ name: 'Ticket reference', passed: hasTicket, detail: hasTicket ? `Ticket: ${metaJson.ticket || metaJson.jira || metaJson.linear || metaJson.issue}` : 'No ticket number in meta.json (add ticket, jira, linear, or issue field)' });
        } else {
          checks.push({ name: 'meta.json', passed: false, detail: 'meta.json not found in change folder' });
        }
        // Check 2: deploy.sql exists
        const deployPath = path.join(changeDir, 'deploy.sql');
        const deploySql = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, 'utf8').slice(0, 3000) : '';
        checks.push({ name: 'deploy.sql', passed: !!deploySql, detail: deploySql ? `${deploySql.split('\n').length} lines` : 'deploy.sql not found' });
        // Check 3: revert.sql exists
        const revertPath = path.join(changeDir, 'revert.sql');
        checks.push({ name: 'revert.sql', passed: fs.existsSync(revertPath), detail: fs.existsSync(revertPath) ? 'Present' : 'Missing — required for production promotion' });
        // Check 4: dependencies satisfied (requires in meta.json exist as folders)
        const requires: string[] = (metaJson.requires as string[] | undefined) ?? [];
        if (requires.length > 0) {
          const missing = requires.filter(r => !fs.existsSync(path.join(changesDir, r)));
          checks.push({ name: 'Dependencies', passed: missing.length === 0, detail: missing.length === 0 ? `All ${requires.length} dependencies found` : `Missing: ${missing.join(', ')}` });
        } else {
          checks.push({ name: 'Dependencies', passed: true, detail: 'No dependencies declared' });
        }
        // Check 5: AI policy check
        const { findById: findPoliciesGate } = await import('../../../storage/db.js');
        const policiesData = findPoliciesGate<{ policies: string[] | string }>('sql_policies', 'main');
        const rawPolicies = policiesData?.policies;
        // Saved as string[] by saveSqlPolicies; older builds stored a JSON string.
        const policies: string[] = Array.isArray(rawPolicies) ? rawPolicies
          : typeof rawPolicies === 'string' ? (() => { try { return JSON.parse(rawPolicies) as string[]; } catch { return []; } })() : [];
        let policyPassed = true; let policyDetail = 'No policies configured';
        if (policies.length > 0 && deploySql) {
          const cts2 = new CancellationTokenSource();
          const polRaw = await callActiveLlm(
            getPrompt('AI_SQL_POLICY_GUARD'),
            `Policies:\n${policies.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nSQL:\n${deploySql}`,
            0.1, cts2.token, () => {}, undefined, undefined, `gate-policy-${changeName}`
          );
          try {
            const pm = polRaw.match(/\[[\s\S]*\]/);
            const violations = pm ? JSON.parse(pm[0]) as { policy: string; violation: string; severity: string }[] : [];
            policyPassed = violations.filter(v => v.severity === 'error').length === 0;
            policyDetail = violations.length === 0 ? 'All policies pass' : violations.map(v => `${v.severity.toUpperCase()}: ${v.policy} — ${v.violation}`).join('; ');
          } catch { policyPassed = false; policyDetail = 'Could not read the AI policy check result — treated as failed. Re-run the gate.'; }
          checks.push({ name: 'SQL policies', passed: policyPassed, detail: policyDetail });
        }
        const allPassed = checks.every(c => c.passed);
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_PROMOTION_GATEKEEPER');
        const userMsg = `Change: ${changeName}\nTarget environment: ${targetEnv}\nChecklist:\n${checks.map(c => `${c.passed ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n')}`;
        const verdict = await callActiveLlm(systemPrompt, userMsg, 0.2, cts.token, () => {}, undefined, undefined, `gate-${changeName}`);
        webview.postMessage({ type: 'promotionGatekeeperResult', payload: { changeName, checks, allPassed, verdict } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'promotionGatekeeperResult', payload: { changeName, checks: [], allPassed: false, verdict: `Error: ${errMsg}` } });
      }
      return true;
    }

    /* ── D19.3 — AI Promotion Order Optimizer ── */
    case "optimizePromotionOrder": {
      const { changeNames } = msg.payload as { changeNames: string[] };
      try {
        assertAiFeatureEnabled('AI_PROMOTION_ORDER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        // Build context: read meta.json + first 500 chars of deploy.sql for each change
        const changeContexts = changeNames.map(name => {
          const changeDir = path.join(changesDir, name);
          let meta: Record<string, unknown> = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(changeDir, 'meta.json'), 'utf8')); } catch {}
          let sql = '';
          try { sql = fs.readFileSync(path.join(changeDir, 'deploy.sql'), 'utf8').slice(0, 400); } catch {}
          return `${name}:\n  requires: ${JSON.stringify(meta.requires ?? [])}\n  sql: ${sql.slice(0, 200)}`;
        }).join('\n\n');
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_PROMOTION_ORDER');
        const raw = await callActiveLlm(systemPrompt, `Changes to order:\n\n${changeContexts}`, 0.2, cts.token, () => {}, undefined, undefined, `promote-order-${Date.now()}`);
        let result: Record<string, unknown> = { orderedChanges: changeNames, conflicts: [], explanation: raw };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) result = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'promotionOrderResult', payload: result });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'promotionOrderResult', payload: { orderedChanges: changeNames, conflicts: [], explanation: `Error: ${errMsg}` } });
      }
      return true;
    }

    /* ── D19.4 — AI Blast Radius Estimator ── */
    case "estimateBlastRadius": {
      const { changeName, serverId: blastServerId } = msg.payload as { changeName: string; serverId: string };
      try {
        assertAiFeatureEnabled('AI_BLAST_RADIUS');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { callMcpTool: callMcpBlast } = await import('../../../services/mcp/agent/mcp-agent.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        const deployPath = path.join(changesDir, changeName, 'deploy.sql');
        const deploySql = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, 'utf8').slice(0, 3000) : '';
        // Extract table names from SQL
        const tableMatches = deploySql.match(/(?:ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+INDEX\s+ON)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?["']?(\w+\.?\w+)["']?/gi) ?? [];
        const tables = [...new Set(tableMatches.map(m => m.replace(/.*\s+/, '').replace(/['"]/g, '')))].slice(0, 5);
        // Query pg_depend for downstream objects
        let pgDependCtx = '';
        if (tables.length > 0 && blastServerId) {
          try {
            const depQuery = `SELECT DISTINCT dep.relname AS dependent_object, dep.relkind AS kind FROM pg_class dep JOIN pg_depend d ON d.objid = dep.oid JOIN pg_class src ON src.oid = d.refobjid WHERE src.relname = ANY(ARRAY[${tables.map(t => sqlLiteral(t.split('.').pop() ?? '')).join(',')}]) AND dep.relkind IN ('v','f','t') LIMIT 20`;
            const depResult = await callMcpBlast('run_readonly_query', { sql: depQuery }, blastServerId);
            pgDependCtx = JSON.stringify(depResult).slice(0, 1000);
          } catch {}
        }
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_BLAST_RADIUS');
        const raw = await callActiveLlm(systemPrompt, `Change: ${changeName}\nSQL:\n${deploySql}\nDependent objects from pg_depend:\n${pgDependCtx || 'none found'}`, 0.2, cts.token, () => {}, undefined, undefined, `blast-${changeName}`);
        let result: Record<string, unknown> = { riskLevel: 'medium', recommendation: raw };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) result = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'blastRadiusResult', payload: { changeName, ...result } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'blastRadiusResult', payload: { changeName, riskLevel: 'unknown', recommendation: `Error: ${errMsg}` } });
      }
      return true;
    }

    /* ── D19.5 — AI Blue/Green Deploy Planner ── */
    case "blueGreenPlan": {
      const { changeName } = msg.payload as { changeName: string };
      try {
        assertAiFeatureEnabled('AI_BLUE_GREEN_PLAN');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        const deployPath = path.join(changesDir, changeName, 'deploy.sql');
        const deploySql = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, 'utf8').slice(0, 3000) : '';
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_BLUE_GREEN_PLAN');
        const raw = await callActiveLlm(systemPrompt, `Change: ${changeName}\ndeploy.sql:\n${deploySql}`, 0.3, cts.token, () => {}, undefined, undefined, `bg-${changeName}`);
        let plan: Record<string, unknown> = { isBreakingChange: true, phase1: { description: '', sql: '' }, phase2: { description: '', sql: '' }, applicationInstructions: raw };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) plan = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'blueGreenPlanResult', payload: { changeName, plan } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'blueGreenPlanResult', payload: { changeName, plan: null, error: errMsg } });
      }
      return true;
    }

    /* ── D19.7 — AI Compliance Checker ── */
    case "checkCompliance": {
      const { changeName, profiles } = msg.payload as { changeName: string; profiles: string[] };
      try {
        assertAiFeatureEnabled('AI_COMPLIANCE_CHECKER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        const deployPath = path.join(changesDir, changeName, 'deploy.sql');
        const deploySql = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, 'utf8').slice(0, 3000) : '';
        const cts = new CancellationTokenSource();
        const PROFILE_RULES: Record<string, string> = {
          GDPR: 'PII columns (email, name, phone, address, ssn, dob) must have audit trail or RLS. No unencrypted PII defaults. Personal data tables need created_at/updated_at columns.',
          'SOC 2': 'All tables must have audit timestamps. No privileged escalation (SUPERUSER, BYPASSRLS) in migration. Changes to auth/access tables require explicit reason comment.',
          HIPAA: 'PHI tables require row-level security. No direct SELECT on phi/health/patient tables without RLS. Backup procedures must be documented in migration comments.',
        };
        const activeRules = profiles.map(p => `${p}: ${PROFILE_RULES[p] ?? 'custom compliance profile'}`).join('\n');
        const systemPrompt = getPrompt('AI_COMPLIANCE_CHECKER');
        const raw = await callActiveLlm(systemPrompt, `Compliance profiles:\n${activeRules}\n\ndeploy.sql:\n${deploySql}`, 0.1, cts.token, () => {}, undefined, undefined, `comply-${changeName}`);
        let violations: { profile: string; severity: string; rule: string; violation: string; remediation: string }[] = [];
        try { const m = raw.match(/\[[\s\S]*\]/); if (m) violations = JSON.parse(m[0]); } catch {}
        const passed = violations.filter(v => v.severity === 'error').length === 0;
        webview.postMessage({ type: 'complianceCheckResult', payload: { changeName, violations, passed } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'complianceCheckResult', payload: { changeName, violations: [], passed: false, error: errMsg } });
      }
      return true;
    }

    /* ── D19.8 — AI Conflict Resolver ── */
    case "resolveConflict": {
      const { changeName, stSql, prodSql } = msg.payload as { changeName: string; stSql: string; prodSql: string };
      try {
        assertAiFeatureEnabled('AI_CONFLICT_RESOLVER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_CONFLICT_RESOLVER');
        const raw = await callActiveLlm(systemPrompt, `Change: ${changeName}\nST migration SQL:\n${stSql}\n\nPROD migration SQL:\n${prodSql}`, 0.2, cts.token, () => {}, undefined, undefined, `conflict-${changeName}`);
        let result: Record<string, unknown> = { mergedSql: '', conflicts: [], mergeStrategy: raw, warnings: [] };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) result = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'conflictResolveResult', payload: { changeName, ...result } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'conflictResolveResult', payload: { changeName, mergedSql: '', error: errMsg } });
      }
      return true;
    }

    /* ── D19.9 — AI Canary Rollout Advisor ── */
    case "canaryRolloutAdvisor": {
      const { changeName, serverId: canaryServerId } = msg.payload as { changeName: string; serverId: string };
      try {
        assertAiFeatureEnabled('AI_CANARY_ADVISOR');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { callMcpTool: callMcpCanary } = await import('../../../services/mcp/agent/mcp-agent.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        const deployPath = path.join(changesDir, changeName, 'deploy.sql');
        const deploySql = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, 'utf8').slice(0, 2000) : '';
        // Get table size context
        const tableMatch = deploySql.match(/(?:ALTER\s+TABLE|CREATE\s+INDEX\s+ON)\s+(?:ONLY\s+)?["']?(\w+\.?\w+)["']?/i);
        const tableName = tableMatch ? tableMatch[1].split('.').pop() : null;
        let tableRows = 0;
        if (tableName && canaryServerId) {
          try {
            const sizeResult = await callMcpCanary('run_readonly_query', { sql: `SELECT reltuples::bigint AS row_estimate FROM pg_class WHERE relname = ${sqlLiteral(tableName)}` }, canaryServerId);
            tableRows = ((sizeResult as unknown) as { row_estimate?: number }[])?.[0]?.row_estimate ?? 0;
          } catch {}
        }
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_CANARY_ADVISOR');
        const raw = await callActiveLlm(systemPrompt, `Change: ${changeName}\nSQL:\n${deploySql}\nTable: ${tableName || 'unknown'}\nEstimated rows: ${tableRows.toLocaleString()}`, 0.3, cts.token, () => {}, undefined, undefined, `canary-${changeName}`);
        let advice: Record<string, unknown> = { recommendCanary: tableRows > 1000000, tableName, estimatedRows: tableRows };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) advice = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'canaryRolloutResult', payload: { changeName, advice } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'canaryRolloutResult', payload: { changeName, advice: null, error: errMsg } });
      }
      return true;
    }

    /* ── D19.10 — AI Ticket Linker ── */
    case "linkTickets": {
      const { changeNames: ticketChangeNames } = msg.payload as { changeNames: string[] };
      try {
        assertAiFeatureEnabled('AI_TICKET_LINKER');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        // Read meta.json for each change + git log for ticket patterns
        const changeInfos = ticketChangeNames.map(name => {
          let meta: Record<string, unknown> = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(changesDir, name, 'meta.json'), 'utf8')); } catch {}
          return { name, existingTicket: meta.ticket || meta.jira || meta.linear || meta.issue || null, description: meta.description || '' };
        });
        // Try git log for ticket refs
        let gitLog = '';
        try { gitLog = cp.execSync('git log --oneline -20', { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }).toString().slice(0, 1000); } catch {}
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_TICKET_LINKER');
        const userMsg = `Changes:\n${changeInfos.map(c => `${c.name}: existing=${c.existingTicket || 'none'}, desc=${c.description}`).join('\n')}\n\nRecent git commits:\n${gitLog}`;
        const raw = await callActiveLlm(systemPrompt, userMsg, 0.2, cts.token, () => {}, undefined, undefined, `tickets-${Date.now()}`);
        let links: { changeName: string; ticketId: string; ticketSystem: string; confidence: string; source: string }[] = [];
        try { const m = raw.match(/\[[\s\S]*\]/); if (m) links = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'ticketLinkerResult', payload: { links } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'ticketLinkerResult', payload: { links: [], error: errMsg } });
      }
      return true;
    }

    /* ── D18.12 — AI Performance Impact Predictor ── */
    case "predictPerformanceImpact": {
      const { changeName, serverId: perfServerId } = msg.payload as { changeName: string; serverId: string };
      try {
        assertAiFeatureEnabled('AI_PERF_PREDICTOR');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { callMcpTool: callMcpPerf } = await import('../../../services/mcp/agent/mcp-agent.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        const deployPath = path.join(changesDir, changeName, 'deploy.sql');
        const deploySql = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, 'utf8').slice(0, 3000) : '';
        // Check if this is an index or ALTER statement
        const isIndexCreate = /CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(deploySql);
        const isAlterTable = /ALTER\s+TABLE/i.test(deploySql);
        let tableStats = '';
        if ((isIndexCreate || isAlterTable) && perfServerId) {
          const tableMatch = deploySql.match(/(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON|ALTER\s+TABLE)\s+(?:ONLY\s+)?["']?(\w+\.?\w+)["']?/i);
          const tbl = tableMatch ? tableMatch[1].split('.').pop() : null;
          if (tbl) {
            try {
              const statsResult = await callMcpPerf('run_readonly_query', { sql: `SELECT reltuples::bigint as rows, pg_size_pretty(pg_total_relation_size(oid)) as size FROM pg_class WHERE relname=${sqlLiteral(tbl)} LIMIT 1` }, perfServerId);
              tableStats = JSON.stringify(statsResult).slice(0, 500);
            } catch {}
          }
        }
        const cts = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_PERF_PREDICTOR');
        const raw = await callActiveLlm(systemPrompt, `Change: ${changeName}\nSQL:\n${deploySql}\nTable stats:\n${tableStats || 'not available'}`, 0.2, cts.token, () => {}, undefined, undefined, `perf-${changeName}`);
        let prediction: Record<string, unknown> = { lockType: 'ACCESS EXCLUSIVE', blocksApplicationTraffic: true, recommendation: 'SCHEDULE MAINTENANCE WINDOW', details: raw };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) prediction = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'performanceImpactResult', payload: { changeName, prediction } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'performanceImpactResult', payload: { changeName, prediction: null, error: errMsg } });
      }
      return true;
    }

    /* ── D19.6 — AI Post-Deploy Health Check ── */
    case "postDeployHealthCheck": {
      const { changeName, serverId: healthServerId } = msg.payload as { changeName: string; serverId: string };
      try {
        assertAiFeatureEnabled('AI_POST_DEPLOY_HEALTH');
        const { callActiveLlm } = await import('../../../services/llm/core/llm-client.js');
        const { callMcpTool: callMcpHealth } = await import('../../../services/mcp/agent/mcp-agent.js');
        const { CancellationTokenSource } = await import('vscode');
        const changesDir = resolveChangesDir();
        const deployPath = path.join(changesDir, changeName, 'deploy.sql');
        const deploySql = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, 'utf8').slice(0, 3000) : '';
        // Generate health check queries based on the SQL content
        const cts = new CancellationTokenSource();
        const qGenPrompt = `Given this deploy.sql, generate 3-5 targeted diagnostic SQL queries to verify the migration succeeded correctly. Return ONLY a JSON array of strings: ["SELECT ...", "SELECT ..."]`;
        const qRaw = await callActiveLlm(qGenPrompt, `deploy.sql:\n${deploySql}`, 0.2, cts.token, () => {}, undefined, undefined, `health-gen-${changeName}`);
        let healthQueries: string[] = [];
        try { const m = qRaw.match(/\[[\s\S]*\]/); if (m) healthQueries = JSON.parse(m[0]); } catch {}
        // Run each query
        const healthResults: { query: string; result: unknown; error?: string }[] = [];
        for (const q of healthQueries.slice(0, 5)) {
          // These queries were written by the AI: only single read-only statements are sent.
          if (!isSingleReadOnlyStatement(q)) {
            healthResults.push({ query: String(q), result: null, error: 'Skipped: only a single SELECT / WITH / EXPLAIN statement is allowed.' });
            continue;
          }
          try {
            const r = await callMcpHealth('run_readonly_query', { sql: q }, healthServerId);
            healthResults.push({ query: q, result: r });
          } catch (e) {
            healthResults.push({ query: q, result: null, error: String(e) });
          }
        }
        // AI interprets results
        const cts2 = new CancellationTokenSource();
        const systemPrompt = getPrompt('AI_POST_DEPLOY_HEALTH');
        const raw = await callActiveLlm(systemPrompt, `Change: ${changeName}\nHealth check results:\n${JSON.stringify(healthResults, null, 2).slice(0, 2000)}`, 0.2, cts2.token, () => {}, undefined, undefined, `health-assess-${changeName}`);
        let assessment: Record<string, unknown> = { status: 'healthy', summary: raw, checks: healthResults.map(r => ({ query: r.query, status: r.error ? 'fail' : 'pass', finding: r.error || 'OK' })), recommendations: [] };
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) assessment = JSON.parse(m[0]); } catch {}
        webview.postMessage({ type: 'postDeployHealthResult', payload: { changeName, assessment } });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'postDeployHealthResult', payload: { changeName, assessment: null, error: errMsg } });
      }
      return true;
    }

    default:
      return false;
  }
}
