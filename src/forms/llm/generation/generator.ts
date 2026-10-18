import * as vscode from "vscode";
import * as path from "path";
import { hasDangerPatterns } from "../prompts/prompt-template";
import { verifyHasElseBranch } from "./verify-rules";
import { getResolvedPrompt, getResolvedUserPrompt } from '../../../storage/prompt-library';
import type { CustomLlmClient } from "../../../services/llm/adapters/types";
import { buildMcpToolsPrompt, executeMcpToolCalls, buildMcpResultsPrompt, type McpScope } from "../../../services/mcp/agent/mcp-agent";
import { buildAgentPoolPrompt } from "../../../services/agent-pool";
import { buildLiveSchemaContext, type LiveDb } from "./live-schema-context";
import { previousDefinitionsFor, exactRevertFromPrevious, pinPreviousDefinitions, replacedObjects, sourceLabel, type PreviousDefinition } from "./previous-definition";
import { runSelfCheck, type SelfCheckResult } from "./self-check";
import { lintDeploySql, type LintFinding } from "../../../services/lint/lock-lint";
import { findDuplicates, type Duplicate } from "../../../services/conflicts/duplicates";
import { cfgEnvSchemas } from "../../../services/mcp/server/env-servers";

export type DmcrGeneratedChange = {
  changeName: string; // slug only, e.g. "add_email_to_customer"
  deploySql: string;
  verifySql: string;
  revertSql: string;
  metaJson?: string;
  /** Result of running the change for real (rolled back) before it is shown; see self-check.ts */
  selfCheck?: SelfCheckResult & { rounds: number; fixed?: string[]; repairNote?: string; lint?: LintFinding[]; duplicates?: Duplicate[]; previous?: PreviousNote[] };
};

export async function loadDmcrContextText(
  wsFolder: vscode.WorkspaceFolder
): Promise<string> {
  const candidates = ["dmcr.ps1", "dmcr.cfg", "dmcr_change_log_ddl.sql"].map(p =>
    vscode.Uri.file(path.join(wsFolder.uri.fsPath, p))
  );

  const parts: string[] = [];
  for (const uri of candidates) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      parts.push(`FILE: ${path.basename(uri.fsPath)}\n-----\n${text}\n-----\n`);
    } catch {
      // ignore missing
    }
  }

  return parts.length ? parts.join("\n") : "No dmcr.* files found at workspace root.";
}

/**
 * The one database the AI reads while generating: the generation environment's DB server
 * (shop-test for test). The other environments' servers (prod) are neither offered nor called.
 */
export async function generationMcpScope(): Promise<McpScope> {
  try {
    const { generationEnv } = await import('../../../services/schema/env-schema.js');
    const { dbServerForEnv } = await import('../../../services/mcp/agent/mcp-db-agent.js');
    const envName = generationEnv();
    return { dbServerId: dbServerForEnv(envName)?.id, envName };
  } catch { return {}; }
}

/** A self-check message as the card shows it: names without the environment's schema (zp_st.orders -> orders). */
async function withoutEnvSchema(text: string, env?: string): Promise<string> {
  try {
    const { cfgEnvSchemas } = await import('../../../services/mcp/server/env-servers.js');
    const { stripSchema } = await import('../../../services/schema/placeholders.js');
    const envSchema = env ? cfgEnvSchemas()[env] : undefined;
    return envSchema ? stripSchema(text, envSchema) : text;
  } catch { return text; }
}

/** Real schema names a request may qualify with: every environment's schema (DMCR Config), the default one, public. */
function knownSchemas(defaultSchema: string): string[] {
  try {
    return [...new Set([defaultSchema, 'public', ...Object.values(cfgEnvSchemas())].filter(Boolean))];
  } catch { return [defaultSchema || 'public', 'public']; }
}

/** Saved changes that already add what deploySql adds (column, table, type, sequence). */
async function savedDuplicates(deploySql: string): Promise<Duplicate[]> {
  try {
    const dir = await generationChangesDir();
    if (!dir) return [];
    const { loadChangeInputs } = await import('../../../panel/main/handlers/conflict-handlers.js');
    return findDuplicates(deploySql, loadChangeInputs(dir).map(c => ({ id: c.id, project: c.project, deploySql: c.deploySql })));
  } catch { return []; }
}

/** The workspace's changes folder, or null. */
async function generationChangesDir(): Promise<string | null> {
  try { const { resolveChangesDir } = await import('../../../storage/changes-dir.js'); return resolveChangesDir() || null; } catch { return null; }
}

/** The generation environment's database through its DB MCP server (discover_objects + get_ddl), or null. */
async function generationLiveDb(): Promise<LiveDb | null> {
  try {
    const { callDbCapability, dbServerForEnv } = await import('../../../services/mcp/agent/mcp-db-agent.js');
    const { generationEnv } = await import('../../../services/schema/env-schema.js');
    const srv = dbServerForEnv(generationEnv());
    if (!srv) return null;
    const withTimeout = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000))]);
    return {
      label: srv.name || srv.id,
      async objects(schema) {
        const r = await withTimeout(callDbCapability('discover_objects', { schema }, srv.id));
        if (!r.success) return null;
        const list = (r.data as { objects?: Array<{ name: string; type: string }> })?.objects ?? [];
        return new Map(list.map(o => [o.name.toLowerCase(), o.type]));
      },
      async ddl(schema, name, type) {
        const r = await withTimeout(callDbCapability('get_ddl', { schema, name, object_type: type }, srv.id));
        if (!r.success) return '';
        const d = r.data as { ddl?: string; definition?: string; sql?: string } | string | null;
        if (typeof d === 'string') { try { const j = JSON.parse(d); return String(j?.ddl ?? d); } catch { return d; } }
        return d?.ddl || d?.definition || d?.sql || '';
      },
    };
  } catch { return null; }
}

/**
 * The previous definition of every function / procedure / view `deploySql` replaces, found by DMCR:
 * the newest change in the repository that defines it, else the live test database through MCP
 * (see previous-definition.ts). Used by every generation (Freeform, DDL, DML, the Assistant) and by
 * Freeform to fill Previous version.
 */
export async function lookupPreviousDefinitions(deploySql: string, inText = false): Promise<PreviousDefinition[]> {
  try {
    const { generationSchema } = await import('../../../services/schema/env-schema.js');
    const { stripSchema } = await import('../../../services/schema/placeholders.js');
    const envSchema = generationSchema();
    const prev = await previousDefinitionsFor(deploySql, {
      changesDir: await generationChangesDir(),
      live: await generationLiveDb(),
      envSchema,
      // changes are written without a schema: the live definition loses its zp_st. prefix
      toPlaceholder: (s: string) => stripSchema(s, envSchema),
      inText,
    });
    if (prev.length) console.log(`[dmcr-gen] previous definitions: ${prev.map(p => `${p.object.display} from ${sourceLabel(p.source)}`).join('; ')}`);
    return prev;
  } catch (e) {
    console.log(`[dmcr-gen] previous definitions not looked up: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Real definitions of the objects the request names: live DDL from the DB MCP server (the test
 * environment's server when there are several) plus the repository changes that create or alter them.
 */
export async function liveSchemaContextFor(userRequest: string, onChunk?: (partial: string) => void): Promise<string> {
  try {
    // names without a schema (or an old ${schema}) are the test environment's schema while looking objects up (zp_st);
    // what the model reads has no schema at all, so it writes plain names
    const { generationSchema } = await import('../../../services/schema/env-schema.js');
    const { resolvePlaceholders, stripSchema } = await import('../../../services/schema/placeholders.js');
    const envSchema = generationSchema();
    userRequest = resolvePlaceholders(userRequest, { schema: envSchema });
    const defaultSchema = /(?:Schema context|Default schema):\s*([A-Za-z_][\w]*)/i.exec(userRequest)?.[1] ?? envSchema ?? 'public';
    const changesDir = await generationChangesDir();
    const live = await generationLiveDb();
    onChunk?.('Reading the definitions of the objects you named…');
    const { track } = await import('../../../services/activity.js');
    const raw = await track('step', 'Reading the objects you named', `${live?.label ?? 'no DB MCP server'} · repository changes`,
      () => buildLiveSchemaContext(userRequest, defaultSchema, changesDir, live, { schema: envSchema }, knownSchemas(defaultSchema)), v => `${v.length.toLocaleString()} chars of definitions`);
    let ctx = stripSchema(raw, envSchema);
    // SQL in the request that replaces a function / procedure / view: its previous definition, which revert.sql restores
    const prev = (await track('repo', 'Previous definitions', 'newest change in the repository, else the live database', () => lookupPreviousDefinitions(userRequest, true),
      v => { const f = v.filter(p => p.sql); return f.length ? f.map(p => `${p.object.display} from ${sourceLabel(p.source)}`).join(' · ') : 'nothing it replaces'; })).filter(p => p.sql);
    if (prev.length) {
      ctx += `\n\nPREVIOUS DEFINITIONS (what the objects this change replaces look like now; DMCR writes revert.sql from these word for word, so do not re-type them):\n`
        + prev.map(p => `-- ${p.object.display} (from ${sourceLabel(p.source)})\n${p.sql}`).join('\n\n');
    }
    console.log(`[dmcr-gen] object definitions for the prompt: ${ctx.length} chars (live: ${live?.label ?? 'no DB MCP server'}, changes: ${changesDir ?? 'none'})`);
    return ctx;
  } catch {
    return '';
  }
}

/** @deprecated Use getResolvedPrompt('DMCR_RULES') from prompt-library instead. */
export { dmcrRulesSystemPrompt as dmcrRulesPrompt } from "../prompts/prompt-template";

export async function generateDmcrChangeWithCopilot(
  userRequest: string,
  dmcrContext: string,
  token: vscode.CancellationToken,
  onChunk?: (partial: string) => void,
  family?: string,
  onToken?: (delta: string) => void,
  opts: GenerateOpts = {}
): Promise<DmcrGeneratedChange> {
  const filter: { vendor: string; family?: string } = { vendor: "copilot" };
  if (family) filter.family = family;
  const models = await vscode.lm.selectChatModels(filter);
  const model = models?.[0];
  if (!model) {
    throw new Error(
      "No Copilot chat model available. Ensure GitHub Copilot Chat is installed and enabled."
    );
  }

  // Discover MCP tools dynamically (empty string if no MCP servers configured)
  let mcpToolsPrompt = '';
  const scope = await generationMcpScope();
  try { mcpToolsPrompt = await buildMcpToolsPrompt(scope); } catch { /* no MCP */ }

  const agentPoolPrompt = buildAgentPoolPrompt();
  dmcrContext += await liveSchemaContextFor(userRequest, onChunk);
  const vars = { toolList: mcpToolsPrompt, agentPool: agentPoolPrompt, dmcrContext, userRequest };
  const systemPrompt = getResolvedPrompt('DMCR_RULES', vars);
  const userPromptText = getResolvedUserPrompt('DMCR_RULES', vars);

  const baseMessages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.Assistant(systemPrompt),
    vscode.LanguageModelChatMessage.User(userPromptText),
  ];

  // Attempt 1
  const { trackAi } = await import('../../../services/activity.js');
  const out1 = await trackAi('writing the change', async tick => concatResponse(
    await model.sendRequest(baseMessages, { modelOptions: { temperature: 0.2 } }, token), onChunk, d => { onToken?.(d); tick(d); }));

  let parsed = tryParseGenerated(out1);

  // Check if agent requested MCP tool calls before generating SQL
  if (!parsed && mcpToolsPrompt) {
    const toolCalls = tryParseMcpToolCalls(out1);
    if (toolCalls.length > 0) {
      onChunk?.('Calling MCP tools: ' + toolCalls.map(t => t.tool).join(', ') + '…');
      const toolResults = await executeMcpToolCalls(toolCalls, 'dmcr-gen-copilot', scope);
      const resultsPrompt = buildMcpResultsPrompt(toolResults);

      // Re-generate with tool results injected
      const messagesWithResults: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.Assistant(systemPrompt),
        vscode.LanguageModelChatMessage.User(
          `${userPromptText}\n${resultsPrompt}\n\nNow generate the DMCR change JSON using the tool results above. Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.`
        ),
      ];
      const out1b = await trackAi('writing the change with the MCP results', async tick => concatResponse(
        await model.sendRequest(messagesWithResults, { modelOptions: { temperature: 0.2 } }, token), onChunk, d => { onToken?.(d); tick(d); }));
      parsed = tryParseGenerated(out1b);
    }
  }

  // Attempt 2 (repair)
  if (!parsed) {
    const repairMessages: vscode.LanguageModelChatMessage[] = [
      ...baseMessages,
      vscode.LanguageModelChatMessage.Assistant(
        [
          "Your previous response was NOT valid JSON.",
          "Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.",
          "No markdown. No commentary. No leading/trailing text.",
          "",
          "Previous (invalid) output:",
          out1.length > 4000 ? out1.slice(0, 4000) + "\n...[truncated]..." : out1,
        ].join("\n")
      ),
    ];

    const resp2 = await model.sendRequest(
      repairMessages,
      { modelOptions: { temperature: 0 } },
      token
    );
    const out2 = await concatResponse(resp2, undefined, onToken);

    parsed = tryParseGenerated(out2);

    if (!parsed) {
      throw new Error("DMCR_NOT_SQL_REQUEST");
    }
  }

  // Auto-heal verify.sql if model forgot dmcr.change_log (common for DML)
  parsed.verifySql = ensureVerifyHasDmcrGuard(parsed.verifySql, parsed.deploySql);

  const regenerate = async (fixText: string) => {
    const resp3 = await model.sendRequest(
      [...baseMessages, vscode.LanguageModelChatMessage.User(fixText)],
      { modelOptions: { temperature: 0 } },
      token
    );
    return concatResponse(resp3, undefined, onToken);
  };
  return selfCheckAndRepair(await validateOrCorrect(parsed, regenerate), regenerate, onChunk, opts);
}

/**
 * Generate a DMCR change using a custom HTTP LLM provider (OpenAI/Anthropic/etc).
 * Mirrors generateDmcrChangeWithCopilot logic but uses CustomLlmClient.
 */
export async function generateDmcrChangeWithCustomClient(
  client: CustomLlmClient,
  model: string,
  userRequest: string,
  dmcrContext: string,
  onChunk?: (partial: string) => void,
  onToken?: (delta: string) => void,
  opts: GenerateOpts = {}
): Promise<DmcrGeneratedChange> {
  // Discover MCP tools dynamically
  let mcpToolsPrompt = '';
  const scope = await generationMcpScope();
  try { mcpToolsPrompt = await buildMcpToolsPrompt(scope); } catch { /* no MCP */ }

  const agentPoolPrompt2 = buildAgentPoolPrompt();
  dmcrContext += await liveSchemaContextFor(userRequest, onChunk);
  const vars2 = { toolList: mcpToolsPrompt, agentPool: agentPoolPrompt2, dmcrContext, userRequest };
  const hint = getResolvedPrompt('DMCR_RULES', vars2);
  const context = getResolvedUserPrompt('DMCR_RULES', vars2);

  // Use streaming if the adapter supports it and a token callback was provided
  const { trackAi } = await import('../../../services/activity.js');
  const out1 = await trackAi('writing the change', tick => (client.stream && onToken)
    ? client.stream(hint, context, model, d => { onToken(d); tick(d); }, 0.2)
    : client.generateText(hint, context, model, 0.2));
  onChunk?.(out1);

  let parsed = tryParseGenerated(out1);

  // Check if agent requested MCP tool calls
  if (!parsed && mcpToolsPrompt) {
    const toolCalls = tryParseMcpToolCalls(out1);
    if (toolCalls.length > 0) {
      onChunk?.('Calling MCP tools: ' + toolCalls.map(t => t.tool).join(', ') + '…');
      const toolResults = await executeMcpToolCalls(toolCalls, 'dmcr-gen-custom', scope);
      const resultsPrompt = buildMcpResultsPrompt(toolResults);
      const contextWithResults = `${context}\n${resultsPrompt}\n\nNow generate the DMCR change JSON using the tool results above. Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.`;
      const out1b = await trackAi('writing the change with the MCP results', () => client.generateText(hint, contextWithResults, model, 0.2));
      onChunk?.(out1b);
      parsed = tryParseGenerated(out1b);
    }
  }

  if (!parsed) {
    const repairHint = [
      hint,
      "",
      "Your previous response was NOT valid JSON.",
      "Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.",
      "No markdown fences. No commentary. No leading/trailing text.",
      "",
      "Previous (invalid) output:",
      out1.length > 4000 ? out1.slice(0, 4000) + "\n...[truncated]..." : out1,
    ].join("\n");
    const out2 = await trackAi('asked again: the answer was not valid JSON', () => client.generateText(repairHint, context, model, 0));
    onChunk?.(out2);
    parsed = tryParseGenerated(out2);
    if (!parsed) throw new Error("DMCR_NOT_SQL_REQUEST");
  }

  parsed.verifySql = ensureVerifyHasDmcrGuard(parsed.verifySql, parsed.deploySql);
  const regenerate = (fixText: string) => trackAi('fixing what PostgreSQL rejected', () => client.generateText(hint, `${context}\n\n${fixText}`, model, 0));
  return selfCheckAndRepair(await validateOrCorrect(parsed, regenerate), regenerate, onChunk, opts);
}

/** changeName with the danger_ prefix exactly when deploy.sql has a danger pattern (R__ names are left alone). */
function dangerName(name: string, deploySql: string): string {
  if (/^R__/i.test(name)) return name;
  const bare = name.replace(/^danger_/i, '');
  return hasDangerPatterns(deploySql) ? `danger_${bare}` : bare;
}

/**
 * Options for a generation. exactRevert: revert.sql DMCR already knows exactly (Freeform's Previous version);
 * it replaces the model's in every round. exactRevertFrom: where that previous definition came from, for the card.
 */
export interface GenerateOpts { exactRevert?: string; exactRevertFrom?: string }

/** How the revert of a replaced function / procedure / view was made, shown on the card. */
export type PreviousNote = { object: string; from: string; how: 'exact' | 'pinned' | 'new' };

/** Fix rounds after a failed self-check (each one is a model call plus a test run). */
const MAX_REPAIRS = 2;

/**
 * Run the change for real (rolled back) before it is shown. When PostgreSQL rejects it, hand the
 * exact error back to the model and test the corrected version, up to MAX_REPAIRS times. The card
 * shows the outcome, including which errors were fixed on the way.
 */
async function selfCheckAndRepair(
  change: DmcrGeneratedChange,
  regenerate: (fixText: string) => Promise<string>,
  onChunk?: (partial: string) => void,
  opts: GenerateOpts = {},
): Promise<DmcrGeneratedChange> {
  let cur = change;
  const fixed: string[] = [];
  // previous definitions of what deploy.sql replaces, looked up once per deploy.sql
  const prevCache = new Map<string, PreviousDefinition[]>();
  let previous: PreviousNote[] | undefined;
  let prevForFix: PreviousDefinition[] = [];
  for (let round = 0; ; round++) {
    // A revert DMCR knows exactly is not left to the model: Freeform's Previous version, else the previous
    // definitions DMCR finds itself (newest change in the repository, else the live test database via MCP)
    if (opts.exactRevert) {
      cur.revertSql = opts.exactRevert;
      previous = [{ object: replacedObjects(cur.deploySql)[0]?.display ?? 'the replaced routine', from: opts.exactRevertFrom || 'Previous version', how: 'exact' }];
    } else {
      if (!prevCache.has(cur.deploySql)) {
        const { track } = await import('../../../services/activity.js');
        prevCache.set(cur.deploySql, await track('repo', 'Previous definition for revert.sql', 'repository, else the live database (MCP)', () => lookupPreviousDefinitions(cur.deploySql),
          v => { const f = v.filter(p => p.sql); return f.length ? f.map(p => `${p.object.display} from ${sourceLabel(p.source)}`).join(' · ') : 'nothing replaced: no previous definition needed'; }));
      }
      const prev = prevCache.get(cur.deploySql)!;
      prevForFix = prev.filter(p => p.sql);
      const exact = exactRevertFromPrevious(cur.deploySql, prev);
      if (exact) cur.revertSql = exact;
      else cur.revertSql = pinPreviousDefinitions(cur.revertSql, prev);
      previous = prev.length ? prev.map(p => ({ object: p.object.display, from: sourceLabel(p.source), how: !p.sql ? 'new' as const : exact ? 'exact' as const : 'pinned' as const })) : undefined;
      if (exact) prevForFix = [];
    }
    // danger_ follows what deploy.sql contains now: a draft named danger_ (say, for DROP TABLE)
    // whose fix no longer drops anything loses the prefix, and the other way round
    cur.changeName = dangerName(cur.changeName, cur.deploySql);
    onChunk?.(round === 0
      ? 'Test-running the change: deploy, verify, revert, verify in a transaction that is rolled back\u2026'
      : `Test-running the corrected change (fix ${round} of ${MAX_REPAIRS})\u2026`);
    const { activityStart } = await import('../../../services/activity.js');
    const hc = activityStart('check', round === 0 ? 'Self-check test run' : `Self-check of fix ${round}`, 'deploy → verify → revert → verify in one transaction, rolled back');
    const r = await runSelfCheck(cur);
    hc.end(r.status !== 'failed', r.status === 'failed' ? `failed: ${(r.error ?? '').split('\n')[0].slice(0, 140)}` : r.status === 'passed' ? 'passed: schema and data restored exactly' : String(r.status));
    // lock / safety lint of the deploy.sql, shown with the self-check (advisory)
    // the same column / table / type / sequence already added by a saved change: one owner only
    const duplicates = await savedDuplicates(cur.deploySql ?? '');
    // its error reads like the SQL too: no environment schema in names
    const shown = { ...r, ...(r.error ? { error: await withoutEnvSchema(r.error, r.env) } : {}) };
    cur.selfCheck = { ...shown, rounds: round, fixed: [...fixed], lint: lintDeploySql(cur.deploySql ?? ''), ...(duplicates.length ? { duplicates } : {}), ...(previous ? { previous } : {}) };
    console.log(`[dmcr-gen] self-check round ${round}: ${r.status}${r.error ? ' - ' + r.error.split('\n')[0] : ''} (${r.ms} ms)`);
    if (r.status !== 'failed' || round >= MAX_REPAIRS) return cur;
    onChunk?.(`PostgreSQL rejected it: ${(r.error ?? '').split('\n')[0]}. Asking the AI to fix that\u2026`);
    const fixText = [
      'Your change was executed on a real PostgreSQL database (deploy.sql, verify.sql, revert.sql, verify.sql, inside a transaction that was rolled back) and it FAILED:',
      r.error ?? '',
      'Fix the SQL so this round trip passes. Keep the intent and everything that was already right; change only what the error requires.',
      ...(/cannot run inside a transaction block/i.test(r.error ?? '') ? ['The statement cannot run in a transaction (e.g. CREATE INDEX CONCURRENTLY). Keep it, and set "transaction": false in metaJson; deploy.sql must stay re-runnable (CREATE INDEX CONCURRENTLY IF NOT EXISTS) and revert.sql must use DROP INDEX CONCURRENTLY IF EXISTS. Index names are never schema-qualified in CREATE INDEX.'] : []),
      ...(prevForFix.length ? [
        'revert.sql must put back these previous definitions WORD FOR WORD (DMCR read them from the repository / the live database; copy each one unchanged):',
        ...prevForFix.map(p => `-- previous ${p.object.display} (from ${sourceLabel(p.source)})\n${p.sql}`),
      ] : []),
      'revert.sql must bring the database back EXACTLY to the state before deploy.sql. When PostgreSQL cannot undo something directly (an enum value cannot be dropped, a column type cannot always be cast back), revert.sql must rebuild the object to its exact previous definition (for an enum: create the old type under a new name, move every column that uses it, restore their defaults, drop the new type, rename) and stop with a clear error if existing data would be lost. A no-op revert is never acceptable.',
      'Return the whole change again as ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql, metaJson.',
      '',
      'Previous change:',
      JSON.stringify({ changeName: cur.changeName, deploySql: cur.deploySql, verifySql: cur.verifySql, revertSql: cur.revertSql, metaJson: cur.metaJson }).slice(0, 14000),
    ].join('\n');
    let next: DmcrGeneratedChange | null = null;
    let why = '';
    try {
      let raw = await regenerate(fixText);
      // The model may first ask to look things up (e.g. which columns use an enum): run those
      // MCP calls and ask again with the results, as first-time generation does.
      const toolCalls = tryParseGenerated(raw) ? [] : tryParseMcpToolCalls(raw);
      if (toolCalls.length > 0) {
        onChunk?.('Looking up what the fix needs through MCP: ' + toolCalls.map(t => t.tool).join(', ') + '…');
        const results = buildMcpResultsPrompt(await executeMcpToolCalls(toolCalls, 'dmcr-selfcheck-fix', await generationMcpScope()));
        raw = await regenerate(`${fixText}\n${results}\n\nNow return the fixed change as ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql, metaJson.`);
      }
      next = tryParseGenerated(raw);
      if (!next) {
        why = 'the AI did not return a valid change';
        console.log(`[dmcr-gen] unusable fix reply (${raw.length} chars): ${raw.slice(0, 300).replace(/\s+/g, ' ')} ... ${raw.slice(-300).replace(/\s+/g, ' ')}`);
      }
      else {
        next.verifySql = ensureVerifyHasDmcrGuard(next.verifySql, next.deploySql);
        validateGenerated(next);
      }
    } catch (e) { why = `the AI's fix broke a DMCR rule: ${e instanceof Error ? e.message : String(e)}`; next = null; }
    if (!next) {
      // show the tested version and its error, and say why the fix was not used
      console.log(`[dmcr-gen] self-check fix ${round + 1} not used: ${why}`);
      cur.selfCheck = { ...cur.selfCheck!, repairNote: `A fix was attempted, but ${why}.` };
      return cur;
    }
    next.changeName = cur.changeName;
    next.metaJson = next.metaJson ?? cur.metaJson;
    // shown on the card without the environment's schema (zp_st.orders -> orders), like the SQL
    const note = await withoutEnvSchema((r.error ?? '').split('\n')[0], r.env);
    fixed.push(note);
    cur = next;
  }
}

/**
 * Validate a generated change; if it breaks a DMCR rule, give the model one chance to fix
 * exactly that (temperature 0) before failing. Without this, a rule like "no ELSE in verify.sql"
 * could fail the same request every time.
 */
async function validateOrCorrect(
  parsed: DmcrGeneratedChange,
  regenerate: (fixText: string) => Promise<string>,
): Promise<DmcrGeneratedChange> {
  try {
    validateGenerated(parsed);
    return parsed;
  } catch (err) {
    const rule = err instanceof Error ? err.message : String(err);
    const guidance = /ELSE/.test(rule)
      ? "In verify.sql use two independent blocks and no ELSE branch: IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN <applied checks> END IF; IF NOT EXISTS (same query) THEN <reverted checks> END IF; (CASE expressions are fine)."
      : /changeName/.test(rule)
        ? "changeName must be lowercase snake_case (letters, digits, underscores)."
        : "Fix only what the rule requires.";
    const fixText = [
      `Your previous change broke a DMCR rule: ${rule}.`,
      guidance,
      "Return the same change again as ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql, metaJson — change nothing except what the rule requires.",
      "",
      "Previous change:",
      JSON.stringify(parsed).slice(0, 12000),
    ].join("\n");
    const out = await regenerate(fixText);
    const fixed = tryParseGenerated(out);
    if (!fixed) { throw err; }
    fixed.verifySql = ensureVerifyHasDmcrGuard(fixed.verifySql, fixed.deploySql);
    validateGenerated(fixed); // still broken → the original rule's message reaches the user
    return fixed;
  }
}

async function concatResponse(
  resp: vscode.LanguageModelChatResponse,
  onChunk?: (partial: string) => void,
  onToken?: (delta: string) => void
): Promise<string> {
  let out = "";
  for await (const part of resp.text) {
    out += part;
    onToken?.(part);
    onChunk?.(out);
  }
  return out.trim();
}

function extractJsonObject(text: string): string {
  let t = text.trim();
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  t = t.replace(/```$/i, "").trim();

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}

function tryParseGenerated(text: string): DmcrGeneratedChange | null {
  try {
    const jsonText = extractJsonObject(text);
    const obj = JSON.parse(jsonText) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const x = obj as Record<string, unknown>;
    // Require all four fields to be non-empty strings — if any is missing the
    // model hasn't produced a real DMCR change (e.g. it responded conversationally).
    for (const k of ["changeName", "deploySql", "verifySql", "revertSql"] as const) {
      if (typeof x[k] !== "string" || !(x[k] as string).trim()) return null;
    }
    return x as unknown as DmcrGeneratedChange;
  } catch {
    return null;
  }
}

/**
 * Try to extract mcpToolCalls from an LLM response that isn't a valid DMCR change.
 * The agent may respond with: { "mcpToolCalls": [{ "tool": "...", "args": {...} }] }
 */
function tryParseMcpToolCalls(text: string): Array<{ tool: string; args?: Record<string, unknown> }> {
  try {
    const jsonText = extractJsonObject(text);
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    if (Array.isArray(obj.mcpToolCalls)) {
      return obj.mcpToolCalls.filter(
        (c: unknown) => c && typeof c === 'object' && typeof (c as Record<string, unknown>).tool === 'string'
      ) as Array<{ tool: string; args?: Record<string, unknown> }>;
    }
  } catch { /* not parseable */ }
  return [];
}

function detectPrimaryTableFqn(sql: string): string | undefined {
  if (!sql || typeof sql !== "string") return undefined;
  // the table the change works on, with or without a schema prefix (changes are written without one)
  const m =
    sql.match(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:(?:\$\{schema\}|[a-z_][a-z0-9_]*)\.)?[a-z_][a-z0-9_]*)\b/i) ??
    sql.match(/\bINSERT\s+INTO\s+((?:(?:\$\{schema\}|[a-z_][a-z0-9_]*)\.)?[a-z_][a-z0-9_]*)\b/i) ??
    sql.match(/\bUPDATE\s+(?:ONLY\s+)?((?:(?:\$\{schema\}|[a-z_][a-z0-9_]*)\.)?[a-z_][a-z0-9_]*)\b/i) ??
    sql.match(/\bDELETE\s+FROM\s+(?:ONLY\s+)?((?:(?:\$\{schema\}|[a-z_][a-z0-9_]*)\.)?[a-z_][a-z0-9_]*)\b/i) ??
    sql.match(/\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:(?:\$\{schema\}|[a-z_][a-z0-9_]*)\.)?[a-z_][a-z0-9_]*)\b/i);
  if (!m || /^dmcr\./i.test(m[1])) return undefined;
  // no schema in what DMCR writes: drop any prefix (to_regclass then uses the environment's schema)
  return m[1].replace(/^(?:\$\{schema\}|[a-z_][a-z0-9_]*)\./i, "");
}

function ensureVerifyHasDmcrGuard(verifySql: string, deploySql: string): string {
  // dmcr.repeatable_log is the gate for repeatable (R__) changes
  const hasChangeLog = /dmcr\s*\.\s*(change_log|repeatable_log)/i.test(verifySql);
  const hasPlaceholder = /__DMCR_CHANGE_ID__/.test(verifySql);

  if (hasChangeLog && hasPlaceholder) {
    return verifySql;
  }

  const tableFqn = detectPrimaryTableFqn(deploySql);
  const tableLiteral = tableFqn ? `${tableFqn}` : "your_table_here";

  // Replace with a DMCR-safe verify template
  return [
    "-- DMCR verify (auto-healed): enforce dmcr.change_log guard",
    "DO $$",
    "DECLARE",
    "  _t regclass;",
    "BEGIN",
    "  IF EXISTS (",
    "    SELECT 1",
    "    FROM dmcr.change_log",
    "    WHERE change_id = '__DMCR_CHANGE_ID__'",
    "  ) THEN",
    `    _t := to_regclass('${tableLiteral}');`,
    "    IF _t IS NULL THEN",
    `      RAISE EXCEPTION 'Invariant failed: expected table % to exist when change is applied.', '${tableLiteral}';`,
    "    END IF;",
    "  END IF;",
    "END $$;",
    "",
  ].join("\n");
}

function validateGenerated(x: DmcrGeneratedChange) {
  if (!x || typeof x !== "object") {
    throw new Error("Model output was not an object.");
  }
  for (const k of ["changeName", "deploySql", "verifySql", "revertSql"] as const) {
    if (typeof (x as any)[k] !== "string" || !(x as any)[k].trim()) {
      throw new Error(`Model output missing/invalid: ${k}`);
    }
  }
  // R__ prefix: a repeatable change (Freeform → "repeatable")
  if (!/^(R__)?[a-z0-9]+(_[a-z0-9]+)*$/.test(x.changeName.trim())) {
    throw new Error(`Invalid changeName slug: ${x.changeName}`);
  }
  if (!x.verifySql.includes("dmcr.change_log") && !x.verifySql.includes("dmcr.repeatable_log")) {
    throw new Error(
      "verify.sql must reference dmcr.change_log to be DMCR-safe (must work after deploy and revert)"
    );
  }
  if (!x.verifySql.includes("__DMCR_CHANGE_ID__")) {
    throw new Error("verify.sql must reference __DMCR_CHANGE_ID__");
  }
  if (verifyHasElseBranch(x.verifySql)) {
    throw new Error("verify.sql must not assert reverted or negative state using ELSE blocks");
  }
}