# dmcr

`dmcr` is a VS Code GitHub Copilot Chat participant (`@dmcr`) that generates database change request folders in a DMCR-style format:

- `deploy.sql` — applies the change
- `verify.sql` — validates invariants (works after deploy and after revert)
- `revert.sql` — undoes the change (as safely as possible)

It’s designed for natural-language requests (DDL/DML/functions). When your request is ambiguous or missing critical details, it asks targeted follow-up questions (clickable chips) instead of guessing.

## Features

- Generates a complete DMCR change folder under `db/changes/<NNN_slug>/`
- Produces `deploy.sql`, `verify.sql`, `revert.sql`
- Follow-up chips for risky/ambiguous changes:
  - `safe_split` (recommended for safer, multi-step changes)
  - `generate_anyway`
  - `clarify`
  - `cancel`
- “DMCR-safe” verify behavior:
  - If `dmcr.change_log` contains the change id, verify asserts the “applied” state
  - If it does not, verify asserts the “reverted” state
  - No `ELSE` blocks (uses two independent `IF` checks)

## Requirements

- VS Code 1.103 or newer.
- An AI model: GitHub Copilot Chat, or a custom provider (OpenAI-compatible, Anthropic, Ollama, LM Studio) added in Settings → LLM Provider.
- `psql` on the machine that runs changes (or set its path in Settings → DMCR Config).
- To run changes: PowerShell on Windows (PowerShell 7 `pwsh`, or the built-in Windows PowerShell 5.1), Bash + Perl on macOS/Linux.
- Optional: a database MCP server such as the bundled `pgsql_mcp` (Python 3.10+) for Schema Explorer, Schema Diff and the AI checks that read the database.

## Quick Start

1. Run the extension (F5 in Extension Development Host, or install the packaged extension).
2. Open Copilot Chat.
3. Try examples like:

- `@dmcr add columns bean_name text and bean_method_name text to zp_st.zp_section_info`
- `@dmcr insert two static data rows into zp_st.zp_lookup_data (idempotent)`
- `@dmcr create function fn_zp_stactions that returns user actions for a user_id`

If details are missing (e.g., the exact rows to insert, uniqueness key, function return shape), `@dmcr` will ask follow-up questions. Click a suggestion chip or type your answer, and it will continue generation.

## How It Works (High Level)

1. Analyze intent and potential change risks.
2. If risky/ambiguous, ask a follow-up (chips) to confirm a safe approach.
3. Generate a DMCR change JSON response (Copilot) and write scripts to a new change folder.
4. Replace the `__DMCR_CHANGE_ID__` placeholder in `verify.sql` with the computed folder id (e.g., `002_some_change`).

## Extension Settings

Most configuration lives in the panel: **Settings → DMCR Config** (environments, connection URLs, changes folder, timeouts, git), with database passwords stored in the OS keychain, never in files. VS Code settings:

- `dmcr.changesDir` (default `db/changes`) — fallback changes folder, relative to the workspace. DMCR Config and `dmcr.cfg` take precedence.
- `dmcr.copilotFamily` — default Copilot model family.
- `dmcr.dbPath` — DMCR's local SQLite file (default `~/.dmcr/db/dmcr.db`). Several VS Code windows can share it.
- `dmcr.scriptPath` — use your own `dmcr.ps1` instead of the bundled runner.
- `dmcr.pwshPath` — PowerShell to run `dmcr.ps1` with (default: `pwsh`, then `powershell.exe`).
- `dmcr.gitRemoteUrl`, `dmcr.gitAutoCommit`, `dmcr.gitBranch` — git integration (DMCR Config takes precedence).
- `dmcr.idWidth` — deprecated: change folders always get a 3-digit prefix (`001_`), the only form the runners recognise.

## Running changes in production

- Each change runs in one transaction: `deploy.sql`, its registry row and `verify.sql` commit together or not at all. Revert works the same way.
- A database lock stops two deploys from running at once, across machines. `dmcr repair --unlock` clears a lock left by a crashed run.
- `lock_timeout` and `statement_timeout` from DMCR Config apply to every change, so a deploy that meets an application lock gives up instead of hanging.
- **Prove every change before you deploy it: `dmcr test`** (Runner: `/test`). For each pending change, in order, inside one transaction that is always rolled back, it runs `deploy.sql`, `verify.sql`, `revert.sql` and `verify.sql` again. It then checks that the schema and the data of every table the change touched are exactly what they were before. A revert that loses data, leaves an object behind or fails, and a verify that fails in either state, are reported with the table or object involved. Run it against staging or a copy of production: it holds locks on the tables it changes until it rolls back, so it refuses an environment named `prod` unless you add `--allow-prod`.
- **Edited changes are caught.** If an applied `deploy.sql`, `verify.sql` or `revert.sql` no longer matches the checksum recorded at deploy, `check` reports it and deploy refuses (`checksum_policy = block`, the safe choice). `checksum_policy = repair` accepts the edit and records it in `dmcr.event_log`; `warn` only warns. To accept edits once, run `dmcr repair --checksums`.
- **Statements that cannot run in a transaction** (for example `CREATE INDEX CONCURRENTLY` on a large table): add `"transaction": false` to the change's `meta.json`. `deploy.sql` then runs statement by statement. Both files must be safe to run again — `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and `DROP INDEX CONCURRENTLY IF EXISTS` (DMCR refuses them otherwise) — and if `deploy.sql` or `verify.sql` fails, DMCR runs `revert.sql` to clean up, for example dropping the INVALID index PostgreSQL leaves behind. `dmcr test` stops at these changes because they can't be rolled back.
- **Promote, don't re-decide.** Set `promote_from = test` on the `[prod]` environment (Settings → DMCR Config → Release pipeline). Deploy to prod then runs only changes already applied in test whose `deploy.sql`, `verify.sql` and `revert.sql` are byte-identical to what test ran. The whole plan is checked before anything runs, and a change test hasn't run, an edited file, or an unreadable test registry blocks the deploy. The extension reads test's registry with the test URL and the keychain password; the runner also accepts `DMCR_PROMOTE_FROM_CONN`.
- **Out-of-order changes.** `out_of_order = block` on an environment refuses a pending change that sorts before one already applied there.
- **Table snapshots.** In Schema Explorer, right-click a table → Snapshot table. DMCR reads the table through its MCP server (exact column types, NOT NULL, primary key, row count) and writes a normal change folder `NNN_snapshot_<table>`:
  - `deploy.sql` creates `<table>_backup_DD_MM_YYYY`, copies all rows, the rows matching a WHERE condition, or none (structure only), and records the copied row count on the copy;
  - `verify.sql` checks the copy and that count when applied, and that the copy is gone when reverted;
  - `revert.sql` drops only the copy.
  
  It goes through the pipeline like any change, so the copy is taken when it deploys in each environment. Defaults, indexes, triggers, foreign keys and grants are deliberately not copied.
- Folders starting `danger_` (or containing `_danger_`) are never run automatically; a DBA runs them by hand.
- AI-generated SQL must be reviewed before it reaches production, especially `revert.sql` for data changes.

## Testing

| Command | What it checks | Needs |
|---|---|---|
| `npm run test:unit` | Redaction and secret masking, the prompt template resolver, two VS Code windows sharing one SQLite file | — |
| `npm run test:runner` | `dmcr.sh` against PostgreSQL 16: transactions, verify, guards, dependencies, tags, danger rules, `PGPASSWORD`, `dmcr test` (round trips that pass and every way they can fail), and a production-style rehearsal (500k rows, failing change mid-batch, application lock, racing deploys, drift, `CONCURRENTLY`) | Docker |
| `npm run test:runner` (also) | The promotion gate and out-of-order guard across two databases | Docker |
| `npm run test:runner:ps` | The same suites for `dmcr.ps1` under Windows PowerShell 5.1, plus values with `"`, `\` and `'` reaching PostgreSQL exactly | Docker, Windows |
| `npm run test:e2e` | The extension in a real VS Code: activation, settings, saving a change, `dmcr test` and the runner end to end, secrets in VS Code's real SecretStorage, AI features through a local fake model, and the bundled `pgsql_mcp` server. With `DMCR_E2E_DEEPSEEK_KEY` set, also a real model (DeepSeek): generate a change, round-trip it, deploy and revert it | Docker, VS Code |

## DMCR Web (try it in a browser)

`local-server/` serves the same UI in a browser, backed by the extension's own handlers and runners (`vscode` is replaced by a small file-backed shim). It's for local testing, not a hosted service.

- `npm run web` → http://127.0.0.1:7799. It keeps its own settings, SQLite database and secrets under `~/.dmcr-web`, never the extension's `~/.dmcr`.
- AI: there is no Copilot outside VS Code. If `DEEPSEEK_API_KEY` is in `.env` (or the file named by `DMCR_WEB_ENV_FILE`), DeepSeek becomes the active provider. Only key names are logged.
- Test and prod databases without a local psql:
  - `powershell -File test\scripts\envs.ps1 up` starts two PostgreSQL 16 containers, test (`localhost:25432`) and prod (`localhost:25433`), plus `pgsql_mcp`;
  - run the server with `DMCR_PSQL=test\scripts\psql-docker.ps1`, which runs psql in a container and routes those ports to the right database.

## Tips for Better Results
For DML (“insert seed/static data”):

- Provide the column list and exact values for each row.
- Provide uniqueness key / conflict strategy (e.g., “use ON CONFLICT on (col1,col2)”).
- Say whether deploy should be idempotent.

For functions/procedures:

- State the target dialect (PostgreSQL vs Oracle) if relevant.
- Provide signature (params + types) and expected return shape (columns + types).

## Known Issues
- LLM output can be non-deterministic. When in doubt, @dmcr will ask clarifying questions rather than guessing.
- Complex “undo” logic for arbitrary DML can require human review—always review revert.sql before running in production.
- Deploy runs folders in number order; `requires` in `meta.json` is checked, not used to reorder.

## Release Notes
See CHANGELOG.md.