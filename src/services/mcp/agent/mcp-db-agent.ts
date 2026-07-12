/**
 * MCP Database Agent — schema discovery and introspection for database MCP servers.
 *
 * Standard MCP DB Interface Contract:
 *   Required capabilities a DB MCP server MUST implement:
 *     1. discover_schemas  (list_schemas)    — list all schemas in the database
 *     2. discover_objects  (list_objects)     — list tables/views/functions in a schema
 *     3. describe_table                      — describe columns/constraints of a table
 *     4. describe_function                   — describe signature/body of a function
 *     5. describe_sequence                   — describe a sequence (current value, increment, etc.)
 *
 * All matching is dynamic — NO hardcoded tool names. Tools are matched by
 * description keywords + inputSchema shape so this works with any MCP server.
 *
 * Delegated to by mcp-agent.ts for all database-related operations.
 */

import { mcpListTools, mcpCallTool as mcpCallToolDirect, listDatabaseServers } from '../server/mcp';
import { callMcpTool, discoverAllTools, discoverToolsFromServer, type McpToolInfo, type McpToolResult } from './mcp-agent';

// ── DB MCP Interface Contract ────────────────────────────────────────────────

/**
 * All capabilities a fully-compliant DB MCP server must implement.
 * Mirrors the pgsql_mcp reference implementation (13 tools).
 */
export type DbCapability =
  | 'discover_schemas'
  | 'discover_objects'
  | 'describe_table'
  | 'describe_function'
  | 'describe_sequence'
  | 'get_ddl'
  | 'compare_schemas'
  | 'run_readonly_query'
  | 'enable_objects'
  | 'disable_objects'
  | 'list_enabled'
  | 'enable_all_in_schema'
  | 'get_enabled_context';

/** Kept for backward-compat — alias used by schema explorer, DmcrPanel, etc. */
export type SchemaCapability = DbCapability;

/** Core capabilities — schema introspection + DDL retrieval. */
export const CORE_DB_CAPABILITIES: readonly DbCapability[] = [
  'discover_schemas',
  'discover_objects',
  'describe_table',
  'describe_function',
  'describe_sequence',
  'get_ddl',
] as const;

/** All required capabilities for a fully compliant DB MCP server (pgsql_mcp interface). */
export const REQUIRED_DB_CAPABILITIES: readonly DbCapability[] = [
  'discover_schemas',
  'discover_objects',
  'describe_table',
  'describe_function',
  'describe_sequence',
  'get_ddl',
  'compare_schemas',
  'run_readonly_query',
  'enable_objects',
  'disable_objects',
  'list_enabled',
  'enable_all_in_schema',
  'get_enabled_context',
] as const;

interface ResolvedCapability {
  toolName: string;
  serverId: string;
}

// ── Capability resolution ────────────────────────────────────────────────────

/**
 * Discover tools from database MCP servers and match them to DB capabilities.
 * Uses description keywords + inputSchema analysis to identify which tool
 * serves each purpose. Returns a map of capability → tool info.
 *
 * @param serverId  Optional — scope to a single server. If omitted, checks all DB servers.
 */
export async function resolveDbCapabilities(serverId?: string): Promise<Map<DbCapability, ResolvedCapability>> {
  const tools = serverId
    ? await discoverToolsFromServer({ id: serverId, name: '' })
    : await discoverDbTools();

  const caps = new Map<DbCapability, ResolvedCapability>();

  for (const tool of tools) {
    const desc = (tool.description || '').toLowerCase();
    const name = tool.name.toLowerCase();
    const params = tool.inputSchema?.properties
      ? Object.keys(tool.inputSchema.properties as Record<string, unknown>)
      : [];

    // ── discover_schemas: tool that lists/discovers schemas ──
    if (!caps.has('discover_schemas')) {
      const isSchemaLister =
        (desc.includes('schema') && (desc.includes('list') || desc.includes('discover') || desc.includes('all'))) ||
        name.includes('schema') && (name.includes('list') || name.includes('discover'));
      // Should have NO required schema input (it lists ALL schemas)
      if (isSchemaLister && !params.includes('schema') && !params.includes('table')) {
        caps.set('discover_schemas', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── discover_objects: tool that lists objects IN a schema ──
    if (!caps.has('discover_objects')) {
      const isObjectLister =
        (desc.includes('object') || desc.includes('table') || desc.includes('view') || desc.includes('function')) &&
        (desc.includes('list') || desc.includes('discover') || desc.includes('all'));
      // Should accept a `schema` param but NOT a `table`/`name` param
      if (isObjectLister && params.includes('schema') && !params.includes('table') && !params.includes('name')) {
        caps.set('discover_objects', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── describe_table: tool that describes a specific table ──
    if (!caps.has('describe_table')) {
      const isTableDescriber =
        (desc.includes('table') || desc.includes('view')) &&
        (desc.includes('detail') || desc.includes('describe') || desc.includes('column') || desc.includes('structure'));
      // Should accept schema + (table or name) param
      if (isTableDescriber && params.includes('schema') && (params.includes('table') || params.includes('name'))) {
        caps.set('describe_table', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── describe_function: tool that describes a function/procedure ──
    if (!caps.has('describe_function')) {
      const isFuncDescriber =
        desc.includes('function') &&
        (desc.includes('describe') || desc.includes('signature') || desc.includes('body') || desc.includes('detail'));
      if (isFuncDescriber && params.includes('schema') && params.includes('name')) {
        caps.set('describe_function', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── describe_sequence: tool that describes a sequence ──
    if (!caps.has('describe_sequence')) {
      const isSeqDescriber =
        desc.includes('sequence') &&
        (desc.includes('describe') || desc.includes('detail') || desc.includes('current'));
      if (isSeqDescriber && params.includes('schema') && params.includes('name')) {
        caps.set('describe_sequence', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── get_ddl: tool that returns the SQL DDL/definition for any object ──
    if (!caps.has('get_ddl')) {
      const isDdlProvider =
        (desc.includes('ddl') || desc.includes('definition') || desc.includes('create statement') || desc.includes('source code')) &&
        (name.includes('ddl') || name.includes('definition') || name.includes('source'));
      if (isDdlProvider && params.includes('schema') && params.includes('name')) {
        caps.set('get_ddl', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── compare_schemas: diff the schema of two databases ──
    if (!caps.has('compare_schemas')) {
      const isSchemaComparer = desc.includes('compare') && desc.includes('schema');
      if (isSchemaComparer) {
        caps.set('compare_schemas', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── run_readonly_query: execute an ad-hoc read-only SELECT ──
    if (!caps.has('run_readonly_query')) {
      const isQueryRunner =
        (desc.includes('read-only') || desc.includes('readonly') || desc.includes('select')) &&
        (desc.includes('query') || desc.includes('execute'));
      if (isQueryRunner && params.includes('sql')) {
        caps.set('run_readonly_query', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── enable_objects: enable specific objects for AI context ──
    if (!caps.has('enable_objects')) {
      const isEnabler = desc.includes('enable') && (desc.includes('object') || desc.includes('context')) && !desc.includes('all');
      // Takes an `objects` array param — distinguishes it from enable_all_in_schema's single `schema` param
      if (isEnabler && params.includes('objects') && !params.includes('schema')) {
        caps.set('enable_objects', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── disable_objects: disable specific objects from AI context ──
    if (!caps.has('disable_objects')) {
      const isDisabler = desc.includes('disable') && (desc.includes('object') || desc.includes('context'));
      if (isDisabler && params.includes('objects')) {
        caps.set('disable_objects', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── list_enabled: show all currently enabled objects ──
    if (!caps.has('list_enabled')) {
      const isEnabledLister =
        desc.includes('enabled') && !desc.includes('context') && (desc.includes('list') || desc.includes('show'));
      // No required params — lists whatever is already enabled
      if (isEnabledLister && params.length === 0) {
        caps.set('list_enabled', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── enable_all_in_schema: enable every object in a given schema ──
    if (!caps.has('enable_all_in_schema')) {
      const isEnableAll = desc.includes('enable') && desc.includes('all') && desc.includes('schema');
      // Takes a single `schema` param — not an `objects` array
      if (isEnableAll && params.includes('schema') && !params.includes('objects')) {
        caps.set('enable_all_in_schema', { toolName: tool.name, serverId: tool.serverId });
      }
    }

    // ── get_enabled_context: full schema-context text for enabled objects (for AI prompts) ──
    if (!caps.has('get_enabled_context')) {
      const isContextProvider = desc.includes('context') && desc.includes('enabled');
      if (isContextProvider && params.length === 0) {
        caps.set('get_enabled_context', { toolName: tool.name, serverId: tool.serverId });
      }
    }
  }

  return caps;
}

/** Backward-compat alias — used by SchemaExplorerProvider etc. */
export const resolveSchemaCapabilities = resolveDbCapabilities;

// ── Capability invocation ────────────────────────────────────────────────────

/**
 * Call a DB capability by its semantic purpose (not tool name).
 * Discovers tools, matches the right one, and calls it via mcp-agent.
 */
export async function callDbCapability(
  capability: DbCapability,
  args: Record<string, unknown>,
  serverId?: string,
): Promise<McpToolResult> {
  const caps = await resolveDbCapabilities(serverId);
  const resolved = caps.get(capability);
  if (!resolved) {
    return {
      success: false,
      data: null,
      error: `No MCP tool found for DB capability "${capability}". Available tools don't match the expected pattern.`,
    };
  }
  return callMcpTool(resolved.toolName, args, resolved.serverId);
}

/** Backward-compat alias */
export const callSchemaCapability = callDbCapability;

// ── DB tool discovery ────────────────────────────────────────────────────────

/**
 * Discover tools from all database-category MCP servers.
 */
export async function discoverDbTools(): Promise<McpToolInfo[]> {
  const dbServers = listDatabaseServers();
  if (!dbServers.length) return [];

  const results: McpToolInfo[] = [];
  for (const srv of dbServers) {
    try {
      const tools = await mcpListTools(srv.id);
      results.push(...tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        serverId: srv.id,
        serverName: srv.name,
      })));
    } catch {
      // Server unreachable — skip silently
    }
  }
  return results;
}

// ── Aggregate queries (used by DmcrPanel) ────────────────────────────────────

/**
 * Fetch all unique schema names from every DB MCP server.
 * Returns a sorted deduplicated array.
 */
export async function discoverAllSchemas(): Promise<string[]> {
  const dbServers = listDatabaseServers();
  const allSchemas: string[] = [];

  for (const srv of dbServers) {
    try {
      const res = await Promise.race([
        callDbCapability('discover_schemas', {}, srv.id),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
      ]);
      if (res.success) {
        const schemas = (res.data as { schemas?: string[] })?.schemas ?? [];
        for (const s of schemas) {
          if (!allSchemas.includes(s)) allSchemas.push(s);
        }
      }
    } catch { /* server unreachable — skip */ }
  }

  allSchemas.sort();
  return allSchemas;
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface DbServerValidation {
  serverId: string;
  serverName: string;
  supported: DbCapability[];
  missing: DbCapability[];
  compliant: boolean;
}

/**
 * Validate whether a DB MCP server implements the required interface.
 * Returns which capabilities are present / missing.
 */
export async function validateDbServer(serverId: string, serverName?: string): Promise<DbServerValidation> {
  const caps = await resolveDbCapabilities(serverId);
  const supported = [...caps.keys()];
  const missing = REQUIRED_DB_CAPABILITIES.filter(c => !caps.has(c));
  return {
    serverId,
    serverName: serverName ?? serverId,
    supported,
    missing,
    compliant: missing.length === 0,
  };
}
