# DMCR Wiki (v1.1.0)

DMCR is a PostgreSQL-focused change management workflow inside the VS Code extension. It combines AI-assisted change generation with a transactional PowerShell runner so teams can generate, review, save, deploy, verify, and revert versioned SQL changes without leaving the editor.

## What DMCR is

DMCR is best understood as a hybrid of three ideas:

- a change-folder workflow similar to Flyway style versioned migrations
- a deploy/verify/revert contract with rollback discipline
- a UI-first authoring experience with Copilot-assisted generation

DMCR is not just a runner. It includes:

- structured builders for schema and data changes
- a conversation workflow for natural language change requests
- SQL linting before save
- a transactional runner for deploy and revert
- a change ledger and audit trail in PostgreSQL
- safety rails for dangerous SQL
- advisory locking to prevent concurrent deployments
- dependency-aware execution planning via meta.json
- checksum policies (warn, block, repair)
- JSON output for CI/CD integration
- baseline and repair commands for production onboarding
- repeatable migrations (R__* folders) for views, functions, triggers
- placeholder substitution (${name}) for environment-specific SQL
- release tags with deploy/revert targeting (@tag syntax)

## Core model

Every change lives in a numbered folder under the configured changes directory.

```text
changes_dir/
├── 001_create_users/
│   ├── deploy.sql
│   ├── verify.sql
│   ├── revert.sql
│   └── meta.json           # optional
├── 002_add_email_index/
│   ├── deploy.sql
│   ├── verify.sql
│   └── revert.sql
├── 003_seed_roles/
│   ├── deploy.sql
│   ├── verify.sql
│   └── revert.sql
├── R__user_summary_view/   # repeatable migration
│   ├── deploy.sql          # idempotent (CREATE OR REPLACE, etc.)
│   └── verify.sql          # optional
└── R__audit_triggers/
    └── deploy.sql
```

Rules:

- folder names must start with a 3-digit prefix such as `001_`, `002_`, `003_`
- repeatable folders start with `R__` — they re-run whenever their deploy.sql checksum changes
- folders are executed in alphabetical order (or dependency order when meta.json declares requires)
- every normal change folder must contain `deploy.sql`, `verify.sql`, and `revert.sql`
- repeatable folders only require `deploy.sql` (verify.sql optional, no revert.sql needed)
- folders containing `danger_` are treated as manual-only changes and are never executed automatically
- an optional `meta.json` can declare dependencies, tags, ticket, and author

## meta.json

Each change folder may include a `meta.json` file to declare dependencies and metadata:

```json
{
  "id": "002_add_email_index",
  "requires": ["001_create_users"],
  "tags": ["schema", "users"],
  "ticket": "JIRA-1234",
  "commit": "abc1234",
  "author": "jdoe"
}
```

Fields:

- `requires` — array of change_ids this change depends on. Used by `dmcr plan` for topological ordering.
- `tags` — informational labels for filtering and documentation
- `ticket` — external ticket reference, stored in change ledger on deploy
- `commit` — git commit SHA, auto-populated if not specified
- `author` — author name, stored in change ledger

When `requires` is present, `dmcr plan` uses topological sort (Kahn's algorithm) to determine execution order. Numeric prefixes remain as the fallback/display hint.

## Deploy, verify, revert

DMCR uses three files per change:

| File | Purpose |
|------|---------|
| `deploy.sql` | Applies the forward change |
| `verify.sql` | Verifies the expected end state |
| `revert.sql` | Reverses the change |

For each pending change, the runner behaves as follows:

1. Acquire a PostgreSQL advisory lock (prevents concurrent runners).
2. Run enhanced preflight checks (file presence, duplicate prefixes, dependency validation).
3. Begin a transaction.
4. Execute `deploy.sql`.
5. Insert the change record into `dmcr.change_log` with all checksums and metadata.
6. Commit.
7. Run `verify.sql` in a separate wrapped transaction.
8. If verify fails, auto-run `revert.sql` and remove the change log row.
9. Release the advisory lock.

Important design detail:

- deploy plus change-log insert is atomic (single transaction)
- revert plus change-log delete is atomic (single transaction)
- if deploy.sql fails, the transaction rolls back — **no change_log row is written**, but the failure IS recorded in `dmcr.event_log` with `status = 'failure'`
- every operation — success or failure — always produces an `event_log` entry
- verify runs separately so it can assert the committed state
- verify is executed inside a `BEGIN/ROLLBACK` wrapper so accidental side effects are not persisted
- advisory lock prevents two runners from deploying simultaneously

## Advisory locking

DMCR acquires a PostgreSQL advisory lock (`pg_try_advisory_lock`) before deploy or revert operations. This prevents two runner instances from modifying the database at the same time.

- Lock key: `3735928559` (0xDEADBEEF)
- Lock acquisition and release are logged in `dmcr.event_log`
- If the lock is held by another session, the runner fails fast with a clear error
- The lock is always released in a `finally` block, even on error

## Change ledger tables

The runner creates and uses the `dmcr` schema.

```sql
dmcr.change_log
  change_id         primary key
  applied_at        timestamp
  applied_by        user
  description       optional description
  deploy_checksum   sha256 of deploy.sql
  verify_checksum   sha256 of verify.sql
  revert_checksum   sha256 of revert.sql
  ticket_id         external ticket reference
  git_commit        git SHA at deploy time
  app_name          logical application name
  environment       dev | staging | prod
  actor             deploying principal

dmcr.event_log
  id
  event_ts
  action            deploy | revert | lock | unlock | repair | baseline
  change_id
  status            success | failure | warning | error
  message
  environment
  actor
  duration_ms       elapsed wall-clock time
```

### event_log coverage

Every operation in DMCR writes to `dmcr.event_log` — regardless of outcome. This includes:

- successful deploys and reverts
- failed deploys (SQL errors, constraint violations, timeout)
- failed verify (assertion failures)
- failed reverts
- lock acquisition and release
- lock contention (another runner holds the lock)
- repair and baseline operations
- preflight failures
- unexpected crashes or connection loss (logged on next successful connection)

This means `dmcr.event_log` is the single source of truth for "what happened" — even partial failures are recorded. The `status` column distinguishes `success`, `failure`, `warning`, and `error`.

The change ledger is not auto-created during deploy. You must run `dmcr init` once per database. Running `dmcr init` on an existing v0.x database is safe — it uses `ADD COLUMN IF NOT EXISTS` to migrate the schema.

## Checksum policy

DMCR stores SHA-256 checksums for all three SQL files (deploy, verify, revert) at deploy time. The `checksum_policy` config controls what happens when a checksum mismatch is detected during revert:

| Policy | Behavior |
|--------|----------|
| `warn` (default) | Log a warning and proceed with the revert |
| `block` | Stop with an error, require `dmcr repair --checksums` to reconcile |
| `repair` | Stop with an error, require explicit `dmcr repair --checksums` first |

Set in `dmcr.cfg`:

```ini
[dmcr]
checksum_policy = warn
```

Use `dmcr repair --checksums` to update stored checksums to match current files.

## Repeatable migrations

Repeatable migrations are folders starting with `R__` (e.g., `R__user_summary_view`). Unlike versioned changes, they:

- Re-run every time their `deploy.sql` checksum changes
- Have no `revert.sql` — they must be idempotent (use `CREATE OR REPLACE`, etc.)
- Are tracked in `dmcr.repeatable_log` by checksum, not applied/not-applied
- Are processed after all versioned changes during `dmcr deploy`
- Can also be run explicitly with `dmcr repeatable`

Use cases:
- Views that are redefined entirely each time
- Stored procedures and functions
- Triggers that need the latest definition
- Seed data that should always match a canonical state

Example:
```text
R__user_summary_view/
└── deploy.sql     # CREATE OR REPLACE VIEW user_summary AS SELECT ...
```

When you edit `deploy.sql` in a repeatable folder, the next `dmcr deploy` or `dmcr repeatable` detects the checksum change and re-executes it.

## Placeholders

DMCR supports `${placeholder_name}` variable substitution in SQL files. This lets you write environment-agnostic SQL and swap in the right values at deploy time.

Define placeholders in `dmcr.cfg`:

```ini
[placeholders]
schema_name    = myapp
default_tenant = 1
partition_count = 4
```

Use them in SQL files:
```sql
CREATE SCHEMA ${schema_name};
CREATE TABLE ${schema_name}.users (
    id SERIAL PRIMARY KEY,
    tenant_id INT DEFAULT ${default_tenant}
);
```

Resolution order (highest priority wins):
1. Environment variables: `DMCR_PLACEHOLDER_<NAME>` (case-insensitive key match)
2. Config file: `[placeholders]` section in `dmcr.cfg`

If any `${...}` token remains unresolved after substitution, the runner errors immediately (fail-fast, no silent corruption).

Overriding per environment:
```powershell
# Production deployment with a different schema
$env:DMCR_PLACEHOLDER_schema_name = "myapp_prod"
dmcr deploy

# Or inline for a one-off:
DMCR_PLACEHOLDER_schema_name=staging_app dmcr deploy
```

Why this matters:
- Same SQL files work across dev, staging, and production
- No need for separate change folders per environment
- Environment-specific values never get committed to source control

## Release tags

Tags are named deployment snapshots — like bookmarks on your change history. They let you deploy to or revert to a known-good state by name instead of remembering change IDs.

A tag always points to the **last applied change** at the moment it was created. It does not move — it is a fixed snapshot.

### Creating tags

```bash
# Deploy all pending changes
dmcr deploy                    # Applied: 001, 002, 003, 004, 005

# Bookmark this state as v1.0
dmcr tag create v1.0 "Sprint 42 release"
#   → Tag 'v1.0' created → 005_add_audit_log
#   The tag 'v1.0' now permanently points to change 005.

# Continue development — deploy more changes
dmcr deploy                    # Applied: 006, 007, 008
dmcr tag create v1.1 "Hotfix release"
#   → Tag 'v1.1' created → 008_fix_user_email
```

### Using tags for deployment targeting

```bash
# Deploy only up to a tagged state (useful for staging environments)
dmcr deploy --to @v1.0
#   → Applies 001 through 005, then stops.
#   Changes 006+ are NOT applied.

# Revert back to a tagged state
dmcr revert to @v1.0
#   → Reverts 008, then 007, then 006 (one at a time, in reverse order)
#   → Stops when the database state matches what v1.0 pointed to (change 005)
#   → Changes 001–005 remain applied
```

### What happens to tags when you revert?

Tags are **not deleted** when you revert past them. They remain as historical markers.

```bash
# Current state: changes 001–008 applied, tags v1.0→005, v1.1→008

dmcr revertLast
#   → Reverts 008 (the email column fix)
#   → Tag v1.1 still exists, still points to 008
#   → But 008 is no longer applied — the tag is now "orphaned"
#   → The database state is at change 007

# You can re-deploy to restore the tag's state:
dmcr deploy --to @v1.1
#   → Re-applies 008, bringing the database back to what v1.1 represents
```

Key rule: **tags are stable references, not live pointers**. Reverting does not remove or move tags. The tag still says "v1.1 = change 008" even if 008 is currently reverted. This is intentional — tags are deployment history, not database state.

### Managing tags

```bash
dmcr tag list                  # Show all tags with their change_ids and descriptions
dmcr tag create hotfix-1       # Tag current state (last applied change)
dmcr tag delete old-release    # Remove a tag you no longer need
```

### Tag naming rules

Tag names must be alphanumeric: letters, digits, dots, dashes, and underscores. Examples: `v1.0`, `sprint-42`, `hotfix_2026.05`, `pre-migration`.

### Practical scenarios

**Scenario 1: Release and rollback**
```bash
dmcr deploy                              # Ship all changes
dmcr tag create v2.1 "Added email column"
# Production bug found!
dmcr revertLast                          # Undo latest change
# Tag v2.1 still exists → you can redeploy to it later:
dmcr deploy --to @v2.1                   # Re-apply the reverted change
```

**Scenario 2: Staged rollout**
```bash
# In staging:
dmcr deploy --to @v2.0
# Verify everything works, then in production:
dmcr deploy --to @v2.0
```

**Scenario 3: Emergency revert to last known good**
```bash
dmcr revert to @v1.0
# Database is back to the state when v1.0 was tagged
# All changes after 005 are reverted
```

Tags are stored in `dmcr.tags` and do not affect execution order — they are purely a targeting and bookmarking mechanism.

## Runner commands

The PowerShell runner lives at `scripts/runner/dmcr.ps1`.

### Core commands

- `dmcr init` creates the `dmcr` schema and tables (safe to re-run on v0.x databases)
- `dmcr deploy` applies all pending changes in order with advisory locking
- `dmcr deploy --to <id|@tag>` deploys only up to a specific change or tagged state
- `dmcr deploy --dry-run` shows what would be applied without touching the database
- `dmcr status` shows applied and pending folders
- `dmcr verify` runs `verify.sql` for the latest applied change
- `dmcr verify all` runs `verify.sql` for every applied change in order
- `dmcr verify <change_id>` runs `verify.sql` for a specific applied change
- `dmcr parse "<sql>"` validates SQL inside a rolled-back transaction
- `dmcr repeatable` applies all repeatable migrations (R__*) with changed checksums

### Revert commands

- `dmcr revert <change_id>` reverts a specific change if and only if it is the latest applied
- `dmcr revert to <change_id|@tag>` peels back one change at a time until the target is reverted
- `dmcr revert list` shows applied changes in reverse chronological order
- `dmcr revertLast` reverts the latest applied change

### Inspect commands

- `dmcr history` shows applied changes with timestamps, checksums, actor, environment
- `dmcr info` shows environment summary, pending/applied counts, ledger health
- `dmcr plan` shows dependency-aware execution order (reads meta.json)
- `dmcr check` runs preflight validation without deploying
- `dmcr show config` prints the active configuration with the connection redacted

### Tag commands

- `dmcr tag` or `dmcr tag list` lists all release tags
- `dmcr tag create <name> [description]` tags the current deployment state
- `dmcr tag delete <name>` removes a tag

### Repair commands

Repair commands modify the change ledger without running SQL. Only use these when the ledger is out of sync with the actual database state (e.g. after manual `psql` changes or database restores).

- `dmcr baseline <change_id>` marks all changes up to and including the target as applied without executing SQL
- `dmcr repair --mark-applied <change_id>` manually marks a specific change as applied
- `dmcr repair --mark-reverted <change_id>` removes a change from the change ledger without executing revert
- `dmcr repair --checksums` reconciles stored checksums with current files on disk

### Global options

- `--debug` enables verbose logs (or set `DMCR_DEBUG=1`)
- `--dry-run` is supported for `deploy`
- `--to <id|@tag>` stops deploy/revert at a specific change or tag
- `--json` machine-readable JSON output (status, deploy, verify, history, info, plan, check)
- `-c` or `--config` sets a custom config file path

### Environment variables

- `DMCR_CONN` overrides the connection string
- `DMCR_CONFIG` overrides the config file path
- `DMCR_PSQL` overrides the psql executable path
- `DMCR_DEBUG` enables debug mode
- `DMCR_ACTOR` overrides the actor name for audit logging
- `DMCR_PLACEHOLDER_<name>` — override placeholder values per environment (e.g. `DMCR_PLACEHOLDER_schema_name=prod_app`)

## Preflight checks

The `dmcr check` command (and automatic preflight before `deploy`) validates:

- all non-danger_ folders have deploy.sql, verify.sql, revert.sql
- no duplicate numeric prefixes (e.g., two folders starting with `003_`)
- folder names match the expected format (`NNN_descriptive_name`)
- no prefix gaps (e.g., 001, 002, 004 missing 003)
- all meta.json `requires` references point to existing folders
- dependency graph has no circular dependencies

## Runner tab quick reference

The Runner tab is a terminal-style UI over the same runner. It currently supports:

### Slash commands

- `/status`
- `/deploy`
- `/deploy --dry-run`
- `/verify`
- `/verify all`
- `/history`
- `/info`
- `/plan`
- `/check`
- `/parse <sql>`
- `/revertLast`
- `/revert list`
- `/revert <id>`
- `/revert to <id>`
- `/baseline <id>`
- `/init`
- `/config`
- `/ls [pattern]`
- `/it`
- `/help`
- `/clear`

### Runner tab features

- command history with up and down arrows
- command suggestions for slash commands
- preset action buttons for common commands
- `/ls` tree view for change folders and SQL files
- `/it` interactive revert flow for choosing a change and revert action
- ANSI-colored output from the PowerShell runner
- configurable script path selection from the UI

What `/it` does:

- lists change folders
- lets you move with arrow keys
- lets you choose either `revert <id>` or `revert to <id>`

## Configuration

DMCR reads an INI-style config file, by default `dmcr.cfg` next to `dmcr.ps1`.

```ini
[dmcr]
env               = dev
changes_dir       = C:\path\to\db\changes
psql_path         = C:\path\to\psql.exe
lock_timeout      = 30s
statement_timeout = 5min
checksum_policy   = warn

[dev]
conn = postgresql://user:pass@host:5432/mydb?sslmode=require

[prod]
conn =
```

Overrides:

- `DMCR_CONN` overrides the active section's `conn`
- `DMCR_CONFIG` overrides the config file path
- `DMCR_PSQL` overrides the configured `psql_path`
- `DMCR_ACTOR` overrides the actor name for audit trails

Notes:

- `changes_dir` can be relative; the runner resolves it relative to the config file directory
- passwords are redacted in logged output
- `lock_timeout` and `statement_timeout` are applied to runner SQL sessions
- `checksum_policy` controls mismatch behavior: `warn` (default), `block`, or `repair`

## Dangerous operations and danger_ folders

DMCR has a safety gate for destructive SQL.

Blocked patterns in normal deploys include operations such as:

- `TRUNCATE`
- `DROP TABLE`
- `DROP SCHEMA`
- `DROP DATABASE`
- `DROP FUNCTION`
- `DROP PROCEDURE`
- `DROP VIEW`
- `DROP TRIGGER`
- `DROP INDEX`
- `DROP SEQUENCE`
- `DROP TYPE`
- `DROP EXTENSION`
- `DELETE` without `WHERE`

Behavior:

- dangerous SQL in a normal folder is blocked before execution
- the runner suggests renaming the folder to include `danger_`
- `danger_` folders are skipped during deploy
- `danger_` folders are hard-blocked during revert
- dangerous changes are expected to be reviewed and run manually by a DBA

This pattern is one of the strongest parts of DMCR because it makes the safe path explicit instead of silently trusting every generated migration.

## SQL parse mode

`dmcr parse` validates SQL by wrapping it in a transaction and rolling it back.

Use cases:

- fast syntax validation
- checking generated SQL before save or before manual execution
- catching parse errors with line information

Limitations:

- explicit transaction control like `BEGIN`, `COMMIT`, or `ROLLBACK` is rejected
- sequence increments from `nextval()` are not rolled back by PostgreSQL semantics

## JSON output mode

Use `--json` with any inspect command for machine-readable output:

```bash
dmcr status --json
dmcr deploy --json
dmcr history --json
dmcr info --json
dmcr plan --json
dmcr check --json
dmcr verify all --json
```

JSON payloads are stable and designed for CI/CD pipeline integration.

## Baseline and repair

### Baseline

Use `dmcr baseline <change_id>` when adopting DMCR on an existing database where changes have already been applied manually:

```bash
dmcr baseline 005_add_indexes
```

This marks changes 001 through 005 as applied without executing any SQL. Each baselined change is logged in `event_log` with action `baseline`.

### Repair

Repair commands modify the change ledger without running SQL. Only use these when the ledger is out of sync with the actual database state (e.g. after manual `psql` changes or database restores).

Use `dmcr repair` for surgical corrections:

- `--mark-applied <id>` — mark a single change as applied without executing it
- `--mark-reverted <id>` — remove a change from the change ledger without running revert.sql
- `--checksums` — update all stored checksums to match current files on disk

All repair actions are logged in `event_log` with action `repair`.

## DMCR extension workflows

DMCR supports multiple ways to produce change folders.

### Builder workflows

- schema builder for table and column changes
- DML builder for insert-style data changes
- freeform SQL for broader migration requests
- schema diff and bootstrap workflows where available in the extension

### Conversation workflow

The conversation interface supports:

- plain-English change requests
- follow-up refinement across multiple turns
- wiki-backed answers for how DMCR works
- social and greeting handling for basic chat messages

### Save flow

After generation, review the SQL, check lint output, then save the change folder into your workspace changes directory.

## Agent Pool

The DMCR extension uses an **Agent Pool** — a centralized registry of specialized AI agents that can delegate work to each other. The architecture mirrors MCP tool discovery: agents are described in a prompt fragment, and the calling agent can invoke them by name.

### How it works

1. The `{{agentPool}}` template variable is injected into agent system prompts (DMCR_RULES, SQL_FAQ_AGENT, etc.).
2. At runtime, `buildAgentPoolPrompt()` generates a text listing of all available agents, their descriptions, and parameters.
3. When an agent decides to delegate, it includes an `agentPoolCall` object in its JSON response:
   ```json
   { "agentPoolCall": { "agent": "SQL_REFINE", "params": { "userMessage": "add an index on email column" } } }
   ```
4. The handler detects this, calls `executeAgentPoolCall()`, and forwards the delegated agent's response back to the user.
5. Every delegation is logged to `ce_audit` with stage `AGENT_POOL_<AGENT_ID>` for full traceability.

### Registered agents

| Agent ID | Name | Description |
|----------|------|-------------|
| `SQL_REFINE` | SQL Refine Agent | Modifies previously generated DMCR change SQL based on follow-up requests. Only available when prior SQL exists in the conversation. |
| `WIKI` | Wiki Agent | Searches DmcrWiki.md documentation and answers how-to questions about DMCR features, commands, and workflows. |
| `SQL_FAQ` | SQL FAQ Agent | Answers database/SQL-related questions with live schema awareness (table structures, column types, indexing, PostgreSQL best practices). |
| `GENERAL_FAQ` | General FAQ Agent | Answers general questions about DMCR concepts, features, forms, and workflow. |
| `GIT_COMMIT` | Git Commit Agent | Generates conventional commit messages for DMCR change folders. |
| `FREEFORM_SQL` | Freeform SQL Agent | Wraps raw SQL into a full DMCR change package (deploy/verify/revert/meta.json). |
| `SCHEMA_DIFF` | Schema Diff Agent | Generates migration SQL (deploy/verify/revert) from two schema states (FROM → TO). |
| `DMCR_GENERATE` | DMCR Agent | Core SQL generation engine — generates a full DMCR change from a natural-language request. |
| `ADD_COLUMNS` | DDL Builder Agent | Generates DDL statements (ALTER TABLE, CREATE TABLE, CREATE SEQUENCE, GRANT). |
| `INSERT_ROWS` | DML Builder Agent | Generates INSERT statements with optional ON CONFLICT idempotency. |
| `INTENT_DETECTOR` | Intent Detector Agent | Classifies user requests into DMCR intents (ADD_COLUMN, CREATE_TABLE, etc.) and detects risks. |
| `REQUEST_PLANNER` | Request Planner Agent | Decides whether to generate SQL immediately or ask clarifying questions first. |
| `FOLLOWUP_DECIDER` | Follow-up Decider Agent | Interprets user replies to follow-up questions and decides the next action. |
| `MASTER_AGENT` | Master Agent | Routes user messages to the correct specialized agent (top-level dispatcher). |
| `GREETING_AGENT` | Greeting Agent | Responds to greetings and social messages, redirects to DMCR capabilities. |
| `MCP_AGENT` | MCP Agent | Orchestrates MCP tool calls for live database schema access. |
| `DIALOGUE_INTENT` | Dialogue Intent Resolver | Pre-processes follow-up questions into standalone queries using conversation history. |

### Agent routing

- The **Master Agent** classifies user messages and routes to the correct agent (GREETING, FAQ, WIKI, SQL_REFINE, or DMCR generation).
- Within the **SQL FAQ Agent** and **DMCR Rules** prompt, the `{{agentPool}}` block enables cross-agent delegation (e.g. SQL FAQ can delegate to SQL_REFINE when the user wants to modify existing SQL).
- **SQL_REFINE** is only listed when prior SQL exists in the conversation (conditional availability).

### Adding a new agent to the pool

1. Add an entry to `AGENT_REGISTRY` in `src/services/agent-pool.ts` with id, name, description, and params.
2. Add a `case` in `executeAgentPoolCall()` that resolves the prompt, calls `callActiveLlm`, and logs to audit.
3. Add the agent's scenario to `AGENT_POOL_SCENARIO_MAP` (maps pool ID → PromptScenario).
4. The Prompt Library UI will automatically show the Agent Pool chip for the scenario.

## Prompt Library

The Prompt Library is the centralized configuration panel for all AI agent prompts in the DMCR extension. Every agent, form, and utility prompt can be viewed, edited, and customized.

### Accessing the Prompt Library

Open the DMCR panel → Settings → **Prompt Library** tab. The panel has a resizable sidebar (drag the splitter or click to collapse, keyboard shortcut `Alt+B`).

### Structure

Prompts are organized into categories:

- **Routing & Conversation**: DIALOGUE_INTENT, MASTER_AGENT, GREETING_AGENT, GENERAL_FAQ_AGENT, SQL_FAQ_AGENT, SQL_REFINE_AGENT, WIKI_AGENT, MCP_AGENT
- **SQL Generation**: DMCR_RULES, INTENT_DETECTOR, REQUEST_PLANNER, FOLLOWUP_DECIDER
- **Forms**: ADD_COLUMNS, INSERT_ROWS, FREEFORM_SQL, SCHEMA_DIFF
- **Git & Version Control**: GIT_COMMIT_MESSAGE

Each prompt entry has:
- **System prompt** — the main instruction text sent as the system message
- **User prompt** — the template for the user message (contains `{{variables}}`)
- **Agent name** — customizable display name shown in the conversation UI
- **Variables** — template variables (`{{varName}}`) that are resolved at runtime

### Template variables

Variables use `{{double-brace}}` syntax and are resolved before sending to the LLM:

- `{{dangerContextPrompt}}` — auto-generated danger pattern rules
- `{{toolList}}` — discovered MCP tools
- `{{agentPool}}` — available agent pool entries
- `{{userMessage}}` — the user's input
- `{{conversationHistory}}` — recent conversation turns
- `{{previousDeploySql}}`, `{{previousVerifySql}}`, etc. — prior SQL for refinement

Variables are defined per-scenario in the `SCENARIO_VARIABLES` map. Adding a new `{{variable}}` to prompt text auto-detects it on save.

### Customization

- **Edit** the system or user prompt text directly in the editor pane.
- **Insert variables** by clicking variable chips in the sidebar.
- **Save** persists your customization to the local SQLite database.
- **Reset** reverts to the built-in default prompt.
- Customized prompts show an "edited" badge in the sidebar.

### UI indicators

- **Scenario chip** (colored) — shows the prompt scenario ID (e.g. `SQL_REFINE_AGENT`)
- **Agent Pool chip** (green) — indicates this prompt's agent is registered in the Agent Pool and can be delegated to by other agents
- **edited badge** — indicates the prompt has been customized from its default

### Prompt resolution flow

1. `getResolvedPrompt(scenario, vars)` loads the prompt (custom or default).
2. All `{{variables}}` are substituted using the provided vars map.
3. Auto-injected vars (like `dangerContextPrompt` for DMCR_RULES) are merged first, then caller vars override.
4. The resolved text is sent as the system prompt to the active LLM.

## Linting and validation

DMCR lints generated SQL before save using PostgreSQL parsing. This catches syntax issues early, before the runner touches the database.

Recommended workflow:

1. Generate the change.
2. Review deploy, verify, and revert SQL.
3. Fix lint errors.
4. Save the change folder.
5. Run `dmcr check` to validate folder structure and dependencies.
6. Run `dmcr deploy --dry-run`.
7. Run `dmcr deploy`.
8. Run `dmcr status` and, if needed, `dmcr verify all`.

## Tips and best practices

- keep changes small and single-purpose
- keep verify scripts assertion-focused, not mutation-heavy
- make revert scripts explicit and readable
- prefer additive migrations for production safety
- test dangerous changes manually in lower environments first
- use `deploy --dry-run` during review and change-approval steps
- treat `danger_` as a governance mechanism, not just a naming convention
- do not edit `deploy.sql` after application unless you are prepared to reconcile checksum drift
- use `meta.json` to declare dependencies when changes depend on each other
- use `dmcr baseline` when adopting DMCR on existing databases
- use `--json` in CI/CD pipelines for stable machine-readable output
- set `checksum_policy = block` in production environments for maximum safety

## DMCR compared with Flyway

DMCR is closest to Flyway in folder-based ordered versioning.

Where DMCR is strong:

- explicit `deploy.sql`, `verify.sql`, and `revert.sql` contract
- automatic revert on verify failure
- danger-gated manual path for destructive work
- UI-first authoring in VS Code
- local Runner tab for operational use
- advisory locking for concurrent safety
- dependency-aware execution planning
- checksum policies for drift detection
- JSON output for CI/CD integration
- baseline and repair commands for production onboarding
- repeatable migrations (R__* folders) for views, functions, triggers
- placeholder substitution (${name}) for environment-specific SQL
- release tags with deploy/revert targeting

Where Flyway is stronger today:

- broader ecosystem maturity
- multi-database support beyond PostgreSQL
- richer CI and enterprise adoption patterns

## DMCR compared with Sqitch

Sqitch is stronger in mature team workflow patterns.

Where DMCR is simpler and easier:

- lower learning curve
- more approachable for teams used to migration folders
- clearer UI for generation and review
- faster onboarding for app teams working entirely in VS Code

Where Sqitch is stronger today:

- richer tagging model with branch-aware planning across long-lived feature branches
- more mature multi-environment targeting (deploy per-branch subsets)

## Is the framework solid?

Yes. DMCR now covers the full operational surface that production teams need:

- transactional deploy and revert
- explicit verification
- reversible changes with checksum enforcement
- dependency-aware ordering (meta.json + topological sort)
- repeatable migrations for views and functions
- placeholder substitution for multi-environment SQL
- release tags for deployment targeting
- advisory locking for concurrent safety
- baseline and repair for existing database onboarding
- JSON output for CI/CD integration
- strong safety rails for destructive SQL
- integrated authoring inside VS Code

The remaining differences with Flyway and Sqitch are scope (multi-database) and ecosystem size, not missing capabilities.


## Practical usage recipe

### New database

1. Configure `dmcr.cfg`.
2. Run `dmcr init`.
3. Generate and save a change folder.
4. Run `dmcr deploy --dry-run`.
5. Run `dmcr deploy`.
6. Check `dmcr status`.

### Existing project

1. Decide the canonical `changes_dir`.
2. Create numbering conventions and review rules.
3. Initialize the change ledger in lower environments first.
4. Standardize verify patterns and danger_ usage.
5. Add Runner tab usage and dry-run checks to team workflow.

## FAQ

### Does DMCR auto-create its change ledger during deploy?

No. You must explicitly run `dmcr init`.

### Does verify run before deploy?

No. Verify runs after deploy and after revert checks, wrapped in a rollback transaction.

### Can DMCR revert any arbitrary old change?

No. Single-change revert only works for the latest applied change. `revert to` peels from the top one change at a time.

### Does DMCR support manual-only migrations?

Yes. Use `danger_` in the folder name. Those are intentionally excluded from automatic execution.

### Is DMCR production-safe?

It can be production-safe if you keep changes disciplined, use dry-runs, review dangerous operations carefully, and add stronger concurrency and audit controls over time.