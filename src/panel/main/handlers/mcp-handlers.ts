/**
 * MCP server + schema explorer message handlers.
 */
import * as vscode from "vscode";
import { callSchemaCapability, discoverAllSchemas, validateDbServer } from "../../../services/mcp/agent/mcp-db-agent";
import type { HandlerContext, Message } from "./types";
import {
  buildTableSnapshot, checkWhere, columnsQuery, countQuery, primaryKeyQuery, snapshotName,
  takenNamesQuery, uniqueSnapshotName, type SnapshotColumn, type SnapshotRows,
} from "../../../services/snapshot/table-snapshot";

/** One read-only query through the server's run_readonly_query tool → rows as objects. */
async function mcpRows(sql: string, serverId?: string): Promise<Record<string, string | null>[]> {
  const r = await callSchemaCapability('run_readonly_query', { sql, limit: 1000 }, serverId);
  if (!r.success) { throw new Error(r.error ?? 'query failed'); }
  const data = r.data as { columns?: string[]; rows?: (string | null)[][]; error?: string } | null;
  if (data?.error) { throw new Error(data.error); }
  const cols = data?.columns ?? [];
  return (data?.rows ?? []).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

/** Columns (exact types), primary key and existing backup names of a table, read over MCP. */
async function readSnapshotSource(schema: string, table: string, serverId?: string) {
  const colRows = await mcpRows(columnsQuery(schema, table), serverId);
  if (!colRows.length) { throw new Error(`${schema}.${table} is not a table on this server`); }
  const columns: SnapshotColumn[] = colRows.map(r => ({ name: String(r.name), type: String(r.type), notNull: r.not_null === 'True' || r.not_null === 'true' || r.not_null === 't' }));
  const primaryKey = (await mcpRows(primaryKeyQuery(schema, table), serverId)).map(r => String(r.name));
  return { columns, primaryKey };
}

async function countRows(schema: string, table: string, where: string | undefined, serverId?: string): Promise<number> {
  const rows = await mcpRows(countQuery(schema, table, where), serverId);
  return Number(rows[0]?.n ?? 0);
}

async function takenNames(schema: string, prefix: string, serverId?: string): Promise<string[]> {
  return (await mcpRows(takenNamesQuery(schema, prefix), serverId)).map(r => String(r.name));
}

async function serverLabel(serverId?: string): Promise<string> {
  try {
    const { listDatabaseServers } = await import('../../../services/mcp/server/mcp.js');
    const srv = listDatabaseServers().find(s => s.id === serverId);
    return srv ? `MCP server "${srv.name}"` : 'MCP';
  } catch { return 'MCP'; }
}

export async function handleMcpMessage(ctx: HandlerContext, msg: Message): Promise<boolean> {
  const { webview } = ctx;

  switch (msg.type) {

    /* ── MCP Servers ── */
    case "getMcpServers": {
      try {
        const { listServersForUi } = await import('../../../services/mcp/server/mcp.js');
        webview.postMessage({ type: "mcpServers", payload: listServersForUi() });
      } catch {
        webview.postMessage({ type: "mcpServers", payload: [] });
      }
      return true;
    }

    case "upsertMcpServer": {
      try {
        const { upsertServer, listServersForUi, listDatabaseServers, deleteServer } = await import('../../../services/mcp/server/mcp.js');
        const payload = msg.payload as Record<string, unknown>;
        const isDatabase = payload.category === 'database';
        const saved = await upsertServer(payload);

        if (isDatabase) {
          try {
            const validation = await Promise.race([
              validateDbServer(saved.id, saved.name),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Validation timed out after 15 s')), 15_000)),
            ]);
            if (!validation.compliant) {
              deleteServer(saved.id);
              const missingList = validation.missing.join(', ');
              webview.postMessage({ type: "mcpServers", payload: listServersForUi() });
              webview.postMessage({
                type: "dbMcpValidation",
                payload: {
                  serverId: saved.id,
                  serverName: saved.name,
                  compliant: false,
                  supported: validation.supported,
                  missing: validation.missing,
                  error: `Server "${saved.name}" does not implement required DB capabilities: ${missingList}. Cannot add as a database server.`,
                },
              });
              return true;
            }
            webview.postMessage({
              type: "dbMcpValidation",
              payload: {
                serverId: saved.id,
                serverName: saved.name,
                compliant: true,
                supported: validation.supported,
                missing: [],
              },
            });
          } catch (valErr) {
            deleteServer(saved.id);
            webview.postMessage({ type: "mcpServers", payload: listServersForUi() });
            webview.postMessage({
              type: "dbMcpValidation",
              payload: {
                serverId: saved.id,
                serverName: saved.name,
                compliant: false,
                supported: [],
                missing: [],
                error: `Could not validate server "${saved.name}": ${valErr instanceof Error ? valErr.message : String(valErr)}. Make sure the server is running and reachable.`,
              },
            });
            return true;
          }
        }

        webview.postMessage({ type: "mcpServers", payload: listServersForUi() });
        vscode.commands.executeCommand('setContext', 'dmcr.hasDbMcp', listDatabaseServers().length > 0);
      } catch (e: unknown) {
        webview.postMessage({ type: "error", payload: `upsertMcpServer: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    case "deleteMcpServer": {
      try {
        const { deleteServer, listServersForUi, listDatabaseServers } = await import('../../../services/mcp/server/mcp.js');
        const { id } = msg.payload as { id: string };
        deleteServer(id);
        webview.postMessage({ type: "mcpServers", payload: listServersForUi() });
        vscode.commands.executeCommand('setContext', 'dmcr.hasDbMcp', listDatabaseServers().length > 0);
      } catch (e: unknown) {
        webview.postMessage({ type: "error", payload: `deleteMcpServer: ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    case "validateDbMcpServer": {
      const { id: valId, name: valName } = (msg.payload ?? {}) as { id?: string; name?: string };
      if (!valId) return true;
      try {
        const validation = await Promise.race([
          validateDbServer(valId, valName),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15_000)),
        ]);
        webview.postMessage({ type: "dbMcpValidation", payload: { ...validation } });
      } catch (e) {
        webview.postMessage({
          type: "dbMcpValidation",
          payload: { serverId: valId, serverName: valName ?? valId, compliant: false, supported: [], missing: [], error: String(e) },
        });
      }
      return true;
    }

    case "getMcpTools": {
      const { id } = (msg.payload ?? {}) as { id?: string };
      if (!id) {
        webview.postMessage({ type: "mcpTools", payload: { id, tools: [], error: "No server id" } });
        return true;
      }
      try {
        const { mcpListTools } = await import('../../../services/mcp/server/mcp.js');
        const refresh = true;
        const tools = await mcpListTools(id, refresh);
        webview.postMessage({ type: "mcpTools", payload: { id, tools, error: null } });
      } catch (e: unknown) {
        webview.postMessage({ type: "mcpTools", payload: { id, tools: [], error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    case "restartMcpServer": {
      const { id } = (msg.payload ?? {}) as { id?: string };
      if (!id) { webview.postMessage({ type: "mcpRestarted", payload: { id, tools: [], error: "No server id" } }); return true; }
      try {
        const { restartServer } = await import('../../../services/mcp/server/mcp.js');
        const tools = await restartServer(id);
        webview.postMessage({ type: "mcpRestarted", payload: { id, tools, error: null } });
      } catch (e: unknown) {
        webview.postMessage({ type: "mcpRestarted", payload: { id, tools: [], error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    /* ── MCP Schema Explorer ── */
    case "getDbMcpStatus": {
      const { listDatabaseServers: listDbServers } = await import('../../../services/mcp/server/mcp.js');
      const hasDbMcp = listDbServers().length > 0;
      webview.postMessage({ type: 'dbMcpStatus', payload: { hasDbMcp } });
      return true;
    }

    case "getDbMcpServers": {
      const { listDatabaseServers: listDbSrvs } = await import('../../../services/mcp/server/mcp.js');
      const servers = listDbSrvs().map(s => ({ id: s.id, name: s.name }));
      webview.postMessage({ type: 'dbMcpServers', payload: { servers } });
      return true;
    }

    case "discoverAllDbSchemas": {
      try {
        const schemas = await discoverAllSchemas();
        webview.postMessage({ type: 'allDbSchemas', payload: { schemas } });
      } catch {
        webview.postMessage({ type: 'allDbSchemas', payload: { schemas: [] } });
      }
      return true;
    }

    case "discoverMcpSchemas": {
      const sid = (msg.payload as { serverId?: string })?.serverId;
      try {
        const schemasResult = await Promise.race([
          callSchemaCapability('discover_schemas', {}, sid),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Schema discovery timed out after 15 s')), 15_000)),
        ]);
        if (!schemasResult.success) {
          webview.postMessage({ type: 'mcpSchemas', payload: { serverId: sid, schemas: [], connected: false, error: schemasResult.error ?? 'No tool matched for schema listing' } });
          return true;
        }
        const schemas: string[] = (schemasResult.data as { schemas?: string[] })?.schemas ?? [];
        webview.postMessage({ type: 'mcpSchemas', payload: { serverId: sid, schemas, connected: true } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'mcpSchemas', payload: { serverId: sid, schemas: [], connected: false, error: String(e) } });
      }
      return true;
    }

    case "discoverMcpObjects": {
      const { schema, serverId: objSid } = (msg.payload ?? {}) as { schema?: string; serverId?: string };
      if (!schema) { webview.postMessage({ type: 'mcpObjects', payload: { schema, serverId: objSid, objects: null, error: 'No schema' } }); return true; }
      try {
        const objResult = await Promise.race([
          callSchemaCapability('discover_objects', { schema }, objSid),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out fetching objects')), 15_000)),
        ]);
        if (!objResult.success) {
          webview.postMessage({ type: 'mcpObjects', payload: { schema, serverId: objSid, objects: null, error: objResult.error ?? 'No tool matched for object listing' } });
          return true;
        }
        const raw = (objResult.data as { objects?: Array<{ name: string; type: string }> })?.objects ?? [];
        const objects = {
          tables:    raw.filter(o => o.type === 'table').map(o => o.name),
          views:     raw.filter(o => o.type === 'view').map(o => o.name),
          functions: raw.filter(o => o.type === 'function').map(o => o.name),
          sequences: raw.filter(o => o.type === 'sequence').map(o => o.name),
        };
        webview.postMessage({ type: 'mcpObjects', payload: { schema, serverId: objSid, objects } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'mcpObjects', payload: { schema, serverId: objSid, objects: null, error: String(e) } });
      }
      return true;
    }

    case "describeMcpTable": {
      const { schema, table, serverId: descSid } = (msg.payload ?? {}) as { schema?: string; table?: string; serverId?: string };
      if (!schema || !table) { webview.postMessage({ type: 'mcpTableDesc', payload: { schema, table, columns: null, error: 'Missing params' } }); return true; }
      try {
        const descResult = await Promise.race([
          callSchemaCapability('describe_table', { schema, name: table }, descSid),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out fetching columns')), 15_000)),
        ]);
        if (!descResult.success) {
          webview.postMessage({ type: 'mcpTableDesc', payload: { schema, table, columns: null, error: descResult.error ?? 'No tool matched for table description' } });
          return true;
        }
        const data = descResult.data as { columns?: Array<{ name: string; type?: string; data_type?: string; is_nullable?: boolean; nullable?: boolean; column_default?: string; default_value?: string }> } | null;
        const columns = (data?.columns ?? []).map(c => ({
          name: c.name,
          type: c.type || c.data_type || '',
          nullable: c.nullable ?? c.is_nullable,
          default_value: c.default_value || c.column_default || null,
        }));
        webview.postMessage({ type: 'mcpTableDesc', payload: { schema, table, columns } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'mcpTableDesc', payload: { schema, table, columns: null, error: String(e) } });
      }
      return true;
    }

    case "mcpCallTool": {
      const { serverId, toolName, args } = msg.payload as { serverId: string; toolName: string; args?: Record<string, unknown> };
      try {
        const { mcpCallTool } = await import('../../../services/mcp/server/mcp.js');
        const result = await mcpCallTool(serverId, toolName, args ?? {});
        webview.postMessage({ type: "mcpToolResult", payload: { serverId, toolName, success: true, data: result } });
      } catch (e: unknown) {
        webview.postMessage({ type: "error", payload: `mcpCallTool(${toolName}): ${e instanceof Error ? e.message : String(e)}` });
      }
      return true;
    }

    case "getObjectDefinition": {
      const { schema, name, nodeType, serverId } = msg.payload as { schema: string; name: string; nodeType: string; serverId?: string };
      try {
        const qualifiedName = schema ? `${schema}.${name}` : name;
        // Use get_ddl capability — MCP server returns the actual SQL definition
        const result = await callSchemaCapability('get_ddl', { schema, name, object_type: nodeType }, serverId);
        let definition = '';
        if (result?.success) {
          const data = result.data as { ddl?: string; definition?: string; sql?: string } | string | null;
          if (typeof data === 'string') {
            definition = data;
          } else if (data) {
            definition = data.ddl || data.definition || data.sql || '';
          }
        }
        if (definition) {
          await vscode.env.clipboard.writeText(definition);
          vscode.window.showInformationMessage(`Definition copied to clipboard: ${name}`);
        } else {
          vscode.window.showWarningMessage(`No DDL returned for ${qualifiedName}. The MCP server may not support get_ddl for ${nodeType}.`);
        }
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Failed to get definition: ${e instanceof Error ? e.message : String(e)}`);
      }
      return true;
    }

    /* ── Table snapshot: a change folder that copies a table into <table>_backup_DD_MM_YYYY ── */
    case "snapshotTablePrepare": {
      const { schema, table, serverId } = (msg.payload ?? {}) as { schema: string; table: string; serverId?: string };
      try {
        const { columns, primaryKey } = await readSnapshotSource(schema, table, serverId);
        const rowCount = await countRows(schema, table, undefined, serverId);
        const base = snapshotName(table);
        const suggestedName = uniqueSnapshotName(base, await takenNames(schema, base, serverId));
        webview.postMessage({ type: 'tableSnapshotInfo', payload: { schema, table, serverId, server: await serverLabel(serverId), columns, primaryKey, rowCount, suggestedName } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'tableSnapshotInfo', payload: { schema, table, serverId, error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    case "snapshotTableCount": {
      const { schema, table, serverId, where } = (msg.payload ?? {}) as { schema: string; table: string; serverId?: string; where?: string };
      try {
        const problem = where !== undefined ? checkWhere(where) : null;
        if (problem) { throw new Error(problem); }
        webview.postMessage({ type: 'tableSnapshotCount', payload: { where, count: await countRows(schema, table, where, serverId) } });
      } catch (e: unknown) {
        webview.postMessage({ type: 'tableSnapshotCount', payload: { where, error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    case "createTableSnapshot": {
      const p = (msg.payload ?? {}) as { schema: string; table: string; serverId?: string; rows: SnapshotRows; where?: string; backupName: string; location?: string };
      try {
        const backupName = (p.backupName ?? '').trim();
        if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(backupName)) { throw new Error('Backup table name: letters, digits and _ only, not starting with a digit'); }
        // Read everything again: the change must match the table as it is now
        const { columns, primaryKey } = await readSnapshotSource(p.schema, p.table, p.serverId);
        if ((await takenNames(p.schema, backupName, p.serverId)).includes(backupName)) {
          throw new Error(`${p.schema}.${backupName} already exists on this server — pick another name`);
        }
        const where = p.rows === 'where' ? p.where : undefined;
        const rowsAtGeneration = p.rows === 'none' ? 0 : await countRows(p.schema, p.table, where, p.serverId); // also validates the WHERE
        const change = buildTableSnapshot({
          schema: p.schema, table: p.table, columns, primaryKey, rows: p.rows, where, backupName,
          sourceLabel: await serverLabel(p.serverId), rowsAtGeneration,
        });
        const { saveChangeToDisk } = await import('./types.js');
        const { nextId, folderRel, deployUri } = await saveChangeToDisk({ ...change, location: p.location });
        webview.postMessage({ type: 'tableSnapshotCreated', payload: { folderId: nextId, folderRel, backup: `${p.schema}.${backupName}`, rowsAtGeneration } });
        try {
          const { DmcrPanel } = await import("../DmcrPanel.js");
          DmcrPanel.currentPanel?.postMessage({ type: 'generationDone', payload: { folderId: nextId, folderRel, isDanger: false } });
        } catch { /* main panel may not be open */ }
        await vscode.window.showTextDocument(deployUri, { preview: false });
      } catch (e: unknown) {
        webview.postMessage({ type: 'tableSnapshotCreated', payload: { error: e instanceof Error ? e.message : String(e) } });
      }
      return true;
    }

    case "openFormWithPrefill": {
      const { form, table, schema, sql, hint, columns } = msg.payload as { form: string; table?: string; schema?: string; sql?: string; hint?: string; columns?: Array<{name: string; type: string}> };
      try {
        const { DmcrPanel } = await import("../DmcrPanel.js");
        if (DmcrPanel.currentPanel) {
          DmcrPanel.currentPanel.postMessage({ type: 'formPrefill', payload: { form, table, schema, sql, hint, columns } });
        }
      } catch { /* main panel may not be open */ }
      return true;
    }

    default:
      return false;
  }
}
