/**
 * Where each prompt of the Prompt Library is used in DMCR, and when it runs: read from the code
 * (the handler that resolves the prompt and the UI control that triggers it), not guessed.
 * `unused`: the prompt exists but nothing calls it.
 */
export type PromptUsage = { where: string; when: string; unused?: boolean };

export const PROMPT_USAGE: Record<string, PromptUsage> = {
  DMCR_RULES: { where: 'Assistant metadata form · DDL / DML / Freeform', when: 'The main generation prompt: when a form is generated or the Assistant\'s metadata form is confirmed.' },
  INTENT_DETECTOR: { where: 'VS Code Copilot Chat · @dmcr', when: 'Classifies a new @dmcr request in VS Code\'s own chat. DMCR Web does not call it.' },
  REQUEST_PLANNER: { where: 'VS Code Copilot Chat · @dmcr', when: 'On a new @dmcr request: generate now, or ask clarifying questions first (VS Code chat only).' },
  FOLLOWUP_DECIDER: { where: 'VS Code Copilot Chat · @dmcr', when: 'Reads your answer to a @dmcr follow-up question (VS Code chat only).' },
  FREEFORM_SQL: { where: 'Freeform · Generate DMCR request', when: 'Names the agent in the progress text and the audit log; the SQL itself comes from DMCR Agent.' },
  ADD_COLUMNS: { where: 'DDL · Generate DMCR request', when: 'Names the agent in the progress text and the audit log; the SQL itself comes from DMCR Agent.' },
  INSERT_ROWS: { where: 'DML · Generate DMCR request', when: 'Names the agent in the progress text and the audit log; the SQL itself comes from DMCR Agent.' },
  MASTER_AGENT: { where: 'Assistant · every message', when: 'Routes each chat message to the right agent: greeting, FAQ, SQL FAQ, wiki, refine, MCP tool or DMCR.' },
  GREETING_AGENT: { where: 'Assistant · greetings', when: 'Replies when the message is a greeting.' },
  GENERAL_FAQ_AGENT: { where: 'Assistant · DMCR questions', when: 'Answers questions about DMCR\'s features and how to use them.' },
  SQL_FAQ_AGENT: { where: 'Assistant · SQL questions', when: 'Answers SQL, schema and database questions; can hand off to another agent.' },
  SQL_REFINE_AGENT: { where: 'Assistant · refine the last change', when: 'Edits the change generated earlier in the conversation when you ask for a modification.' },
  WIKI_AGENT: { where: 'Assistant · docs questions', when: 'Answers DMCR documentation questions from the wiki sections it finds.' },
  MCP_AGENT: { where: 'Assistant · agent hand-off', when: 'Runs only when another agent hands a question to it; no button triggers it directly.' },
  MCP_TOOL_AGENT: { where: 'Assistant · live database questions', when: 'Calls MCP tools for questions about the live database; also summarises drift when you pick a server.' },
  DIALOGUE_INTENT: { where: 'Assistant · follow-up messages', when: 'Turns a follow-up message into a standalone question once the chat has history.' },
  GIT_COMMIT_MESSAGE: { where: 'Change card Save · Home / Runner Sync', when: 'Writes the commit message for auto-commit when a change is saved, and for Sync.' },
  SCHEMA_DRIFT_SUMMARY: { where: 'Schema Diff · Compare', when: 'After two servers are compared, summarises the drift.' },
  AI_CHANGE_EXPLAINER: { where: 'Runner · recent runs · Explain', when: 'Explains in plain English what a past run\'s change did.' },
  AI_RISK_SCORER: { where: 'Runner · deploy --dry-run · risk', when: 'Scores the risk of each change in a deploy dry-run result.' },
  AI_SCHEMA_DOCUMENTER: { where: 'Schema Explorer · Document Schema', when: 'Right-click a schema: writes markdown docs for its tables, views and functions.' },
  AI_ROLLBACK_ADVISOR: { where: 'Runner · recent runs · Revert', when: 'Advises how to roll back a past run\'s change safely.' },
  AI_DEPENDENCY_ANALYZER: { where: 'Assistant change card · Deps', when: 'Finds which existing changes a generated change depends on and suggests "requires".' },
  AI_CHANGELOG_GENERATOR: { where: 'Runner · recent runs · Gen Changelog', when: 'Writes a markdown changelog from the successful runs in the history.' },
  AI_DEAD_COLUMN_DETECTOR: { where: 'Schema Explorer · Detect Dead Columns', when: 'Right-click a schema: flags columns that look unused.' },
  AI_SQL_POLICY_GUARD: { where: 'Assistant change card · Runner Gate', when: 'Checks deploy SQL against SQL Policies when a change card shows, and in the Gate check.' },
  AI_SEMANTIC_VERSION: { where: 'Assistant change card · semver badge', when: 'No AI call: the PATCH / MINOR / MAJOR badge comes from a pattern match in the UI.', unused: true },
  AI_DRIFT_DETECTIVE: { where: 'Schema Diff · Drift Check', when: 'Checks drift between the selected source and target servers.' },
  AI_TEST_DATA_GENERATOR: { where: 'Not used yet', when: 'Nothing calls this prompt; the "Seed test data" chip goes through normal chat routing.', unused: true },
  AI_PERF_PREDICTOR: { where: 'Runner · status · Perf', when: 'Predicts the lock type, duration and traffic impact of one change.' },
  AI_PROMOTION_GATEKEEPER: { where: 'Runner · status · Gate / Gate all', when: 'GO / BLOCKED pre-flight check before a pending change is promoted to prod.' },
  AI_ENV_DIFF_EXPLAINER: { where: 'Schema Diff · Explain Diff', when: 'After a compare, explains why the two environments diverged.' },
  AI_PROMOTION_ORDER: { where: 'Runner · status · Optimize order', when: 'Suggests the safest order to apply two or more pending changes.' },
  AI_BLAST_RADIUS: { where: 'Runner · status · Blast', when: 'Estimates what else a change locks or breaks, from pg_depend through MCP.' },
  AI_BLUE_GREEN_PLAN: { where: 'Runner · status · Blue/Green', when: 'Splits a breaking change into two zero-downtime phases.' },
  AI_POST_DEPLOY_HEALTH: { where: 'Runner · status · Health', when: 'Writes and runs read-only health checks for a change against the database.' },
  AI_COMPLIANCE_CHECKER: { where: 'Runner · status · Compliance', when: 'Checks a change\'s deploy.sql against GDPR, SOC 2 and HIPAA rules.' },
  AI_CONFLICT_RESOLVER: { where: 'Schema Diff · diff view · AI resolve', when: 'Merges an object\'s differing source and target DDL into SQL that keeps both.' },
  AI_CANARY_ADVISOR: { where: 'Runner · status · Canary', when: 'Advises whether and how to roll out a large-table change gradually.' },
  AI_TICKET_LINKER: { where: 'Runner · recent runs · Link Tickets', when: 'Links the changes in the run history to Jira / Linear tickets.' },
};
