/**
 * Agent Pool — centralized registry of callable AI agents.
 *
 * Architecture mirrors MCP tool discovery:
 *   - buildAgentPoolPrompt() → describes available agents to the calling agent
 *   - executeAgentCall()     → dispatches to the requested agent and returns result
 *
 * Usage in prompts:
 *   {{agentPool}} — injected into agents that can delegate to other agents
 *   LLM responds with "agentPoolCall": { "agent": "<AGENT_ID>", "params": { ... } }
 *
 * Registered agents:
 *   - SQL_REFINE:      Modifies previously generated DMCR change SQL
 *   - WIKI:            Searches DMCR documentation and answers documentation questions
 *   - SQL_FAQ:         Answers SQL/schema/database questions
 *   - GENERAL_FAQ:     Answers general DMCR feature/workflow questions
 *   - GIT_COMMIT:      Generates git commit messages for DMCR changes
 *   - FREEFORM_SQL:    Wraps raw SQL into a full DMCR change (deploy/verify/revert/meta)
 *   - SCHEMA_DIFF:     Generates migration SQL from two schema states
 *   - DMCR_GENERATE:   Core SQL generation engine (full DMCR change from natural language)
 *   - ADD_COLUMNS:     DDL builder (ALTER TABLE, CREATE TABLE, sequences, grants)
 *   - INSERT_ROWS:     DML builder (INSERT statements with optional idempotency)
 *   - INTENT_DETECTOR: Classifies user requests into DMCR intents
 *   - REQUEST_PLANNER: Decides whether to generate immediately or ask clarifications
 *   - FOLLOWUP_DECIDER: Interprets user replies to follow-up questions
 *   - MASTER_AGENT:    Routes user messages to the correct agent
 *   - GREETING_AGENT:  Handles greetings and redirects to DMCR capabilities
 *   - MCP_AGENT:       Orchestrates MCP tool calls for live schema access
 *   - DIALOGUE_INTENT: Resolves follow-up questions into standalone queries
 */

import { callActiveLlm } from './llm/core/llm-client';
import { getResolvedPrompt, getResolvedUserPrompt } from '../storage/prompt-library';
import { getConversationSql, insertAudit } from '../storage/db';
import { searchWiki } from '../forms/llm/generation/wiki-search';

// ── Agent Registry ───────────────────────────────────────────────────────────

export interface AgentPoolEntry {
  id: string;
  name: string;
  description: string;
  params: { name: string; description: string; required: boolean }[];
  /** Whether this agent requires prior SQL in the conversation to be useful */
  requiresPriorSql?: boolean;
}

/** All agent IDs registered in the pool — exported for UI (chip display). */
export const AGENT_POOL_IDS: string[] = [
  'SQL_REFINE', 'WIKI', 'SQL_FAQ', 'GENERAL_FAQ', 'GIT_COMMIT', 'FREEFORM_SQL', 'SCHEMA_DIFF',
  'DMCR_GENERATE', 'ADD_COLUMNS', 'INSERT_ROWS', 'INTENT_DETECTOR', 'REQUEST_PLANNER',
  'FOLLOWUP_DECIDER', 'MASTER_AGENT', 'GREETING_AGENT', 'MCP_AGENT', 'DIALOGUE_INTENT',
];

/** Map agent pool IDs → PromptScenario for UI chip matching */
export const AGENT_POOL_SCENARIO_MAP: Record<string, string> = {
  SQL_REFINE:       'SQL_REFINE_AGENT',
  WIKI:             'WIKI_AGENT',
  SQL_FAQ:          'SQL_FAQ_AGENT',
  GENERAL_FAQ:      'GENERAL_FAQ_AGENT',
  GIT_COMMIT:       'GIT_COMMIT_MESSAGE',
  FREEFORM_SQL:     'FREEFORM_SQL',
  SCHEMA_DIFF:      'SCHEMA_DIFF',
  DMCR_GENERATE:    'DMCR_RULES',
  ADD_COLUMNS:      'ADD_COLUMNS',
  INSERT_ROWS:      'INSERT_ROWS',
  INTENT_DETECTOR:  'INTENT_DETECTOR',
  REQUEST_PLANNER:  'REQUEST_PLANNER',
  FOLLOWUP_DECIDER: 'FOLLOWUP_DECIDER',
  MASTER_AGENT:     'MASTER_AGENT',
  GREETING_AGENT:   'GREETING_AGENT',
  MCP_AGENT:        'MCP_AGENT',
  DIALOGUE_INTENT:  'DIALOGUE_INTENT',
};

/** Reverse: PromptScenario → agent pool ID (for UI chip) */
export const SCENARIO_TO_POOL_ID: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_POOL_SCENARIO_MAP).map(([k, v]) => [v, k])
);

const AGENT_REGISTRY: AgentPoolEntry[] = [
  {
    id: 'SQL_REFINE',
    name: 'SQL Refine Agent',
    description: 'Modifies previously generated DMCR change SQL based on a follow-up modification request. Use when the user wants to ALTER, FIX, ADD TO, or CHANGE existing generated SQL — not for new generation.',
    params: [
      { name: 'userMessage', description: 'The modification/refinement request from the user', required: true },
      { name: 'conversationId', description: 'The conversation ID to look up prior SQL from', required: false },
    ],
    requiresPriorSql: true,
  },
  {
    id: 'WIKI',
    name: 'Wiki Agent',
    description: 'Searches DMCR documentation (DmcrWiki.md) and answers questions about DMCR features, commands, configuration, and workflows. Use when the user asks "how do I…", "what is…", or needs documentation context.',
    params: [
      { name: 'userMessage', description: 'The documentation question or search query', required: true },
    ],
  },
  {
    id: 'SQL_FAQ',
    name: 'SQL FAQ Agent',
    description: 'Answers database/SQL-related questions with live schema awareness. Can discuss table structures, column types, relationships, indexing, and PostgreSQL best practices.',
    params: [
      { name: 'userMessage', description: 'The SQL or schema question from the user', required: true },
    ],
  },
  {
    id: 'GENERAL_FAQ',
    name: 'General FAQ Agent',
    description: 'Answers general questions about DMCR concepts, features, forms, and workflow. Use for non-SQL, non-documentation questions about how the tool works.',
    params: [
      { name: 'userMessage', description: 'The general question from the user', required: true },
    ],
  },
  {
    id: 'GIT_COMMIT',
    name: 'Git Commit Agent',
    description: 'Generates a conventional commit message for DMCR change folders. Use after generating or refining SQL to produce a commit message.',
    params: [
      { name: 'changeSummary', description: 'Git status/diff summary of the change', required: true },
      { name: 'folderName', description: 'The DMCR change folder name', required: true },
      { name: 'deploySql', description: 'The deploy SQL content', required: true },
      { name: 'branch', description: 'Current git branch name', required: false },
    ],
  },
  {
    id: 'FREEFORM_SQL',
    name: 'Freeform SQL Agent',
    description: 'Takes raw SQL input and wraps it into a full DMCR change package (deploy/verify/revert/meta.json). Use when the user provides raw SQL that needs to be packaged as a proper DMCR change.',
    params: [
      { name: 'sql', description: 'The raw deploy SQL to wrap', required: true },
      { name: 'changeNameHint', description: 'Suggested change folder name', required: false },
      { name: 'dbSchema', description: 'Default schema (e.g. public)', required: false },
    ],
  },
  {
    id: 'SCHEMA_DIFF',
    name: 'Schema Diff Agent',
    description: 'Generates migration SQL (deploy/verify/revert) from two schema states (FROM → TO). Use when the user has a current schema and a target schema and needs the migration path.',
    params: [
      { name: 'fromSchema', description: 'Current/baseline DDL (FROM state)', required: true },
      { name: 'toSchema', description: 'Target DDL (TO state)', required: true },
      { name: 'changeNameHint', description: 'Suggested change folder name', required: false },
    ],
  },
  {
    id: 'DMCR_GENERATE',
    name: 'DMCR Agent',
    description: 'Core SQL generation engine. Generates a full DMCR change (deploy/verify/revert/meta.json) from a natural-language change request. Use for new SQL generation from scratch.',
    params: [
      { name: 'userRequest', description: 'The natural-language change request', required: true },
      { name: 'schemaContext', description: 'Schema qualifier context (e.g. default schema)', required: false },
      { name: 'changeNameContext', description: 'Suggested change folder name', required: false },
    ],
  },
  {
    id: 'ADD_COLUMNS',
    name: 'DDL Builder Agent',
    description: 'Generates DDL statements (ALTER TABLE, CREATE TABLE, CREATE SEQUENCE, GRANT). Use when the user specifies structured table/column changes rather than free-form SQL.',
    params: [
      { name: 'tableAction', description: 'Action type: alter | create | sequence | grant-tables | grant-sequences | create-schema', required: true },
      { name: 'cleanTables', description: 'Array of {table, columns[{name,type}]} definitions (JSON string)', required: true },
      { name: 'changeNameHint', description: 'Suggested change folder name', required: false },
    ],
  },
  {
    id: 'INSERT_ROWS',
    name: 'DML Builder Agent',
    description: 'Generates INSERT statements with optional ON CONFLICT idempotency. Use when the user wants to insert data rows into a specific table.',
    params: [
      { name: 'table', description: 'Target table (schema.table)', required: true },
      { name: 'columns', description: 'Column definitions [{name, type}] (JSON string)', required: true },
      { name: 'rows', description: 'Row data as array of objects (JSON string)', required: true },
      { name: 'idempotent', description: 'Whether to use ON CONFLICT (yes/no)', required: false },
      { name: 'conflictTarget', description: 'Unique key columns for ON CONFLICT', required: false },
      { name: 'conflictAction', description: 'do_nothing | update', required: false },
    ],
  },
  {
    id: 'INTENT_DETECTOR',
    name: 'Intent Detector Agent',
    description: 'Classifies user requests into DMCR intents (ADD_COLUMN, CREATE_TABLE, INSERT_DATA, etc.) and detects risks. Use to determine what kind of change the user is requesting.',
    params: [
      { name: 'userPrompt', description: 'The user\'s raw message/request to classify', required: true },
    ],
  },
  {
    id: 'REQUEST_PLANNER',
    name: 'Request Planner Agent',
    description: 'Decides whether to generate SQL immediately or ask the user clarifying questions first. Use after intent detection to plan the generation approach.',
    params: [
      { name: 'userRequest', description: 'The user\'s raw change request', required: true },
    ],
  },
  {
    id: 'FOLLOWUP_DECIDER',
    name: 'Follow-up Decider Agent',
    description: 'Interprets user replies to follow-up questions and decides the next action. Use after a clarification question has been answered.',
    params: [
      { name: 'originalText', description: 'The original user request', required: true },
      { name: 'followUp', description: 'The follow-up question and options presented', required: true },
      { name: 'userReply', description: 'The user\'s reply to the follow-up', required: true },
      { name: 'intent', description: 'Detected intent and risks from intent detector', required: false },
    ],
  },
  {
    id: 'MASTER_AGENT',
    name: 'Master Agent',
    description: 'Routes user messages to the correct specialized agent (GREETING, FAQ, WIKI, SQL_REFINE, or DMCR generation). Use as the top-level dispatcher.',
    params: [
      { name: 'userMessage', description: 'The user\'s raw message to classify and route', required: true },
    ],
  },
  {
    id: 'GREETING_AGENT',
    name: 'Greeting Agent',
    description: 'Responds warmly to greetings and social messages, then redirects to DMCR capabilities. Use when the user says hello, thanks, or similar.',
    params: [
      { name: 'userMessage', description: 'The greeting/social message from the user', required: true },
    ],
  },
  {
    id: 'MCP_AGENT',
    name: 'MCP Agent',
    description: 'Orchestrates MCP (Model Context Protocol) tool calls for live database schema access. Use when you need real-time schema information from connected databases.',
    params: [
      { name: 'userMessage', description: 'The query or task requiring live schema access', required: true },
      { name: 'toolList', description: 'Available MCP tools (JSON string)', required: false },
    ],
  },
  {
    id: 'DIALOGUE_INTENT',
    name: 'Dialogue Intent Resolver',
    description: 'Pre-processes follow-up questions into standalone questions using conversation history. Resolves pronouns and references so subsequent agents get context-complete queries.',
    params: [
      { name: 'conversationHistory', description: 'Last 5 conversation turns formatted as text', required: true },
      { name: 'userMessage', description: 'The user\'s latest message (may contain pronouns/references)', required: true },
    ],
  },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a prompt fragment listing available agents — mirrors buildMcpToolsPrompt().
 * Injected as {{agentPool}} into agent system prompts.
 */
export function buildAgentPoolPrompt(conversationId?: string): string {
  const available = AGENT_REGISTRY.filter(agent => {
    if (agent.requiresPriorSql && conversationId) {
      const priorSql = getConversationSql(conversationId);
      return !!priorSql;
    }
    if (agent.requiresPriorSql && !conversationId) return false;
    return true;
  });

  if (!available.length) return '';

  const lines: string[] = [
    '',
    'AGENT POOL ACCESS (delegate to specialized agents):',
    'You can delegate tasks to specialized agents in the DMCR agent pool.',
    'To call an agent, include an "agentPoolCall" object in your JSON output:',
    '  "agentPoolCall": { "agent": "<agent_id>", "params": { ... } }',
    '',
    'Available agents:',
  ];

  for (const agent of available) {
    lines.push(`  - ${agent.id}: ${agent.description}`);
    const paramParts = agent.params.map(p => `${p.name}${p.required ? '' : '?'}: ${p.description}`);
    if (paramParts.length) {
      lines.push(`    params: { ${paramParts.join(', ')} }`);
    }
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('- Only call agents listed above.');
  lines.push('- If the user is asking to MODIFY/REFINE existing generated SQL, delegate to SQL_REFINE.');
  lines.push('- For documentation/how-to questions, delegate to WIKI.');
  lines.push('- For SQL/schema questions, delegate to SQL_FAQ.');
  lines.push('- For raw SQL that needs packaging, delegate to FREEFORM_SQL.');
  lines.push('- For schema migration generation, delegate to SCHEMA_DIFF.');
  lines.push('- If you can answer directly without an agent, do so (omit agentPoolCall).');
  lines.push('- You will receive the agent\'s result and can then format your final answer.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build a filtered agent pool prompt for specific agent IDs only.
 * Used by {{agentPool['SQL_REFINE', 'WIKI', ...]}} function-style template syntax.
 *
 * @param agentIds - Array of agent IDs to include (varargs — any number)
 * @param conversationId - Optional conversation ID for conditional availability
 */
export function buildFilteredAgentPoolPrompt(agentIds: string[], conversationId?: string): string {
  const available = AGENT_REGISTRY.filter(agent => {
    if (!agentIds.includes(agent.id)) return false;
    if (agent.requiresPriorSql && conversationId) {
      const priorSql = getConversationSql(conversationId);
      return !!priorSql;
    }
    if (agent.requiresPriorSql && !conversationId) return false;
    return true;
  });

  if (!available.length) return '';

  const lines: string[] = [
    '',
    'AGENT POOL ACCESS (delegate to specialized agents):',
    'You can delegate tasks to specialized agents in the DMCR agent pool.',
    'To call an agent, include an "agentPoolCall" object in your JSON output:',
    '  "agentPoolCall": { "agent": "<agent_id>", "params": { ... } }',
    '',
    'Available agents:',
  ];

  for (const agent of available) {
    lines.push(`  - ${agent.id}: ${agent.description}`);
    const paramParts = agent.params.map(p => `${p.name}${p.required ? '' : '?'}: ${p.description}`);
    if (paramParts.length) {
      lines.push(`    params: { ${paramParts.join(', ')} }`);
    }
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('- Only call agents listed above.');
  lines.push('- If you can answer directly without an agent, do so (omit agentPoolCall).');
  lines.push('- You will receive the agent\'s result and can then format your final answer.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Create an agentPool function resolver for the template engine.
 * Handles {{agentPool['SQL_REFINE', 'WIKI', ...]}} — varargs, any number of IDs.
 */
export function createAgentPoolResolver(conversationId?: string): (args: string[]) => string {
  return (agentIds: string[]) => buildFilteredAgentPoolPrompt(agentIds, conversationId);
}

/**
 * Execute an agent pool call requested by the LLM.
 * Returns the agent's response as a string (JSON or text).
 */
export async function executeAgentPoolCall(
  agentId: string,
  params: Record<string, string>,
  conversationId: string,
  options?: { extensionPath?: string },
): Promise<{ success: boolean; result: string; error?: string }> {
  const agent = AGENT_REGISTRY.find(a => a.id === agentId);
  if (!agent) {
    return { success: false, result: '', error: `Unknown agent: ${agentId}` };
  }

  const t0 = Date.now();

  switch (agentId) {
    case 'SQL_REFINE': {
      const priorSql = getConversationSql(conversationId);
      if (!priorSql) {
        return { success: false, result: '', error: 'No prior SQL found in this conversation for SQL_REFINE agent.' };
      }

      const refineVars: Record<string, string> = {
        previousChangeName: priorSql.change_name,
        previousDeploySql:  priorSql.deploy_sql,
        previousVerifySql:  priorSql.verify_sql,
        previousRevertSql:  priorSql.revert_sql,
        previousMetaJson:   priorSql.meta_json || '{}',
        userMessage:        params.userMessage || '',
      };

      const refinePrompt  = getResolvedPrompt('SQL_REFINE_AGENT', refineVars);
      const refineUserMsg = getResolvedUserPrompt('SQL_REFINE_AGENT', refineVars);
      const reply = await callActiveLlm(refinePrompt, refineUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_SQL_REFINE',
        model: 'agent-pool-delegate',
        system_prompt: refinePrompt.slice(0, 500),
        user_prompt: params.userMessage,
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId, priorChangeName: priorSql.change_name }),
      });

      return { success: true, result: reply };
    }

    case 'WIKI': {
      const extPath = options?.extensionPath || '';
      const wikiContext = extPath ? searchWiki(params.userMessage || '', extPath, 4) : '';
      const wikiPrompt  = getResolvedPrompt('WIKI_AGENT', { context: wikiContext });
      const wikiUserMsg = getResolvedUserPrompt('WIKI_AGENT', { userMessage: params.userMessage || '' });
      const reply = await callActiveLlm(wikiPrompt, wikiUserMsg, 0.3);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_WIKI',
        model: 'agent-pool-delegate',
        system_prompt: wikiPrompt.slice(0, 500),
        user_prompt: params.userMessage,
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'SQL_FAQ': {
      const faqPrompt  = getResolvedPrompt('SQL_FAQ_AGENT', { userMessage: params.userMessage || '' });
      const faqUserMsg = getResolvedUserPrompt('SQL_FAQ_AGENT', { userMessage: params.userMessage || '' });
      const reply = await callActiveLlm(faqPrompt, faqUserMsg, 0.3);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_SQL_FAQ',
        model: 'agent-pool-delegate',
        system_prompt: faqPrompt.slice(0, 500),
        user_prompt: params.userMessage,
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'GENERAL_FAQ': {
      const genPrompt  = getResolvedPrompt('GENERAL_FAQ_AGENT', { userMessage: params.userMessage || '' });
      const genUserMsg = getResolvedUserPrompt('GENERAL_FAQ_AGENT', { userMessage: params.userMessage || '' });
      const reply = await callActiveLlm(genPrompt, genUserMsg, 0.3);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_GENERAL_FAQ',
        model: 'agent-pool-delegate',
        system_prompt: genPrompt.slice(0, 500),
        user_prompt: params.userMessage,
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'GIT_COMMIT': {
      const commitVars: Record<string, string> = {
        changeSummary: params.changeSummary || '',
        folderName:    params.folderName || '',
        deploySql:     params.deploySql || '',
        branch:        params.branch || 'main',
      };
      const commitPrompt  = getResolvedPrompt('GIT_COMMIT_MESSAGE', commitVars);
      const commitUserMsg = getResolvedUserPrompt('GIT_COMMIT_MESSAGE', commitVars);
      const reply = await callActiveLlm(commitPrompt, commitUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_GIT_COMMIT',
        model: 'agent-pool-delegate',
        system_prompt: commitPrompt.slice(0, 500),
        user_prompt: JSON.stringify(commitVars).slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId, folderName: params.folderName }),
      });

      return { success: true, result: reply };
    }

    case 'FREEFORM_SQL': {
      const freeVars: Record<string, string> = {
        sql:            params.sql || '',
        changeNameHint: params.changeNameHint || '',
        dbSchema:       params.dbSchema || 'public',
      };
      const freePrompt  = getResolvedPrompt('FREEFORM_SQL', freeVars);
      const freeUserMsg = getResolvedUserPrompt('FREEFORM_SQL', freeVars);
      const reply = await callActiveLlm(freePrompt, freeUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_FREEFORM_SQL',
        model: 'agent-pool-delegate',
        system_prompt: freePrompt.slice(0, 500),
        user_prompt: (params.sql || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId, changeNameHint: params.changeNameHint }),
      });

      return { success: true, result: reply };
    }

    case 'DMCR_GENERATE': {
      const dmcrVars: Record<string, string> = {
        userRequest:       params.userRequest || '',
        schemaContext:     params.schemaContext || '',
        changeNameContext: params.changeNameContext || '',
      };
      const dmcrPrompt  = getResolvedPrompt('DMCR_RULES', dmcrVars);
      const dmcrUserMsg = getResolvedUserPrompt('DMCR_RULES', dmcrVars);
      const reply = await callActiveLlm(dmcrPrompt, dmcrUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_DMCR_GENERATE',
        model: 'agent-pool-delegate',
        system_prompt: dmcrPrompt.slice(0, 500),
        user_prompt: (params.userRequest || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'ADD_COLUMNS': {
      const addVars: Record<string, string> = {
        tableAction:    params.tableAction || 'alter',
        cleanTables:    params.cleanTables || '[]',
        changeNameHint: params.changeNameHint || '',
      };
      const addPrompt  = getResolvedPrompt('ADD_COLUMNS', addVars);
      const addUserMsg = getResolvedUserPrompt('ADD_COLUMNS', addVars);
      const reply = await callActiveLlm(addPrompt, addUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_ADD_COLUMNS',
        model: 'agent-pool-delegate',
        system_prompt: addPrompt.slice(0, 500),
        user_prompt: (params.cleanTables || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId, tableAction: params.tableAction }),
      });

      return { success: true, result: reply };
    }

    case 'INSERT_ROWS': {
      const insVars: Record<string, string> = {
        table:          params.table || '',
        columns:        params.columns || '[]',
        rows:           params.rows || '[]',
        idempotent:     params.idempotent || 'no',
        conflictTarget: params.conflictTarget || '',
        conflictAction: params.conflictAction || 'do_nothing',
      };
      const insPrompt  = getResolvedPrompt('INSERT_ROWS', insVars);
      const insUserMsg = getResolvedUserPrompt('INSERT_ROWS', insVars);
      const reply = await callActiveLlm(insPrompt, insUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_INSERT_ROWS',
        model: 'agent-pool-delegate',
        system_prompt: insPrompt.slice(0, 500),
        user_prompt: `table: ${params.table || ''}, rows: ${(params.rows || '').slice(0, 300)}`,
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId, table: params.table }),
      });

      return { success: true, result: reply };
    }

    case 'INTENT_DETECTOR': {
      const intentVars: Record<string, string> = {
        userPrompt: params.userPrompt || '',
      };
      const intentPrompt  = getResolvedPrompt('INTENT_DETECTOR', intentVars);
      const intentUserMsg = getResolvedUserPrompt('INTENT_DETECTOR', intentVars);
      const reply = await callActiveLlm(intentPrompt, intentUserMsg, 0.1);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_INTENT_DETECTOR',
        model: 'agent-pool-delegate',
        system_prompt: intentPrompt.slice(0, 500),
        user_prompt: (params.userPrompt || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'REQUEST_PLANNER': {
      const planVars: Record<string, string> = {
        userRequest: params.userRequest || '',
      };
      const planPrompt  = getResolvedPrompt('REQUEST_PLANNER', planVars);
      const planUserMsg = getResolvedUserPrompt('REQUEST_PLANNER', planVars);
      const reply = await callActiveLlm(planPrompt, planUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_REQUEST_PLANNER',
        model: 'agent-pool-delegate',
        system_prompt: planPrompt.slice(0, 500),
        user_prompt: (params.userRequest || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'FOLLOWUP_DECIDER': {
      const fuVars: Record<string, string> = {
        originalText: params.originalText || '',
        followUp:     params.followUp || '',
        userReply:    params.userReply || '',
        intent:       params.intent || '',
      };
      const fuPrompt  = getResolvedPrompt('FOLLOWUP_DECIDER', fuVars);
      const fuUserMsg = getResolvedUserPrompt('FOLLOWUP_DECIDER', fuVars);
      const reply = await callActiveLlm(fuPrompt, fuUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_FOLLOWUP_DECIDER',
        model: 'agent-pool-delegate',
        system_prompt: fuPrompt.slice(0, 500),
        user_prompt: (params.userReply || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'MASTER_AGENT': {
      const masterVars: Record<string, string> = {
        userMessage: params.userMessage || '',
      };
      const masterPrompt  = getResolvedPrompt('MASTER_AGENT', masterVars);
      const masterUserMsg = getResolvedUserPrompt('MASTER_AGENT', masterVars);
      const reply = await callActiveLlm(masterPrompt, masterUserMsg, 0.1);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_MASTER_AGENT',
        model: 'agent-pool-delegate',
        system_prompt: masterPrompt.slice(0, 500),
        user_prompt: (params.userMessage || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'GREETING_AGENT': {
      const greetVars: Record<string, string> = {
        userMessage: params.userMessage || '',
      };
      const greetPrompt  = getResolvedPrompt('GREETING_AGENT', greetVars);
      const greetUserMsg = getResolvedUserPrompt('GREETING_AGENT', greetVars);
      const reply = await callActiveLlm(greetPrompt, greetUserMsg, 0.5);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_GREETING_AGENT',
        model: 'agent-pool-delegate',
        system_prompt: greetPrompt.slice(0, 500),
        user_prompt: (params.userMessage || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'MCP_AGENT': {
      const mcpVars: Record<string, string> = {
        userMessage: params.userMessage || '',
        toolList:    params.toolList || '',
      };
      const mcpPrompt  = getResolvedPrompt('MCP_AGENT', mcpVars);
      const mcpUserMsg = getResolvedUserPrompt('MCP_AGENT', mcpVars);
      const reply = await callActiveLlm(mcpPrompt, mcpUserMsg, 0.2);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_MCP_AGENT',
        model: 'agent-pool-delegate',
        system_prompt: mcpPrompt.slice(0, 500),
        user_prompt: (params.userMessage || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    case 'DIALOGUE_INTENT': {
      const diaVars: Record<string, string> = {
        conversationHistory: params.conversationHistory || '',
        userMessage:         params.userMessage || '',
      };
      const diaPrompt  = getResolvedPrompt('DIALOGUE_INTENT', diaVars);
      const diaUserMsg = getResolvedUserPrompt('DIALOGUE_INTENT', diaVars);
      const reply = await callActiveLlm(diaPrompt, diaUserMsg, 0.1);

      insertAudit({
        conversation_id: conversationId,
        stage: 'AGENT_POOL_DIALOGUE_INTENT',
        model: 'agent-pool-delegate',
        system_prompt: diaPrompt.slice(0, 500),
        user_prompt: (params.userMessage || '').slice(0, 500),
        request_payload: JSON.stringify({ delegatedFrom: 'agentPool', agent: agentId }),
        response_payload: JSON.stringify({ raw: reply.slice(0, 4000) }),
        duration_ms: Date.now() - t0,
        meta: JSON.stringify({ conversationId }),
      });

      return { success: true, result: reply };
    }

    default:
      return { success: false, result: '', error: `Agent ${agentId} not implemented` };
  }
}

/**
 * Get registered agents (for UI/debugging).
 */
export function listAgentPool(): AgentPoolEntry[] {
  return [...AGENT_REGISTRY];
}
