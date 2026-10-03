/**
 * Prompt Library — DB-backed customizable prompts.
 *
 * Users can edit existing prompts via the UI. The DB version takes priority
 * over the hardcoded defaults in prompt-template.ts.
 *
 * Schema:
 *   prompt_library (scenario TEXT PK, system_prompt TEXT, agent_name TEXT, updated_at TEXT)
 */
import { AI_FEATURE_PROMPTS } from '../forms/llm/prompts/ai-feature-prompts';
import {
  INTENT_DETECTOR_SYSTEM_PROMPT,
  REQUEST_PLANNER_SYSTEM_PROMPT,
  FOLLOWUP_DECIDER_SYSTEM_PROMPT,
  MASTER_AGENT_SYSTEM_PROMPT,
  GREETING_AGENT_SYSTEM_PROMPT,
  GENERAL_FAQ_AGENT_SYSTEM_PROMPT,
  SQL_FAQ_AGENT_SYSTEM_PROMPT,
  MCP_AGENT_PREAMBLE,
  MCP_TOOL_AGENT_SYSTEM_PROMPT,
  SCHEMA_DRIFT_SUMMARY_SYSTEM_PROMPT,
  SCHEMA_DRIFT_SUMMARY_USER_PROMPT,
  DIALOGUE_INTENT_SYSTEM_PROMPT,
  SQL_REFINE_AGENT_SYSTEM_PROMPT,
  dmcrRulesSystemPrompt,
  buildWikiAgentPrompt,
  buildDangerContextPrompt,
} from '../forms/llm/prompts/prompt-template';
import { resolvePromptTemplate, type FunctionResolver } from '../services/llm/template/prompt-template-resolver';
import { createAgentPoolResolver } from '../services/agent-pool';

// ─── Scenario enum ───────────────────────────────────────────────────────────

export type PromptScenario =
  | 'DMCR_RULES'
  | 'INTENT_DETECTOR'
  | 'REQUEST_PLANNER'
  | 'FOLLOWUP_DECIDER'
  | 'FREEFORM_SQL'
  | 'ADD_COLUMNS'
  | 'INSERT_ROWS'
  | 'MASTER_AGENT'
  | 'GREETING_AGENT'
  | 'GENERAL_FAQ_AGENT'
  | 'SQL_FAQ_AGENT'
  | 'SQL_REFINE_AGENT'
  | 'WIKI_AGENT'
  | 'MCP_AGENT'
  | 'MCP_TOOL_AGENT'
  | 'DIALOGUE_INTENT'
  | 'GIT_COMMIT_MESSAGE'
  | 'SCHEMA_DRIFT_SUMMARY'
  // ── AI Power Features (D18 / D19) ──────────────────────────────────────────
  | 'AI_CHANGE_EXPLAINER'
  | 'AI_RISK_SCORER'
  | 'AI_SCHEMA_DOCUMENTER'
  | 'AI_ROLLBACK_ADVISOR'
  | 'AI_DEPENDENCY_ANALYZER'
  | 'AI_CHANGELOG_GENERATOR'
  | 'AI_DEAD_COLUMN_DETECTOR'
  | 'AI_SQL_POLICY_GUARD'
  | 'AI_SEMANTIC_VERSION'
  | 'AI_DRIFT_DETECTIVE'
  | 'AI_TEST_DATA_GENERATOR'
  | 'AI_PERF_PREDICTOR'
  | 'AI_PROMOTION_GATEKEEPER'
  | 'AI_ENV_DIFF_EXPLAINER'
  | 'AI_PROMOTION_ORDER'
  | 'AI_BLAST_RADIUS'
  | 'AI_BLUE_GREEN_PLAN'
  | 'AI_POST_DEPLOY_HEALTH'
  | 'AI_COMPLIANCE_CHECKER'
  | 'AI_CONFLICT_RESOLVER'
  | 'AI_CANARY_ADVISOR'
  | 'AI_TICKET_LINKER';

export const ALL_SCENARIOS: PromptScenario[] = [
  'DMCR_RULES',
  'INTENT_DETECTOR',
  'REQUEST_PLANNER',
  'FOLLOWUP_DECIDER',
  'FREEFORM_SQL',
  'ADD_COLUMNS',
  'INSERT_ROWS',
  'MASTER_AGENT',
  'GREETING_AGENT',
  'GENERAL_FAQ_AGENT',
  'SQL_FAQ_AGENT',
  'SQL_REFINE_AGENT',
  'WIKI_AGENT',
  'MCP_AGENT',
  'MCP_TOOL_AGENT',
  'DIALOGUE_INTENT',
  'GIT_COMMIT_MESSAGE',
  'SCHEMA_DRIFT_SUMMARY',
  // AI Power Features
  'AI_CHANGE_EXPLAINER',
  'AI_RISK_SCORER',
  'AI_SCHEMA_DOCUMENTER',
  'AI_ROLLBACK_ADVISOR',
  'AI_DEPENDENCY_ANALYZER',
  'AI_CHANGELOG_GENERATOR',
  'AI_DEAD_COLUMN_DETECTOR',
  'AI_SQL_POLICY_GUARD',
  'AI_SEMANTIC_VERSION',
  'AI_DRIFT_DETECTIVE',
  'AI_TEST_DATA_GENERATOR',
  'AI_PERF_PREDICTOR',
  'AI_PROMOTION_GATEKEEPER',
  'AI_ENV_DIFF_EXPLAINER',
  'AI_PROMOTION_ORDER',
  'AI_BLAST_RADIUS',
  'AI_BLUE_GREEN_PLAN',
  'AI_POST_DEPLOY_HEALTH',
  'AI_COMPLIANCE_CHECKER',
  'AI_CONFLICT_RESOLVER',
  'AI_CANARY_ADVISOR',
  'AI_TICKET_LINKER',
];

// ─── Variable palette per scenario ──────────────────────────────────────────

export type VariableInfo = {
  description: string;
  source: string;
};

export type ScenarioVarMap = Record<string, VariableInfo>;

const FREEFORM_VARS: ScenarioVarMap = {
  sql:              { description: 'User-provided deploy SQL', source: 'Freeform SQL editor textarea' },
  previousSql:      { description: 'Previous version SQL (for function/view diffs)', source: 'Previous version toggle' },
  changeNameHint:   { description: 'Suggested change folder name', source: 'Change name input' },
  dbSchema:         { description: 'Default schema (e.g. public, zp_st)', source: 'Schema selector dropdown' },
  deployRoutine:    { description: 'Detected routine kind+signature in deploy SQL', source: 'Auto-parsed from SQL' },
  prevRoutine:      { description: 'Detected routine kind+signature in previous SQL', source: 'Auto-parsed from SQL' },
};


const ADD_COLUMNS_VARS: ScenarioVarMap = {
  tableAction:      { description: 'Action type: alter | create | sequence | grant-tables | grant-sequences | create-schema', source: 'Form mode selector' },
  cleanTables:      { description: 'Array of {table, columns[{name,type}]} definitions', source: 'Table/column builder grid' },
  changeNameHint:   { description: 'Suggested change folder name', source: 'Change name input' },
  tableGrant:       { description: 'GRANT privileges and role for tables', source: 'Grant configuration toggles' },
  schemaName:       { description: 'Schema name for CREATE SCHEMA', source: 'Schema input field' },
  sequence:         { description: 'Sequence name, START, INCREMENT, MIN, MAX, CACHE', source: 'Sequence configuration fields' },
};

const INSERT_ROWS_VARS: ScenarioVarMap = {
  table:            { description: 'Target table (schema.table)', source: 'Table name input' },
  columns:          { description: 'Column definitions [{name, type}]', source: 'Column builder grid' },
  rows:             { description: 'Row data as array of objects', source: 'Row data grid/JSON' },
  idempotent:       { description: 'Whether to use ON CONFLICT (yes/no)', source: 'Idempotent toggle' },
  conflictTarget:   { description: 'Unique key columns for ON CONFLICT', source: 'Conflict target input' },
  conflictAction:   { description: 'do_nothing | update', source: 'Conflict action selector' },
};

const DMCR_RULES_VARS: ScenarioVarMap = {
  dangerContextPrompt:  { description: 'Auto-generated danger pattern rules from dmcr_danger.json', source: 'Workspace dmcr_danger.json + defaults' },
  toolList:             { description: 'Discovered MCP tools (appended at runtime if MCP servers configured)', source: 'MCP server discovery via mcp-agent.ts' },
  agentPool:            { description: 'Available agents that can be delegated to (e.g. SQL_REFINE)', source: 'Agent pool registry (agent-pool.ts)' },
  dmcrContext:          { description: 'DMCR repository context files (dmcr.ps1, dmcr.cfg, etc.)', source: 'Workspace root files (auto)' },
  userRequest:          { description: 'The user\'s raw change request text', source: 'Chat input / form submission' },
  schemaContext:        { description: 'Schema qualifier context (e.g. default schema for unqualified names)', source: 'Schema selector in conversation UI' },
  changeNameContext:    { description: 'Suggested change folder name hint', source: 'Change name input in conversation UI' },
  conversationHistory:  { description: 'Recent conversation turns for context continuity', source: 'Conversation history (auto)' },
};

const WIKI_AGENT_VARS: ScenarioVarMap = {
  context:              { description: 'BM25-retrieved documentation sections from DmcrWiki.md', source: 'Wiki search engine (auto)' },
};

const INTENT_VARS: ScenarioVarMap = {
  userPrompt:           { description: 'The user\'s raw message/request', source: 'Chat input / form submission' },
  toolList:             { description: 'Discovered MCP tools (appended at runtime if MCP servers configured)', source: 'MCP server discovery via mcp-agent.ts' },
};

const PLANNER_VARS: ScenarioVarMap = {
  userRequest:          { description: 'The user\'s raw change request', source: 'Chat input / form submission' },
  toolList:             { description: 'Discovered MCP tools (appended at runtime if MCP servers configured)', source: 'MCP server discovery via mcp-agent.ts' },
};

const FOLLOWUP_VARS: ScenarioVarMap = {
  originalText:         { description: 'The original user request', source: 'Conversation state' },
  followUp:             { description: 'The follow-up question and options presented', source: 'Previous agent turn' },
  intent:               { description: 'Detected intent and risks', source: 'Intent detector output' },
  userReply:            { description: 'The user\'s reply to the follow-up', source: 'Chat input' },
  toolList:             { description: 'Discovered MCP tools (appended at runtime if MCP servers configured)', source: 'MCP server discovery via mcp-agent.ts' },
};

const MASTER_AGENT_VARS: ScenarioVarMap = {
  userMessage:          { description: 'The user\'s raw message to classify', source: 'Chat input' },
};

const DIALOGUE_INTENT_VARS: ScenarioVarMap = {
  conversationHistory:  { description: 'Last 5 conversation turns (user + assistant) formatted as text', source: 'sessionStorage dmcr_conv_history / inputParams.conversationHistory' },
  userMessage:          { description: 'The user\'s message (after dialogue intent resolution)', source: 'Chat input' },
};

const GREETING_AGENT_VARS: ScenarioVarMap = {
  userMessage:          { description: 'The user\'s message', source: 'Chat input' },
};

const GENERAL_FAQ_AGENT_VARS: ScenarioVarMap = {
  toolList:             { description: 'Discovered MCP tools (appended at runtime if MCP servers configured)', source: 'MCP server discovery via mcp-agent.ts' },
  conversationHistory:  { description: 'Recent conversation turns for context continuity', source: 'Conversation history (auto)' },
  userMessage:          { description: 'The user\'s message (after dialogue intent resolution)', source: 'Chat input' },
};

const SQL_FAQ_AGENT_VARS: ScenarioVarMap = {
  toolList:             { description: 'Discovered MCP tools (appended at runtime if MCP servers configured)', source: 'MCP server discovery via mcp-agent.ts' },
  agentPool:            { description: 'Available agents that can be delegated to (e.g. SQL_REFINE)', source: 'Agent pool registry (agent-pool.ts)' },
  conversationHistory:  { description: 'Recent conversation turns for context continuity', source: 'Conversation history (auto)' },
  userMessage:          { description: 'The user\'s message (after dialogue intent resolution)', source: 'Chat input' },
};

const AI_CHANGE_VARS: ScenarioVarMap = {
  command:   { description: 'The DMCR runner command that was executed', source: 'Runner history row' },
  deploySql: { description: 'Contents of the deploy.sql file (if found)', source: 'changesDir/<name>/deploy.sql' },
};
const AI_RISK_VARS: ScenarioVarMap = {
  changes:   { description: 'Array of {name, deploySql} for each pending change', source: 'changesDir pending folders' },
};
const AI_SCHEMA_DOC_VARS: ScenarioVarMap = {
  schema:    { description: 'Schema name being documented', source: 'Schema Explorer context menu' },
  tables:    { description: 'Table metadata from MCP discover_objects', source: 'MCP server' },
};
const AI_ROLLBACK_VARS: ScenarioVarMap = {
  deploySql: { description: 'The deploy.sql to generate a revert for', source: 'changesDir/<name>/deploy.sql' },
  revertSql: { description: 'Existing revert.sql (if present)', source: 'changesDir/<name>/revert.sql' },
};
const AI_DEPS_VARS: ScenarioVarMap = {
  deploySql:   { description: 'The new migration SQL being analyzed', source: 'Generated change SQL' },
  existingIds: { description: 'List of existing change folder names', source: 'changesDir folder scan' },
};
const AI_CHANGELOG_VARS: ScenarioVarMap = {
  history: { description: 'Runner history entries with timestamps and commands', source: 'DMCR runner --history output' },
};
const AI_DEADCOL_VARS: ScenarioVarMap = {
  schema:  { description: 'Target schema name', source: 'Schema Explorer context menu' },
  tables:  { description: 'Table + column list from information_schema', source: 'MCP server' },
};
const AI_POLICY_VARS: ScenarioVarMap = {
  policies:  { description: 'Array of policy strings defined in Settings → SQL Policies', source: 'sql_policies KV store' },
  deploySql: { description: 'The generated change SQL to validate', source: 'Generated change SQL' },
};
const AI_DRIFT_VARS: ScenarioVarMap = {
  sourceObjects: { description: 'Objects from source schema via MCP discover_objects', source: 'Source MCP server' },
  targetObjects: { description: 'Objects from target schema via MCP discover_objects', source: 'Target MCP server' },
};
const AI_PERF_VARS: ScenarioVarMap = {
  deploySql:  { description: 'The migration SQL to analyze', source: 'changesDir/<name>/deploy.sql' },
  tableStats: { description: 'Row estimate from pg_class for affected table', source: 'MCP server' },
};
const AI_GATE_VARS: ScenarioVarMap = {
  changeName:  { description: 'The change folder being gate-checked', source: 'Runner history row' },
  checklist:   { description: 'Pre-flight checklist results {name, passed, detail}[]', source: 'DMCR gate checks' },
};
const AI_DIFF_EXPLAIN_VARS: ScenarioVarMap = {
  diffData:   { description: 'Schema diff result between source and target', source: 'Schema Diff compare result' },
  history:    { description: 'Applied change history for both environments', source: 'changesDir applied metadata' },
};
const AI_ORDER_VARS: ScenarioVarMap = {
  changes:    { description: 'Array of {name, deploySql, requires} for each pending change', source: 'changesDir pending folders' },
};
const AI_BLAST_VARS: ScenarioVarMap = {
  deploySql:     { description: 'The migration SQL', source: 'changesDir/<name>/deploy.sql' },
  pgDependRows:  { description: 'Downstream objects from pg_depend query', source: 'MCP server' },
};
const AI_BLUEGN_VARS: ScenarioVarMap = {
  deploySql:  { description: 'The breaking DDL to plan around', source: 'changesDir/<name>/deploy.sql' },
};
const AI_HEALTH_VARS: ScenarioVarMap = {
  deploySql:     { description: 'The deployed SQL to generate checks for', source: 'changesDir/<name>/deploy.sql' },
  diagnosticSql: { description: 'AI-generated diagnostic queries run via MCP', source: 'AI generated at runtime' },
};
const AI_COMPLY_VARS: ScenarioVarMap = {
  deploySql: { description: 'The SQL to check', source: 'changesDir/<name>/deploy.sql' },
  profiles:  { description: 'Compliance profiles selected (GDPR, SOC2, HIPAA)', source: 'User selection' },
};
const AI_CONFLICT_VARS: ScenarioVarMap = {
  stSql:   { description: 'ST environment migration SQL', source: 'ST changesDir' },
  prodSql: { description: 'PROD environment migration SQL', source: 'PROD changesDir' },
};
const AI_CANARY_VARS: ScenarioVarMap = {
  deploySql:  { description: 'The large-table migration SQL', source: 'changesDir/<name>/deploy.sql' },
  tableRows:  { description: 'Estimated row count from pg_class', source: 'MCP server' },
};
const AI_TICKET_VARS: ScenarioVarMap = {
  changeNames: { description: 'List of change folder names', source: 'changesDir folder scan' },
  gitLog:      { description: 'Recent git commit messages', source: 'git log --oneline' },
};

export const SCENARIO_VARIABLES: Record<PromptScenario, ScenarioVarMap> = {
  DMCR_RULES: DMCR_RULES_VARS,
  INTENT_DETECTOR: INTENT_VARS,
  REQUEST_PLANNER: PLANNER_VARS,
  FOLLOWUP_DECIDER: FOLLOWUP_VARS,
  FREEFORM_SQL: FREEFORM_VARS,
  ADD_COLUMNS: ADD_COLUMNS_VARS,
  INSERT_ROWS: INSERT_ROWS_VARS,
  MASTER_AGENT: MASTER_AGENT_VARS,
  GREETING_AGENT: GREETING_AGENT_VARS,
  GENERAL_FAQ_AGENT: GENERAL_FAQ_AGENT_VARS,
  SQL_FAQ_AGENT: SQL_FAQ_AGENT_VARS,
  SQL_REFINE_AGENT: {
    previousChangeName: { description: 'The change name from the previously generated DMCR change', source: 'conversation_sql table' },
    previousDeploySql:  { description: 'Full deploy.sql from the previously generated DMCR change', source: 'conversation_sql table' },
    previousVerifySql:  { description: 'Full verify.sql from the previously generated DMCR change', source: 'conversation_sql table' },
    previousRevertSql:  { description: 'Full revert.sql from the previously generated DMCR change', source: 'conversation_sql table' },
    previousMetaJson:   { description: 'Full meta.json from the previously generated DMCR change (dependencies, tags, author, etc.)', source: 'conversation_sql table' },
    userMessage:        { description: 'The user\'s modification request', source: 'Chat input' },
  },
  WIKI_AGENT: { ...WIKI_AGENT_VARS, conversationHistory: { description: 'Recent conversation turns for context continuity', source: 'Conversation history (auto)' }, userMessage: { description: 'The user\'s message (after dialogue intent resolution)', source: 'Chat input' } },
  MCP_AGENT: { toolList: { description: 'Dynamically discovered MCP tools (injected at runtime)', source: 'MCP server discovery via mcp-agent.ts' } },
  MCP_TOOL_AGENT: {
    toolList:             { description: 'Discovered MCP tools injected at runtime (compare_schemas, etc.)', source: 'MCP server discovery via mcp-agent.ts' },
    conversationHistory:  { description: 'Recent conversation turns for context continuity', source: 'Conversation history (auto)' },
    userMessage:          { description: "The user's message (e.g. schema comparison request)", source: 'Chat input' },
  },
  DIALOGUE_INTENT: DIALOGUE_INTENT_VARS,
  GIT_COMMIT_MESSAGE: {
    changeSummary: { description: 'Git status + diff summary of the new/modified change folders', source: 'git status --porcelain + git diff --stat' },
    folderName:    { description: 'The change folder name (e.g. 005_add_email_to_users)', source: 'saveChangeToDisk result' },
    deploySql:     { description: 'Contents of deploy.sql being committed', source: 'Generated deploy SQL' },
    branch:        { description: 'Current git branch name', source: 'git rev-parse --abbrev-ref HEAD' },
  },
  SCHEMA_DRIFT_SUMMARY: {
    driftJson: { description: 'Raw JSON output of compare_schemas (only_in_source, only_in_target, drifted, in_sync, summary)', source: 'compareSchemasMcp result → runner-handlers.ts' },
  },
  AI_CHANGE_EXPLAINER: AI_CHANGE_VARS,
  AI_RISK_SCORER: AI_RISK_VARS,
  AI_SCHEMA_DOCUMENTER: AI_SCHEMA_DOC_VARS,
  AI_ROLLBACK_ADVISOR: AI_ROLLBACK_VARS,
  AI_DEPENDENCY_ANALYZER: AI_DEPS_VARS,
  AI_CHANGELOG_GENERATOR: AI_CHANGELOG_VARS,
  AI_DEAD_COLUMN_DETECTOR: AI_DEADCOL_VARS,
  AI_SQL_POLICY_GUARD: AI_POLICY_VARS,
  AI_SEMANTIC_VERSION: {},
  AI_DRIFT_DETECTIVE: AI_DRIFT_VARS,
  AI_TEST_DATA_GENERATOR: { table: { description: 'Target table (schema.table)', source: 'Copilot chat input' }, schema: { description: 'Column definitions from MCP', source: 'MCP server' } },
  AI_PERF_PREDICTOR: AI_PERF_VARS,
  AI_PROMOTION_GATEKEEPER: AI_GATE_VARS,
  AI_ENV_DIFF_EXPLAINER: AI_DIFF_EXPLAIN_VARS,
  AI_PROMOTION_ORDER: AI_ORDER_VARS,
  AI_BLAST_RADIUS: AI_BLAST_VARS,
  AI_BLUE_GREEN_PLAN: AI_BLUEGN_VARS,
  AI_POST_DEPLOY_HEALTH: AI_HEALTH_VARS,
  AI_COMPLIANCE_CHECKER: AI_COMPLY_VARS,
  AI_CONFLICT_RESOLVER: AI_CONFLICT_VARS,
  AI_CANARY_ADVISOR: AI_CANARY_VARS,
  AI_TICKET_LINKER: AI_TICKET_VARS,
};

// ─── Human-friendly labels ──────────────────────────────────────────────────

export const SCENARIO_LABELS: Record<PromptScenario, string> = {
  AI_CHANGE_EXPLAINER: 'AI Change Explainer (D18.1)',
  AI_RISK_SCORER: 'AI Migration Risk Scorer (D18.2)',
  AI_SCHEMA_DOCUMENTER: 'AI Schema Documenter (D18.3)',
  AI_ROLLBACK_ADVISOR: 'AI Rollback Advisor (D18.4)',
  AI_DEPENDENCY_ANALYZER: 'AI Dependency Analyzer (D18.5)',
  AI_CHANGELOG_GENERATOR: 'AI Changelog Generator (D18.6)',
  AI_DEAD_COLUMN_DETECTOR: 'AI Dead Column Detector (D18.7)',
  AI_SQL_POLICY_GUARD: 'AI SQL Policy Guard (D18.8)',
  AI_SEMANTIC_VERSION: 'AI Semantic Versioning (D18.9)',
  AI_DRIFT_DETECTIVE: 'AI Drift Detective (D18.10)',
  AI_TEST_DATA_GENERATOR: 'AI Test Data Generator (D18.11)',
  AI_PERF_PREDICTOR: 'AI Performance Impact Predictor (D18.12)',
  AI_PROMOTION_GATEKEEPER: 'AI Promotion Gatekeeper (D19.1)',
  AI_ENV_DIFF_EXPLAINER: 'AI Environment Diff Explainer (D19.2)',
  AI_PROMOTION_ORDER: 'AI Promotion Order Optimizer (D19.3)',
  AI_BLAST_RADIUS: 'AI Blast Radius Estimator (D19.4)',
  AI_BLUE_GREEN_PLAN: 'AI Blue/Green Deploy Planner (D19.5)',
  AI_POST_DEPLOY_HEALTH: 'AI Post-Deploy Health Check (D19.6)',
  AI_COMPLIANCE_CHECKER: 'AI Compliance Checker (D19.7)',
  AI_CONFLICT_RESOLVER: 'AI Conflict Resolver (D19.8)',
  AI_CANARY_ADVISOR: 'AI Canary Rollout Advisor (D19.9)',
  AI_TICKET_LINKER: 'AI Ticket Linker (D19.10)',
  DMCR_RULES: 'SQL Generator (System)',
  INTENT_DETECTOR: 'Intent Detector',
  REQUEST_PLANNER: 'Request Planner',
  FOLLOWUP_DECIDER: 'Follow-up Decider',
  FREEFORM_SQL: 'Freeform SQL (User Prompt)',
  ADD_COLUMNS: 'DDL / Add Columns (User Prompt)',
  INSERT_ROWS: 'DML / Insert Rows (User Prompt)',
  MASTER_AGENT: 'Master Agent (Router)',
  GREETING_AGENT: 'Greeting Agent',
  GENERAL_FAQ_AGENT: 'General FAQ Agent',
  SQL_FAQ_AGENT: 'SQL FAQ Agent',
  SQL_REFINE_AGENT: 'SQL Refine Agent',
  WIKI_AGENT: 'Wiki Agent',
  MCP_AGENT: 'MCP Agent',
  MCP_TOOL_AGENT: 'MCP Tool Agent',
  DIALOGUE_INTENT: 'Dialogue Intent Resolver',
  GIT_COMMIT_MESSAGE: 'Git Commit Message',
  SCHEMA_DRIFT_SUMMARY: 'Schema Drift Summary Agent',
};

export const SCENARIO_DESCRIPTIONS: Record<PromptScenario, string> = {
  DMCR_RULES: 'Core system prompt for the SQL generation engine. MCP-aware: can call MCP tools for live schema context.',
  INTENT_DETECTOR: 'Classifies user requests into DMCR intents (ADD_COLUMN, CREATE_TABLE, etc.) and detects risks. MCP-aware: can query schema to improve classification.',
  REQUEST_PLANNER: 'Decides whether to generate SQL immediately or ask for clarifications. MCP-aware: can inspect schema to resolve ambiguity without asking the user.',
  FOLLOWUP_DECIDER: 'Interprets user replies to follow-up questions and decides the next action. MCP-aware: can verify schema details from user replies.',
  FREEFORM_SQL: 'User prompt template for the Freeform SQL form. Receives raw SQL and generates deploy/verify/revert.',
  ADD_COLUMNS: 'User prompt template for the DDL form. Generates ALTER TABLE, CREATE TABLE, CREATE SEQUENCE, and GRANT statements.',
  INSERT_ROWS: 'User prompt template for the DML form. Generates INSERT statements with optional idempotency.',
  MASTER_AGENT: 'Routes user messages to the correct agent (GREETING, FAQ, WIKI, MCP_TOOL, SQL_REFINE, or DMCR).',
  GREETING_AGENT: 'Responds warmly to greetings and redirects to DMCR capabilities.',
  GENERAL_FAQ_AGENT: 'Handles general DMCR questions (concepts, features, forms, workflow). MCP-aware.',
  SQL_FAQ_AGENT: 'Handles database/SQL-related questions with live schema access. MCP-aware: queries MCP tools to verify tables, columns, and structures.',
  SQL_REFINE_AGENT: 'Modifies previously generated DMCR change SQL based on follow-up requests. Receives the FULL original SQL from the conversation_sql table — no truncation.',
  WIKI_AGENT: 'Answers documentation questions using retrieved wiki sections.',
  MCP_AGENT: 'Preamble appended when MCP servers are configured. Instructs the AI to use discovered tools via mcpToolCalls.',
  MCP_TOOL_AGENT: 'Handles live MCP tool invocations — schema comparison, drift detection, and any request that explicitly names an MCP server or tool.',
  DIALOGUE_INTENT: 'Pre-processes follow-up questions into standalone questions using the last 5 conversation turns. Makes the assistant context-aware without storing history in the DB.',
  GIT_COMMIT_MESSAGE: 'Generates a concise, conventional commit message for git-committing DMCR change folders. Used by auto-commit and /sync.',
  SCHEMA_DRIFT_SUMMARY: 'Analyzes compare_schemas JSON output and returns a structured analyst report: risk level, headline, narrative, missing/extra objects, DDL changes, and migration advice.',
  AI_CHANGE_EXPLAINER: 'Explains any DMCR migration in 3-4 bullets: what it does, tables affected, risk level, and reversibility. Triggered by the ✦ Explain button in Runner history.',
  AI_RISK_SCORER: 'Assigns LOW/MEDIUM/HIGH/CRITICAL risk to each pending migration. Triggered by ✦ Analyze Risk after a deploy --dry-run in Runner.',
  AI_SCHEMA_DOCUMENTER: 'Generates a Markdown data dictionary from live schema metadata via MCP. Triggered by right-clicking a schema in Schema Explorer → ✦ Document Schema.',
  AI_ROLLBACK_ADVISOR: 'Synthesizes a safe revert script for any migration even without revert.sql. Warns on irreversible ops. Triggered by ↩ Revert Advice in Runner history.',
  AI_DEPENDENCY_ANALYZER: 'Identifies which existing migrations the new SQL depends on. Returns dependency chips for the requires field. Triggered by ✦ Deps in Copilot change card header.',
  AI_CHANGELOG_GENERATOR: 'Generates a Keep-a-Changelog formatted CHANGELOG.md from runner history. Triggered by ✦ Generate Changelog in Runner history header.',
  AI_DEAD_COLUMN_DETECTOR: 'Finds potentially unused columns using naming patterns and pg_stat_user_tables. Returns confidence scores. Triggered by 🔍 Detect Dead Columns in Schema Explorer.',
  AI_SQL_POLICY_GUARD: 'Validates generated SQL against user-defined policies from Settings → SQL Policies. Triggers automatically 800ms after a Copilot change card renders.',
  AI_SEMANTIC_VERSION: 'Pure SQL pattern matching (no LLM). Classifies each change as PATCH / MINOR / MAJOR based on DDL keywords. Badge appears next to change name in Copilot.',
  AI_DRIFT_DETECTIVE: 'Compares source vs target schema objects via MCP and produces a risk-scored drift summary with missing/extra tables and migration advice. Triggered by ↺ Drift Check in Schema Diff.',
  AI_TEST_DATA_GENERATOR: 'Generates 10-20 realistic INSERT rows for any table, respecting NOT NULL constraints and FK references. Triggered via the 🧪 Seed test data chip in DMCR Copilot.',
  AI_PERF_PREDICTOR: 'Estimates lock type, CONCURRENTLY safety, and block time for index/ALTER ops using pg_class stats. Returns SAFE/USE CONCURRENTLY/SCHEDULE MAINTENANCE WINDOW. Triggered by ⚡ Perf in Runner history.',
  AI_PROMOTION_GATEKEEPER: 'Runs a 5-point pre-flight checklist (ticket, deploy.sql, revert.sql, dependencies, policies) and issues GO or BLOCKED verdict. Triggered by 🚦 Gate in Runner history.',
  AI_ENV_DIFF_EXPLAINER: 'Explains in plain English why ST and PROD schemas diverged and recommends promotion order. Triggered by Explain Diff button in Schema Diff after a compare.',
  AI_PROMOTION_ORDER: 'Determines safest apply sequence for a batch of pending migrations using FK/view dependency analysis. Backend handler: optimizePromotionOrder.',
  AI_BLAST_RADIUS: 'Queries pg_depend for downstream views/functions/triggers and estimates lock duration. Backend handler: estimateBlastRadius.',
  AI_BLUE_GREEN_PLAN: 'Generates a dual-phase zero-downtime migration for breaking DDL (Phase 1: backward-compatible, Phase 2: cleanup). Backend handler: blueGreenPlan.',
  AI_POST_DEPLOY_HEALTH: 'AI-generates targeted diagnostic queries, runs them via MCP, and interprets results as healthy/warning/critical. Backend handler: postDeployHealthCheck.',
  AI_COMPLIANCE_CHECKER: 'Checks SQL against GDPR, SOC 2, and HIPAA rules and returns violations with severity and remediation. Backend handler: checkCompliance.',
  AI_CONFLICT_RESOLVER: 'Performs a three-way SQL merge when the same table was altered in both ST and PROD. Returns synthesized SQL and merge strategy. Backend handler: resolveConflict.',
  AI_CANARY_ADVISOR: 'Designs a phased canary rollout for large-table migrations using pg_class row counts and pg_stat_activity metrics. Backend handler: canaryRolloutAdvisor.',
  AI_TICKET_LINKER: 'Infers Jira/Linear/GitHub ticket IDs from git log and meta.json. Returns confidence-scored change→ticket mapping. Triggered by 🎫 Link Tickets in Runner history.',
};

// ─── Default prompt text (fallbacks) ────────────────────────────────────────

export function getDefaultPromptText(scenario: PromptScenario): string {
  // AI power features: the prompts their handlers actually send (see ai-feature-prompts.ts).
  const aiFeaturePrompt = AI_FEATURE_PROMPTS[scenario];
  if (aiFeaturePrompt) { return aiFeaturePrompt; }
  switch (scenario) {
    case 'DMCR_RULES': return dmcrRulesSystemPrompt();
    case 'INTENT_DETECTOR': return INTENT_DETECTOR_SYSTEM_PROMPT;
    case 'REQUEST_PLANNER': return REQUEST_PLANNER_SYSTEM_PROMPT;
    case 'FOLLOWUP_DECIDER': return FOLLOWUP_DECIDER_SYSTEM_PROMPT;
    case 'MASTER_AGENT': return MASTER_AGENT_SYSTEM_PROMPT;
    case 'GREETING_AGENT': return GREETING_AGENT_SYSTEM_PROMPT;
    case 'GENERAL_FAQ_AGENT': return GENERAL_FAQ_AGENT_SYSTEM_PROMPT;
    case 'SQL_FAQ_AGENT': return SQL_FAQ_AGENT_SYSTEM_PROMPT;
    case 'SQL_REFINE_AGENT': return SQL_REFINE_AGENT_SYSTEM_PROMPT;
    case 'WIKI_AGENT': return buildWikiAgentPrompt('{{context}}');
    case 'MCP_AGENT': return MCP_AGENT_PREAMBLE;
    case 'MCP_TOOL_AGENT': return MCP_TOOL_AGENT_SYSTEM_PROMPT;
    case 'SCHEMA_DRIFT_SUMMARY': return SCHEMA_DRIFT_SUMMARY_SYSTEM_PROMPT;
    case 'DIALOGUE_INTENT': return DIALOGUE_INTENT_SYSTEM_PROMPT;
    case 'GIT_COMMIT_MESSAGE': return GIT_COMMIT_MESSAGE_DEFAULT;
    case 'AI_CHANGE_EXPLAINER': return `You are a PostgreSQL migration expert. Given a DMCR runner command and optionally the deploy.sql content, explain in 3-4 concise bullet points: what the change does, which tables/objects are affected, the risk level (LOW/MEDIUM/HIGH), and whether it is safely reversible.`;
    case 'AI_RISK_SCORER': return `You are a PostgreSQL migration risk expert. For each migration change provided, assign a risk level and brief justification.\n\nReturn JSON array:\n[\n  { "name": "change_folder_name", "risk": "LOW|MEDIUM|HIGH|CRITICAL", "justification": "one sentence" }\n]\n\nRisk levels:\n- LOW: CREATE INDEX, ADD COLUMN (nullable), CREATE VIEW, seed data\n- MEDIUM: ADD COLUMN NOT NULL with DEFAULT, CREATE TABLE with FKs, CREATE FUNCTION\n- HIGH: ALTER COLUMN type, DROP CONSTRAINT, RENAME COLUMN, large data migration\n- CRITICAL: DROP TABLE, DROP COLUMN, DROP SCHEMA, TRUNCATE`;
    case 'AI_SCHEMA_DOCUMENTER': return `You are a database documentation expert. Given schema metadata, generate a comprehensive Markdown data dictionary.\n\nFor each table include: purpose (inferred from name/columns), column table with type/nullable/description, and relationships.\n\nFormat as clean Markdown with ## headings per table.`;
    case 'AI_ROLLBACK_ADVISOR': return `You are a PostgreSQL migration rollback expert. Given a deploy.sql (and optionally the existing revert.sql), generate a safe revert script.\n\nRules:\n- If DROP TABLE: cannot truly revert — provide a CREATE TABLE skeleton with a warning\n- If DROP COLUMN: provide ALTER TABLE ADD COLUMN (data cannot be recovered)\n- If ADD COLUMN: provide ALTER TABLE DROP COLUMN\n- If CREATE INDEX: provide DROP INDEX\n- Warn explicitly when data loss is irreversible\n\nReturn JSON: { "revertSql": "...", "risk": "LOW|MEDIUM|HIGH|CRITICAL", "warning": "..." }`;
    case 'AI_DEPENDENCY_ANALYZER': return `You are a PostgreSQL migration dependency analyzer. Given a new migration SQL and a list of existing migration IDs, identify which existing migrations this new migration DIRECTLY depends on.\n\nA dependency exists when the new SQL references (SELECT, INSERT, FK, VIEW, TRIGGER) an object created by an existing migration.\n\nReturn JSON: { "dependencies": ["migration_id_1", "migration_id_2"] }. Return empty array if no dependencies found.`;
    case 'AI_CHANGELOG_GENERATOR': return `You are a technical writer generating a CHANGELOG.md for a PostgreSQL migration history.\n\nGroup entries by date in Keep a Changelog format (https://keepachangelog.com).\nUse sections: Added, Changed, Removed, Fixed.\nInfer section from SQL type: CREATE → Added, ALTER → Changed, DROP → Removed.\n\nReturn clean Markdown only — no JSON wrapper.`;
    case 'AI_DEAD_COLUMN_DETECTOR': return `You are a PostgreSQL schema analyst. Given a list of tables and columns, identify potentially dead or unused columns based on:\n1. Column name patterns: _old, _deprecated, _legacy, _backup, _tmp, _unused, _archived\n2. Columns that are nullable with no constraints (possible orphans)\n3. Columns whose names suggest they are superseded by other columns in the same table\n\nReturn JSON array: [{ "table": "...", "column": "...", "confidence": "HIGH|MEDIUM|LOW", "reason": "..." }]`;
    case 'AI_SQL_POLICY_GUARD': return `You are a SQL policy enforcer. Given a list of organizational policies and a PostgreSQL migration SQL, identify which policies (if any) are violated.\n\nFor each violation return: { "policy": "...", "violation": "one sentence description", "severity": "error|warning" }\n\nReturn JSON array. If no violations, return [].`;
    case 'AI_SEMANTIC_VERSION': return `(No LLM prompt — semantic versioning uses SQL pattern matching only)\n\nRules:\n- MAJOR: DROP TABLE, DROP COLUMN, RENAME COLUMN, DROP SCHEMA, ALTER COLUMN TYPE (breaking)\n- MINOR: CREATE TABLE, ADD COLUMN, CREATE VIEW, CREATE FUNCTION, CREATE SCHEMA\n- PATCH: CREATE INDEX, ADD CONSTRAINT, INSERT seed data, SET DEFAULT, GRANT\n\nThis classification runs client-side via regex — no LLM round-trip.`;
    case 'AI_DRIFT_DETECTIVE': return `You are a PostgreSQL schema drift analyst. Given a drift summary between two database environments, produce a concise AI report in this JSON format:\n{\n  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",\n  "headline": "one sentence summary",\n  "missingFromTarget": ["table1", "table2"],\n  "extraInTarget": ["table3"],\n  "migrationAdvice": "2-3 sentence actionable recommendation"\n}`;
    case 'AI_TEST_DATA_GENERATOR': return `You are a test data generator for PostgreSQL. Given a table schema, generate realistic INSERT statements that:\n1. Respect all NOT NULL constraints\n2. Use realistic values (real names, valid emails, plausible dates)\n3. Reference valid FK IDs from parent tables\n4. Respect CHECK constraints and column types\n\nGenerate exactly 15 rows. Return only SQL INSERT statements, no explanation.`;
    case 'AI_PERF_PREDICTOR': return `You are a PostgreSQL performance analyst. Given a migration SQL and optional table size stats, predict the performance impact.\n\nReturn JSON:\n{\n  "lockType": "ACCESS SHARE|ROW EXCLUSIVE|SHARE UPDATE EXCLUSIVE|ACCESS EXCLUSIVE",\n  "isConcurrentlySafe": true|false,\n  "blocksApplicationTraffic": true|false,\n  "estimatedBlockSeconds": 0,\n  "recommendation": "SAFE|USE CONCURRENTLY|SCHEDULE MAINTENANCE WINDOW",\n  "details": "one sentence explanation"\n}`;
    case 'AI_PROMOTION_GATEKEEPER': return `You are a deployment gatekeeper AI. Given a pre-flight checklist result, write a 1-2 sentence promotion verdict. If all pass: confirm readiness. If any fail: state the blockers clearly and recommend next steps.\n\nBe direct and specific. Start with GO or BLOCKED in bold.`;
    case 'AI_ENV_DIFF_EXPLAINER': return `You are a PostgreSQL DBA explaining a schema diff between two database environments in plain English. Explain:\n1. What specific changes caused each divergence\n2. The recommended promotion order for pending changes\n3. Any conflicts that need manual resolution\n\nBe concise — 200 words max.`;
    case 'AI_PROMOTION_ORDER': return `You are a PostgreSQL deployment sequencer. Given a batch of pending database migrations with their dependencies and SQL, determine the safest apply order considering FK dependencies, view dependencies, and lock contention.\n\nReturn JSON:\n{\n  "orderedChanges": ["change_a", "change_b", "change_c"],\n  "conflicts": [{ "changes": ["a", "b"], "reason": "..." }]\n}`;
    case 'AI_BLAST_RADIUS': return `You are a blast-radius analyst for PostgreSQL DDL changes. Given the change SQL and dependent objects from pg_depend, produce a JSON blast radius report:\n{\n  "lockType": "...",\n  "estimatedBlockMs": 0,\n  "impactedObjects": [{ "type": "view|function|trigger", "name": "...", "schema": "..." }],\n  "mitigation": "one sentence recommendation"\n}`;
    case 'AI_BLUE_GREEN_PLAN': return `You are a zero-downtime PostgreSQL migration planner. Given a breaking schema change, generate a dual-phase blue/green migration plan.\n\nReturn JSON:\n{\n  "phase1Sql": "backward-compatible changes (add new columns/tables, keep old ones)",\n  "phase2Sql": "cleanup after app deploy (drop old columns, rename constraints)",\n  "applicationInstructions": "what the app team needs to do between phases"\n}`;
    case 'AI_POST_DEPLOY_HEALTH': return `You are a post-deploy health analyst for PostgreSQL. Given a migration that was just applied, generate targeted diagnostic SQL queries to verify it landed cleanly.\n\nThen, given the query results, interpret them as:\n- healthy: all checks passed\n- warning: minor issues found\n- critical: significant problems requiring immediate action\n\nReturn JSON: { "status": "healthy|warning|critical", "summary": "...", "recovery": "..." }`;
    case 'AI_COMPLIANCE_CHECKER': return `You are a compliance auditor for database changes. Check the SQL against the provided compliance profiles.\n\nGDPR rules: PII columns (email, name, phone, address, ssn, dob) must have documented handling. No unencrypted PII storage without audit trail.\nSOC 2 rules: Sensitive tables must have audit columns (created_at, updated_at, created_by). No hard DELETE without soft-delete pattern.\nHIPAA rules: PHI columns need access controls. Minimum necessary access principle applies.\n\nReturn JSON array of violations: [{ "profile": "GDPR|SOC2|HIPAA", "rule": "...", "severity": "error|warning", "remediation": "..." }]. Return [] if compliant.`;
    case 'AI_CONFLICT_RESOLVER': return `You are a SQL merge specialist. Two teams independently altered the same PostgreSQL table. Produce a three-way merge that incorporates both changes safely.\n\nReturn JSON:\n{\n  "mergedSql": "combined ALTER TABLE statement(s)",\n  "mergeStrategy": "one sentence description of how conflicts were resolved",\n  "manualReviewRequired": false,\n  "conflicts": []\n}`;
    case 'AI_CANARY_ADVISOR': return `You are a canary rollout advisor for PostgreSQL. Given a large-table migration, design a safe canary rollout strategy.\n\nReturn JSON:\n{\n  "needsCanary": true|false,\n  "phase1Percent": 5,\n  "monitoringMetrics": ["pg_stat_user_tables.n_live_tup", "pg_stat_activity.wait_event_type"],\n  "greenLightThreshold": "description of conditions to proceed",\n  "advice": "2-3 sentence rollout recommendation"\n}`;
    case 'AI_TICKET_LINKER': return `You are a ticket linker AI. Given database change names and recent git commits, extract or infer ticket IDs (Jira: ABC-123, Linear: ABC-456, GitHub: #123).\n\nReturn JSON array:\n[\n  { "changeName": "...", "ticketId": "ABC-123", "ticketSystem": "Jira|Linear|GitHub|Unknown", "confidence": "high|medium|inferred", "source": "meta.json|git-log|inferred" }\n]`;
    // User prompt builders — store as template with placeholders
    case 'FREEFORM_SQL': return FREEFORM_SQL_DEFAULT;
    case 'ADD_COLUMNS': return ADD_COLUMNS_DEFAULT;
    case 'INSERT_ROWS': return INSERT_ROWS_DEFAULT;
  }
}

/** Default USER prompt text per scenario.
 * For routing/conversation agents this is just the user's message variable.
 * For form agents this is typically empty (user prompt is the form template above). */
export function getDefaultUserPromptText(scenario: PromptScenario): string {
  switch (scenario) {
    case 'MASTER_AGENT': return '{{userMessage}}';
    case 'GREETING_AGENT': return '{{userMessage}}';
    case 'GENERAL_FAQ_AGENT': return '{{userMessage}}\n\n{{conversationHistory}}';
    case 'SQL_FAQ_AGENT': return '{{userMessage}}\n\n{{conversationHistory}}';
    case 'SQL_REFINE_AGENT': return 'Modification request:\n{{userMessage}}';
    case 'WIKI_AGENT': return '{{userMessage}}\n\n{{conversationHistory}}';
    case 'MCP_AGENT': return '{{userMessage}}';
    case 'MCP_TOOL_AGENT': return '{{userMessage}}\n\n{{conversationHistory}}';
    case 'SCHEMA_DRIFT_SUMMARY': return SCHEMA_DRIFT_SUMMARY_USER_PROMPT;
    case 'DIALOGUE_INTENT': return 'Current user message: {{userMessage}}\n\n{{conversationHistory}}';
    case 'INTENT_DETECTOR': return '{{userPrompt}}';
    case 'REQUEST_PLANNER': return '{{userRequest}}';
    case 'FOLLOWUP_DECIDER': return 'Original request: {{originalText}}\nFollow-up: {{followUp}}\nDetected intent: {{intent}}\nUser reply: {{userReply}}';
    case 'DMCR_RULES': return 'User request:\n{{userRequest}}\n\n{{schemaContext}}{{changeNameContext}}{{conversationHistory}}DMCR repository context (read-only):\n\n{{dmcrContext}}';
    case 'FREEFORM_SQL': return '(User prompt is the System Prompt template above with form variables substituted)';
    case 'ADD_COLUMNS': return '(User prompt is the System Prompt template above with form variables substituted)';
    case 'INSERT_ROWS': return '(User prompt is the System Prompt template above with form variables substituted)';
    case 'GIT_COMMIT_MESSAGE': return 'Change folder: {{folderName}}\n\nDeploy SQL:\n{{deploySql}}\n\nGit changes summary:\n{{changeSummary}}\n\nBranch: {{branch}}';
    case 'AI_CHANGE_EXPLAINER': return 'Command: {{command}}\n\nDeploy SQL:\n{{deploySql}}';
    case 'AI_RISK_SCORER': return 'Pending changes to score:\n{{changes}}';
    case 'AI_SCHEMA_DOCUMENTER': return 'Schema: {{schema}}\n\nTable metadata:\n{{tables}}';
    case 'AI_ROLLBACK_ADVISOR': return 'deploy.sql:\n{{deploySql}}\n\nexisting revert.sql (if any):\n{{revertSql}}';
    case 'AI_DEPENDENCY_ANALYZER': return 'New migration SQL:\n{{deploySql}}\n\nExisting migration IDs:\n{{existingIds}}';
    case 'AI_CHANGELOG_GENERATOR': return 'Runner history:\n{{history}}';
    case 'AI_DEAD_COLUMN_DETECTOR': return 'Schema: {{schema}}\n\nTable + column metadata:\n{{tables}}';
    case 'AI_SQL_POLICY_GUARD': return 'Policies:\n{{policies}}\n\ndeploy.sql:\n{{deploySql}}';
    case 'AI_SEMANTIC_VERSION': return '(No user prompt — pattern matching only)';
    case 'AI_DRIFT_DETECTIVE': return 'Source objects:\n{{sourceObjects}}\n\nTarget objects:\n{{targetObjects}}';
    case 'AI_TEST_DATA_GENERATOR': return 'Table: {{table}}\n\nSchema:\n{{schema}}';
    case 'AI_PERF_PREDICTOR': return 'deploy.sql:\n{{deploySql}}\n\nTable stats:\n{{tableStats}}';
    case 'AI_PROMOTION_GATEKEEPER': return 'Change: {{changeName}}\n\nChecklist results:\n{{checklist}}';
    case 'AI_ENV_DIFF_EXPLAINER': return 'Diff data:\n{{diffData}}\n\nApplied change history:\n{{history}}';
    case 'AI_PROMOTION_ORDER': return 'Changes to order:\n{{changes}}';
    case 'AI_BLAST_RADIUS': return 'deploy.sql:\n{{deploySql}}\n\npg_depend results:\n{{pgDependRows}}';
    case 'AI_BLUE_GREEN_PLAN': return 'deploy.sql:\n{{deploySql}}';
    case 'AI_POST_DEPLOY_HEALTH': return 'deploy.sql:\n{{deploySql}}\n\nDiagnostic query results:\n{{diagnosticSql}}';
    case 'AI_COMPLIANCE_CHECKER': return 'Profiles: {{profiles}}\n\ndeploy.sql:\n{{deploySql}}';
    case 'AI_CONFLICT_RESOLVER': return 'ST migration SQL:\n{{stSql}}\n\nPROD migration SQL:\n{{prodSql}}';
    case 'AI_CANARY_ADVISOR': return 'deploy.sql:\n{{deploySql}}\n\nTable row estimate: {{tableRows}}';
    case 'AI_TICKET_LINKER': return 'Change names:\n{{changeNames}}\n\nGit log:\n{{gitLog}}';
  }
}

// ─── Simplified user prompt defaults (the real logic is in prompt-template.ts) ──

const FREEFORM_SQL_DEFAULT = `Target: PostgreSQL.

You are generating a DMCR change folder with deploy.sql, verify.sql, revert.sql.

🚨 IMPORTANT / HARD RULES:
1) Return ONLY valid JSON with keys: changeName, deploySql, verifySql, revertSql.
2) changeName MUST be lowercase snake_case.
3) verify.sql must be deterministic and gated by dmcr.change_log change_id = '__DMCR_CHANGE_ID__'.
4) revert.sql MUST NOT modify dmcr.change_log.
5) Apply danger_ prefix convention.

Deploy guidance:
- deploy.sql SHOULD be the user's SQL as-is.
- You MAY apply minimal syntactic fixes ONLY if needed.
- Do NOT add unrelated statements or change intent/semantics.

{{#if dbSchema}}
Database schema context:
- Default schema: {{dbSchema}}
- Use this schema to qualify unqualified names in verify.sql and revert.sql.
{{/if}}

{{#if deployRoutine}}
Detected routine change:
- Deploy defines {{deployRoutine}}
{{/if}}

{{#if changeNameHint}}
Change name hint: {{changeNameHint}}
{{/if}}

DEPLOY_SQL_START
{{sql}}
DEPLOY_SQL_END

{{#if previousSql}}
PREVIOUS_SQL_START
{{previousSql}}
PREVIOUS_SQL_END

Revert guidance: restore the previous version exactly.
{{/if}}

verify.sql requirements:
- Must be deterministic and dmcr.change_log gated.
- MUST NOT use ELSE blocks.

revert.sql requirements:
- Must undo deploy.sql as safely as possible.
- Prefer IF EXISTS / guards.`;


const ADD_COLUMNS_DEFAULT = `Target: PostgreSQL.

Action: {{tableAction}}
Tables: {{cleanTables}}

{{#if changeNameHint}}
Change name hint: {{changeNameHint}}
{{/if}}

Requirements:
- Generate DMCR deploy/verify/revert SQL.
- verify.sql must be deterministic and DMCR change_log gated.
- revert.sql should revert changes safely.
- Apply danger_ prefix convention.`;

const INSERT_ROWS_DEFAULT = `Target: PostgreSQL.

Insert rows into {{table}}:
Columns: {{columns}}

Rows:
{{rows}}

Idempotent: {{idempotent}}
{{#if idempotent}}
On conflict target: {{conflictTarget}}
On conflict action: {{conflictAction}}
{{/if}}

Requirements:
- Generate DMCR deploy/verify/revert SQL.
- verify.sql must be deterministic and DMCR change_log gated.
- revert.sql should delete inserted rows safely.
- Apply danger_ prefix convention.`;

const GIT_COMMIT_MESSAGE_DEFAULT = `You are a git commit message generator for DMCR (Database Migration Change Record) projects.

Given information about a DMCR change folder and its SQL content, generate a concise, conventional commit message.

Rules:
1. Use conventional commits format: type(scope): description
2. Type should be one of: feat, fix, refactor, chore, docs, perf
3. Scope should be the schema or table name if identifiable, otherwise "db"
4. Description should be lowercase, max 72 chars, no period at end
5. If the deploy SQL contains CREATE TABLE → use "feat"
6. If the deploy SQL contains ALTER TABLE → use "feat" for adding, "refactor" for modifying
7. If the deploy SQL contains DROP → use "refactor" or "chore"
8. If the deploy SQL contains INSERT/UPDATE/DELETE → use "chore(data)"
9. If the deploy SQL contains CREATE FUNCTION/VIEW/TRIGGER → use "feat"
10. Return ONLY the commit message as plain text — no JSON, no quotes, no explanation.

Example outputs:
- feat(app): add email column to users table
- feat(wfm): create chat_metrics table
- refactor(public): rename status column to state in orders
- chore(data): seed initial config values`;

// ─── DB operations ──────────────────────────────────────────────────────────

type SqliteDb = {
  prepare: (sql: string) => { run: (...a: unknown[]) => void; get: (...a: unknown[]) => Record<string, unknown> | undefined; all: (...a: unknown[]) => Array<Record<string, unknown>> };
  exec: (s: string) => void;
};

let _db: SqliteDb | null = null;

export function initPromptLibraryDb(db: SqliteDb | null): void {
  _db = db;
  if (!_db) return;
  _db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_library (
      scenario      TEXT PRIMARY KEY,
      system_prompt TEXT NOT NULL,
      user_prompt   TEXT,
      agent_name    TEXT,
      variables     TEXT,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  // Migrate: add agent_name column if missing (existing installs)
  try {
    _db.exec(`ALTER TABLE prompt_library ADD COLUMN agent_name TEXT`);
  } catch { /* column already exists */ }
  // Migrate: add user_prompt column if missing (existing installs)
  try {
    _db.exec(`ALTER TABLE prompt_library ADD COLUMN user_prompt TEXT`);
  } catch { /* column already exists */ }
  // Migrate: add variables column if missing (existing installs)
  try {
    _db.exec(`ALTER TABLE prompt_library ADD COLUMN variables TEXT`);
  } catch { /* column already exists */ }
}

/** Default agent display names used in progress text */
export const DEFAULT_AGENT_NAMES: Record<PromptScenario, string> = {
  DMCR_RULES: 'DMCR Agent',
  INTENT_DETECTOR: 'Intent Detector',
  REQUEST_PLANNER: 'Request Planner',
  FOLLOWUP_DECIDER: 'Follow-up Decider',
  FREEFORM_SQL: 'Freeform SQL',
  ADD_COLUMNS: 'DDL Builder',
  INSERT_ROWS: 'DML Builder',
  MASTER_AGENT: 'Master Agent',
  GREETING_AGENT: 'Greeting Agent',
  GENERAL_FAQ_AGENT: 'General FAQ Agent',
  SQL_FAQ_AGENT: 'SQL FAQ Agent',
  SQL_REFINE_AGENT: 'SQL Refine Agent',
  WIKI_AGENT: 'Wiki Agent',
  MCP_AGENT: 'MCP Agent',
  MCP_TOOL_AGENT: 'MCP Tool Agent',
  DIALOGUE_INTENT: 'Dialogue Intent Resolver',
  GIT_COMMIT_MESSAGE: 'Git Commit Agent',
  SCHEMA_DRIFT_SUMMARY: 'Schema Drift Analyst',
  AI_CHANGE_EXPLAINER: 'Change Explainer',
  AI_RISK_SCORER: 'Risk Scorer',
  AI_SCHEMA_DOCUMENTER: 'Schema Documenter',
  AI_ROLLBACK_ADVISOR: 'Rollback Advisor',
  AI_DEPENDENCY_ANALYZER: 'Dependency Analyzer',
  AI_CHANGELOG_GENERATOR: 'Changelog Generator',
  AI_DEAD_COLUMN_DETECTOR: 'Dead Column Detector',
  AI_SQL_POLICY_GUARD: 'SQL Policy Guard',
  AI_SEMANTIC_VERSION: 'Semantic Version Classifier',
  AI_DRIFT_DETECTIVE: 'Drift Detective',
  AI_TEST_DATA_GENERATOR: 'Test Data Generator',
  AI_PERF_PREDICTOR: 'Perf Impact Predictor',
  AI_PROMOTION_GATEKEEPER: 'Promotion Gatekeeper',
  AI_ENV_DIFF_EXPLAINER: 'Env Diff Explainer',
  AI_PROMOTION_ORDER: 'Promotion Order Optimizer',
  AI_BLAST_RADIUS: 'Blast Radius Estimator',
  AI_BLUE_GREEN_PLAN: 'Blue/Green Planner',
  AI_POST_DEPLOY_HEALTH: 'Post-Deploy Health Check',
  AI_COMPLIANCE_CHECKER: 'Compliance Checker',
  AI_CONFLICT_RESOLVER: 'Conflict Resolver',
  AI_CANARY_ADVISOR: 'Canary Rollout Advisor',
  AI_TICKET_LINKER: 'Ticket Linker',
};

export type PromptLibraryEntry = {
  scenario: PromptScenario;
  label: string;
  description: string;
  prompt: string;
  userPrompt: string;
  agentName: string;
  isCustomized: boolean;
  variables: ScenarioVarMap;
  updatedAt: string | null;
};

/** Get all prompts — DB overrides merged with defaults */
export function getAllPrompts(): PromptLibraryEntry[] {
  const dbRows = _getDbRows();
  return ALL_SCENARIOS.map(scenario => {
    const dbRow = dbRows[scenario];
    const dbVars = _parseVarsJson(dbRow?.variables);
    return {
      scenario,
      label: SCENARIO_LABELS[scenario],
      description: SCENARIO_DESCRIPTIONS[scenario],
      prompt: dbRow?.system_prompt ?? getDefaultPromptText(scenario),
      userPrompt: dbRow?.user_prompt ?? getDefaultUserPromptText(scenario),
      agentName: dbRow?.agent_name ?? DEFAULT_AGENT_NAMES[scenario],
      isCustomized: !!dbRow,
      variables: dbVars ?? SCENARIO_VARIABLES[scenario],
      updatedAt: dbRow?.updated_at ?? null,
    };
  });
}

/** Get the agent display name for a scenario (DB first, then default) */
export function getAgentName(scenario: PromptScenario): string {
  if (!_db) return DEFAULT_AGENT_NAMES[scenario];
  try {
    const row = _db.prepare('SELECT agent_name FROM prompt_library WHERE scenario = ?').get(scenario) as { agent_name: string | null } | undefined;
    return row?.agent_name ?? DEFAULT_AGENT_NAMES[scenario];
  } catch {
    return DEFAULT_AGENT_NAMES[scenario];
  }
}

/** Get a single prompt (DB first, then default) */
export function getPrompt(scenario: PromptScenario): string {
  if (!_db) return getDefaultPromptText(scenario);
  try {
    const row = _db.prepare('SELECT system_prompt FROM prompt_library WHERE scenario = ?').get(scenario) as { system_prompt: string } | undefined;
    return row?.system_prompt ?? getDefaultPromptText(scenario);
  } catch {
    return getDefaultPromptText(scenario);
  }
}

/**
 * Get a prompt with runtime variable substitution applied.
 * This is what agents should call at runtime — NOT the raw constants from prompt-template.ts.
 *
 * Substitutions:
 *   DMCR_RULES     — {{dangerContextPrompt}} → buildDangerContextPrompt()
 *   WIKI_AGENT     — {{context}} → wikiContext arg
 *   All others     — returned as-is from DB (or fallback)
 */
export function getResolvedPrompt(scenario: PromptScenario, vars?: Record<string, string>): string {
  const prompt = getPrompt(scenario);
  // Auto-inject scenario-specific runtime vars, then merge caller vars
  const autoVars: Record<string, string> = {};
  if (scenario === 'DMCR_RULES') {
    autoVars.dangerContextPrompt = buildDangerContextPrompt();
  }
  // Function resolvers for {{agentPool['X','Y',...]}} syntax
  const functionResolvers: Record<string, FunctionResolver> = {
    agentPool: createAgentPoolResolver(vars?.conversationId),
  };
  return resolvePromptTemplate(prompt, { ...autoVars, ...vars }, { functionResolvers, blankIfUnset: unsetVarsToBlank(scenario) });
}

/** Declared scenario variables that should read as empty when a caller does not pass them.
 *  toolList is excluded: callActiveLlm fills it in later from live MCP discovery. */
function unsetVarsToBlank(scenario: PromptScenario): string[] {
  return Object.keys(SCENARIO_VARIABLES[scenario] ?? {}).filter(k => k !== 'toolList');
}

/** Get the user prompt for a scenario with variable substitution applied. */
export function getResolvedUserPrompt(scenario: PromptScenario, vars?: Record<string, string>): string {
  const prompt = getUserPrompt(scenario);
  const functionResolvers: Record<string, FunctionResolver> = {
    agentPool: createAgentPoolResolver(vars?.conversationId),
  };
  return resolvePromptTemplate(prompt, vars ?? {}, { functionResolvers, blankIfUnset: unsetVarsToBlank(scenario) });
}

/** Get the raw user prompt (DB first, then default). */
export function getUserPrompt(scenario: PromptScenario): string {
  if (!_db) return getDefaultUserPromptText(scenario);
  try {
    const row = _db.prepare('SELECT user_prompt FROM prompt_library WHERE scenario = ?').get(scenario) as { user_prompt: string | null } | undefined;
    return row?.user_prompt ?? getDefaultUserPromptText(scenario);
  } catch {
    return getDefaultUserPromptText(scenario);
  }
}

/** Save a customized prompt */
export function savePrompt(scenario: PromptScenario, prompt: string, agentName?: string, userPrompt?: string, variables?: ScenarioVarMap): void {
  if (!_db) return;
  const varsJson = variables ? JSON.stringify(variables) : null;
  _db.prepare(`
    INSERT INTO prompt_library (scenario, system_prompt, user_prompt, agent_name, variables, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(scenario) DO UPDATE SET system_prompt = excluded.system_prompt, user_prompt = excluded.user_prompt, agent_name = excluded.agent_name, variables = excluded.variables, updated_at = excluded.updated_at
  `).run(scenario, prompt, userPrompt ?? null, agentName ?? DEFAULT_AGENT_NAMES[scenario], varsJson);
}

/** Reset a prompt to default (remove DB override) */
export function resetPrompt(scenario: PromptScenario): void {
  if (!_db) return;
  _db.prepare('DELETE FROM prompt_library WHERE scenario = ?').run(scenario);
}

// ─── Private helpers ────────────────────────────────────────────────────────

function _getDbRows(): Record<string, { system_prompt: string; user_prompt: string | null; agent_name: string | null; variables: string | null; updated_at: string }> {
  if (!_db) return {};
  try {
    const rows = _db.prepare('SELECT scenario, system_prompt, user_prompt, agent_name, variables, updated_at FROM prompt_library').all() as Array<{ scenario: string; system_prompt: string; user_prompt: string | null; agent_name: string | null; variables: string | null; updated_at: string }>;
    const out: Record<string, { system_prompt: string; user_prompt: string | null; agent_name: string | null; variables: string | null; updated_at: string }> = {};
    for (const r of rows) out[r.scenario] = { system_prompt: r.system_prompt, user_prompt: r.user_prompt, agent_name: r.agent_name, variables: r.variables, updated_at: r.updated_at };
    return out;
  } catch {
    return {};
  }
}

function _parseVarsJson(json: string | null | undefined): ScenarioVarMap | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ScenarioVarMap;
    return null;
  } catch {
    return null;
  }
}
