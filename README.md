# DMCR — Database Change Requests for VS Code

![DMCR](https://raw.githubusercontent.com/salilvnair/dmcr/main/images/dmcr-icon.png)

> **DMCR** (Database Management & Change Request) — PostgreSQL change requests
> inside VS Code. AI writes `deploy.sql`, `verify.sql` and `revert.sql` from plain
> English, every change is test-run before you see it, and releases deploy by
> project to test and prod through a built-in runner. An alternative to Flyway
> and Sqitch.

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-1.103%2B-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript)](https://www.typescriptlang.org/)

![DMCR demo: a change from plain English, test-run on dev, saved to a project, deployed to dev and then prod, every step a git commit](https://raw.githubusercontent.com/salilvnair/dmcr/main/media/dmcr-demo.gif)

<sub>Seventy-five seconds of the real app (DMCR Web, the same UI as the extension). The waits on the AI and psql play faster. Also [as an mp4](https://raw.githubusercontent.com/salilvnair/dmcr/main/media/dmcr-demo.mp4).</sub>

---

## What this is

Most migration tools are a command line and a folder of numbered files. You
write the SQL, you write the undo by hand, and you find out the undo is wrong
on the day you need it. DMCR is a VS Code extension: the changes live in the
repository beside the code, the passwords live in the OS keychain, and every
change is a folder you can open.

Each change is three files. `deploy.sql` applies it. `verify.sql` checks it,
and works both after deploy and after revert. `revert.sql` undoes it. DMCR runs
all three for real, inside a transaction that is rolled back, before the change
reaches any environment.

It also does what a migration tool normally leaves to people. **Releases** group
changes by project and decide which projects go to which environment. **Two
DBAs** can work on one repository at the same time: DMCR pulls, renumbers and
pushes for them, and refuses a deploy while two changes clash.

The change SQL never names a schema. Each environment has its own schema and
its own app role, so the same files run on test and on prod.

---

## Table of contents

- [Install](#install)
- [First run](#first-run)
- [The Change Builder](#the-change-builder)
- [Anatomy of a change](#anatomy-of-a-change)
- [Environments, schema and app role](#environments-schema-and-app-role)
- [Writing a change](#writing-a-change)
- [Releases and projects](#releases-and-projects)
- [Two DBAs, one repository](#two-dbas-one-repository)
- [Running changes in production](#running-changes-in-production)
- [Schema Explorer, Schema Diff, Data Diff](#schema-explorer-schema-diff-data-diff)
- [Danger rules](#danger-rules)
- [The runner](#the-runner)
- [DMCR Web](#dmcr-web)
- [Walkthroughs](#walkthroughs)
- [Settings](#settings)
- [Commands and keybindings](#commands-and-keybindings)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

---

## Install

Requires **VS Code 1.103+**, and:

- **An AI model.** GitHub Copilot Chat, or a custom provider added in
  **Settings → LLM Provider**.
- **`psql`** on the machine that runs changes, or its path in
  **Settings → DMCR Config**.
- **A shell for the runner.** PowerShell on Windows (PowerShell 7 `pwsh`, or the
  built-in Windows PowerShell 5.1). Bash and Perl on macOS and Linux.
- **Optional:** a database MCP server, such as the bundled `pgsql_mcp`
  (Python 3.10+). Schema Explorer, Schema Diff and the AI checks that read the
  database use it.

From the Marketplace (search **DMCR**), or from a `.vsix`:

```bash
code --install-extension dmcr-1.2.0.vsix
```

Open it with **DMCR: Open Change Builder** from the command palette, or the
DMCR icon in the activity bar.

---

## First run

Nothing works until DMCR knows who you are and where it deploys. Every tab but
Settings shows the first-run wizard until then.

For each environment the wizard asks for a **connection URL** (without the
password), the **password** (kept in the OS keychain, never in a file), the
**schema** its changes run in, and its **app role**. Click **Test** on each, then set up each database in the wizard's last step.
DMCR adds its `dmcr` registry there, owned by the user you connect as.

---

## The Change Builder

The panel is a row of tabs.

| Tab | What it does |
|---|---|
| **Home** | Where you start |
| **DDL** | Schema Builder: ALTER TABLE, CREATE TABLE, sequences and role grants |
| **DML** | Insert Rows: seed data with idempotent ON CONFLICT handling |
| **Freeform** | Any SQL: AI writes deploy, verify and revert |
| **Manual** | Write deploy, verify and revert yourself. No AI: DMCR only test-runs them |
| **Diff** | Compare two schemas and write change SQL for every structural difference |
| **Assistant** | Chat to build changes end to end |
| **Releases** | Plan, ship and roll back by project |
| **Runner** | The runner's commands, with their output |
| **Commits** | What is saved, what is committed, and what the other DBAs pushed |
| **Settings** | Thirteen sections |

The activity bar adds three views: **Quick Access**, **Schema Explorer** (shown
when a database MCP server is set up) and **Quick Reference**.

The **Variables** button in the top bar shows every `${name}` a change can use,
and what it becomes on each environment.

---

## Anatomy of a change

A change is a folder under the changes folder, named `NNN_slug`. The prefix is
always three digits (`001_`).

| File | What it holds |
|---|---|
| `deploy.sql` | Applies the change |
| `verify.sql` | Checks the change, after deploy and after revert |
| `revert.sql` | Undoes the change |
| `meta.json` | Optional: `requires`, `tags`, `ticket`, `author`, `project`, `requested_by`, and `transaction` |

`verify.sql` only checks once `dmcr.change_log` says the change is applied:

```sql
-- verify: fails when the change is applied but what it creates is missing
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
    IF to_regclass('item') IS NULL THEN RAISE EXCEPTION 'item is missing'; END IF;
  END IF;
END $$;
```

DMCR fills in `__DMCR_CHANGE_ID__` when you save.

**The self-check.** Before the card is shown, DMCR runs the generated change for
real and rolls it back. The card says **Self-check passed**, or **Fixed before
you saw it**. It also says what the change adds that a saved change already
adds, and how the revert of each replaced function or view was made.

**Lock lint.** Each card lists what locks or rewrites a table, why it hurts,
and the safer way to write it.

**Repeatable changes.** Folders named `R__*` run again whenever their
`deploy.sql` changes. They need no `revert.sql`, so they must be safe to run
twice.

---

## Environments, schema and app role

Change SQL uses plain names. Each environment fills in the rest.

```sql
-- deploy.sql
CREATE TABLE item (id int PRIMARY KEY, code text NOT NULL UNIQUE);
GRANT SELECT, UPDATE, DELETE ON item TO ${app_role};
```

On test, `item` is created in the test schema and granted to the test app
role. On prod, the same file uses the prod schema and the prod app role. The
schema is set per environment in **Settings → DMCR Config**, and becomes the
search path. `${app_role}` is the environment's **App role**, set in the same
place.

**SQL that names one environment is refused.** When the AI writes a schema or
role name, DMCR rewrites it to the plain name or `${app_role}` before the
self-check. When you type one on the card, **Save to workspace** refuses and
says which file and name. When one reaches a deploy anyway, the deploy and its
preview refuse with `BLOCKED by environment names`. An environment with no App
role refuses a change that uses `${app_role}`.

**Variables you can write:**

| Variable | What it becomes | Set in |
|---|---|---|
| `${app_role}` | This environment's role | Settings → DMCR Config → App role |
| `${your_name}` | Any value you add, the same on every environment | `[placeholders]` in `dmcr.cfg` |
| `__DMCR_CHANGE_ID__` | The change's id | Filled in when you save |

A `${name}` with no value stops the deploy.

**Ids from a sequence differ between databases.** The same files go to test and
prod, so do not write a generated id in the SQL. Find the row by a column that
is the same on both:

```sql
-- deploy.sql
INSERT INTO order_status (code, label) VALUES ('HOLD', 'On hold');

INSERT INTO order_status_rule (status_id, rule)
SELECT id, 'notify' FROM order_status WHERE code = 'HOLD';

-- revert.sql
DELETE FROM order_status_rule
WHERE status_id IN (SELECT id FROM order_status WHERE code = 'HOLD');
DELETE FROM order_status WHERE code = 'HOLD';
```

---

## Writing a change

**The forms.** DDL and DML ask for the details a change needs, and the AI
writes the three files. Freeform takes any SQL or any description.

**Manual.** Write all three files yourself. DMCR test-runs them on the
environment you pick (deploy, verify, revert, verify, rolled back), then the
change is saved and committed like any other.

**The Assistant.** A chat that builds changes end to end. Before it writes a
change, it shows a form for the change's details, which you confirm or skip.

**`@dmcr` in Copilot Chat.** A chat participant for the same job:

- `@dmcr add columns bean_name text and bean_method_name text to section_info`
- `@dmcr insert two static data rows into lookup_data (idempotent)`
- `@dmcr create function fn_user_actions that returns user actions for a user_id`

When a request is risky or unclear, `@dmcr` offers chips instead of guessing:
`safe_split`, `generate_anyway`, `clarify` and `cancel`.

**Snapshot a table.** In Schema Explorer, right-click a table → **Snapshot
table**. DMCR writes a normal change that copies the table into
`<table>_backup_DD_MM_YYYY`: all rows, the rows matching a WHERE condition, or
none. Indexes, triggers, foreign keys and grants are not copied.

**Tips for better results.** For rows, give the columns, the exact values and
the uniqueness key. For functions, give the signature and the return shape.

---

## Releases and projects

A **release** holds projects, and each change belongs to a project. Releases
are saved to `releases.json` in the repository, and DMCR commits it for you.

- **Deploy by project.** A deploy runs only the changes of the projects you
  pick.
- **Never to production.** A change can be marked to stay where it is. A
  deploy to prod lists it as `NOT FOR PROD` and skips it, and a change that
  requires it is refused on prod.
- **Drop a change.** The folder stays in the repository, and deploy skips it in
  every environment until you restore it.
- **Sign-off.** An environment can require a DBA sign-off per change
  (**Releases → Approve**). An edit after it needs a new one. Whoever made or
  asked for a change never signs it off.
- **Rollback by scope.** Revert the applied changes you pick, newest first,
  wherever they sit in the history. Preview first: DMCR refuses when a later
  change outside your pick depends on them.
- **Script for DBeaver.** A danger change is run by hand: download its script,
  run it in DBeaver or psql, or mark it applied.
- **Import from test.** SQL that already ran on test by hand becomes DMCR
  changes that go to prod through Releases. Test is not touched: the changes
  are only recorded there as applied.
- **Zero-downtime change.** Expand and contract templates, written as real
  DMCR changes.
- **Set up CI.** A GitHub Actions check on every pull request: lock lint, the
  whole history on an empty database, and a round trip of the changed changes.

A deploy is refused while a pending change has no project or no requested by.

---

## Two DBAs, one repository

Each DBA runs DMCR on their own clone of the same repository.

**Save, then Commit.** **Save to workspace** writes the folder. **Commit** pulls
first, renumbers yours if the other DBA took the number, then pushes. A banner
says when a change is saved but not committed. You never type a git command.

**Conflicts.** Two changes that change the same thing, such as the same
function, are a conflict. **Releases → Conflicts** shows what both sides
changed, like a merge. A deploy is refused until a **merge change** resolves
it. The merge editor puts both sides next to each other with Accept buttons,
like VS Code's own.

**Settings → DMCR Config → Conflicts between changes** decides what a conflict
does: block the deploy (the default), warn and continue, or do not check.

---

## Running changes in production

- **One transaction per change.** `deploy.sql`, its registry row and
  `verify.sql` commit together or not at all. Revert works the same way.
- **One deploy at a time**, across machines. `dmcr repair --unlock` clears a
  lock left by a crashed run.
- **Timeouts.** **Lock wait** and **Statement limit** apply to every change, so
  a deploy that meets an application lock gives up instead of hanging.
- **Prove every change first: `dmcr test`** (Runner: `/test`). For each pending
  change, in order, in one transaction that is always rolled back, it runs
  deploy, verify, revert and verify again. Then it checks that the schema and
  the data of every table the change touched are exactly what they were. It
  holds locks until it rolls back, so it refuses an environment named `prod`
  unless you add `--allow-prod`.
- **Rollbacks are tested before a deploy.** On every environment except
  production, a deploy first runs its changes through that round trip, and is
  refused if one fails.
- **Promote, don't re-decide.** With **Promote from** set on prod, a deploy to
  prod runs only changes already applied on test whose three files are
  byte-identical to what test ran. Production has this rule by default when
  another environment exists.
- **Edited changes are caught.** When an applied change's files no longer match
  the checksum recorded at deploy, `check` reports it. **Edited after deploy**
  decides what happens: warn and continue (the default), block the deploy, or
  accept the edit and log it. `dmcr repair --checksums` accepts edits once.
- **Older changes.** An environment can block a pending change that sorts
  before one already applied there.
- **Statements that cannot run in a transaction**, such as
  `CREATE INDEX CONCURRENTLY`: add `"transaction": false` to `meta.json`.
  `deploy.sql` then runs statement by statement, and both files must be safe
  to run again (`IF NOT EXISTS`, `IF EXISTS`). If deploy or verify fails, DMCR
  runs `revert.sql` to clean up. `dmcr test` stops at these changes, because
  they cannot be rolled back.
- **Review AI-written SQL** before it reaches production, especially
  `revert.sql` for data changes.

---

## Schema Explorer, Schema Diff, Data Diff

**Schema Explorer** is a sidebar tree of schemas, tables, functions and the
rest, read through a database MCP server. It appears once one is set up.

**Schema Diff** compares two schemas and writes change SQL for every structural
difference.

**Data Diff** shows one table's rows on two databases, test and prod, matched
by primary key. It can move prod's sequence forward to match test. It does not
write a change to move a sequence back, because those values may already be
used.

---

## Danger rules

Some SQL should never run unattended. **Settings → Danger Rules** holds the
patterns, including DELETE and UPDATE without a WHERE.

- A change that matches is saved with a `danger_` prefix.
- Folders starting `danger_` (or containing `_danger_`) are never run
  automatically. A DBA runs them by hand: `dmcr manual-script <id>` gives a
  one-transaction script, and `--revert` gives the same for its revert.

---

## The runner

`dmcr.ps1` (PowerShell) and `dmcr.sh` (Bash) ship with the extension and wrap
`psql`. The **Runner** tab drives them with slash commands such as `/deploy`,
`/test`, `/status`, `/verify` and `/revert`. You can also run them yourself:

```
dmcr <command> [args] [--env <name>] [--dry-run] [--json] [--debug] [-c|--config <path>]
```

| Command | |
|---|---|
| `init` | Create the DMCR registry schema and tables |
| `deploy` · `deploy --to <id\|@tag>` · `deploy --dry-run` | Apply pending changes in order, up to a change or tag, or only show them |
| `deploy --release <id>` · `deploy --project <id>` | Only that release's or project's changes |
| `test` · `test --only <id,...>` | Round-trip pending changes, then roll back |
| `status` · `verify` · `verify all` · `verify <id>` | What is applied, and whether it still checks out |
| `revert <id>` · `revertLast` · `revert to <id\|@tag>` · `revert list` | Undo changes |
| `revert --project <id>` · `revert --release <id>` · `revert <deploy-id>` | Undo by project, release or deployment |
| `diff` · `show <id>` · `log` · `deployments` · `events` | What changed, and when |
| `release [list]` · `release show <id>` | Releases with their counts here |
| `approve <id>\|--release` · `approvals` | Sign-off for `--env` |
| `history` · `info` · `plan` · `check` · `show config` | Inspect |
| `tag [list]` · `tag create <name>` · `tag delete <name>` | Release tags |
| `repeatable` | Apply `R__*` changes whose checksum changed |
| `manual-script <id> [--revert]` | The by-hand script for a `danger_` change |
| `parse [sql]` | Validate SQL in a rolled-back transaction |
| `baseline <id>` · `repair --mark-applied/--mark-reverted <id>` · `repair --checksums` · `repair --unlock` | Repair |

`--kind <kind>` narrows a scoped deploy or revert to `insert`, `update`,
`delete`, `dml`, `ddl`, `function`, `type` or `other`.

Environment variables: `DMCR_CONN` (connection string), `DMCR_PSQL` (the psql
to run), `DMCR_CONFIG` (config file), `DMCR_ACTOR` (deploying principal),
`DMCR_DEBUG=1`, `DMCR_ANSI_OUTPUT=0` (no colours) and `DMCR_PLACEHOLDER_<x>`
(override a `[placeholders]` value).

---|---|
| `DMCR_CONN` | Override the connection string |
| `DMCR_PSQL` | The psql to run (wins over `psql_path` in `dmcr.cfg`) |
| `DMCR_CONFIG` | Override the config file path |
| `DMCR_ACTOR` | Override the deploying principal |
| `DMCR_DEBUG` | `1` for debug output |
| `DMCR_ANSI_OUTPUT` | `0` to turn off colours |
| `DMCR_PLACEHOLDER_<x>` | Override a `[placeholders]` value |

---

## DMCR Web

`local-server/` serves the same UI in a browser, backed by the extension's own
handlers and runners. `vscode` is replaced by a small file-backed shim. It is
for local testing, not a hosted service.

- `npm run web` → `http://127.0.0.1:7799`. `DMCR_WEB_PORT` changes the port.
- Only its own page can talk to it: requests must come from that host and
  origin, and the page carries a token the server makes at start.
- It keeps its own settings, SQLite database and secrets under `.dmcr-web` in
  your home folder (or `DMCR_WEB_HOME`), never the extension's.
  `DMCR_WEB_WORKSPACE` picks the workspace folder.
- **AI:** there is no Copilot outside VS Code. If `DEEPSEEK_API_KEY` is in
  `.env` (or the file named by `DMCR_WEB_ENV_FILE`), DeepSeek becomes the
  active provider. Only key names are logged.
- **Test and prod databases:**
  - `powershell -File test\scripts\envs.ps1 up` starts two PostgreSQL 16
    containers, test (`localhost:25432`) and prod (`localhost:25433`), plus
    `pgsql_mcp`. Run the server with `DMCR_PSQL=test\scripts\psql-docker.ps1`.
  - Without Docker, `powershell -File test\scripts\envs-local.ps1 up` makes two
    databases on a local PostgreSQL instead.

---

## Walkthroughs

[docs/walkthroughs](https://github.com/salilvnair/dmcr/tree/main/docs/walkthroughs)
has step-by-step walkthroughs of DMCR Web, each step with the real screen it
shows. **QuickStart** is the shortest path: two DBAs, projects A and B, a
conflict that refuses the deploy until it is merged, and only B to prod.
**Light** is the everyday flow. **Full** is everything.

---

## Settings

Most configuration lives in the panel. **Settings** has thirteen sections:

**General** · **DMCR Wiki** · **Theme**.

**DMCR Config** — environments (connection URL, password, schema, app role),
the active environment, the changes folder, release rules per environment
(**Promote from**, **Older changes**, **Sign-off**, **Who signs off**),
**Edited after deploy**, **Conflicts between changes**, git (remote URL,
branch, auto-commit), and advanced: the psql program, **Lock wait**,
**Statement limit** and **Runner history**. Database URLs are saved without
passwords; passwords go to the OS keychain only.

**LLM Provider** · **Prompt Library** · **Conv Chips** · **AI Features** ·
**SQL Policies** — the AI sections. GitHub Copilot needs no key: it uses your
VS Code session. Custom providers cover OpenAI, Anthropic, LM Studio, Ollama,
DeepSeek, Grok, Mistral, Gemini and Qwen. API keys are kept in VS Code's
`SecretStorage`, which is the OS keychain.

**MCP Servers** · **Danger Rules** · **DMCR Storage** · **Developer Tools**.

VS Code's own `settings.json` has these under `dmcr.*`:

| Setting | Default | |
|---|---|---|
| `dmcr.changesDir` | `db/changes` | Fallback changes folder, relative to the workspace. DMCR Config and `dmcr.cfg` win |
| `dmcr.copilotFamily` | — | Default Copilot model family |
| `dmcr.dbPath` | `.dmcr/db/dmcr.db` in your home folder | DMCR's local SQLite file. Several VS Code windows can share it |
| `dmcr.scriptPath` | — | Your own `dmcr.ps1` instead of the bundled runner |
| `dmcr.pwshPath` | `pwsh`, then `powershell` | The PowerShell that runs `dmcr.ps1` |
| `dmcr.gitRemoteUrl` · `dmcr.gitAutoCommit` · `dmcr.gitBranch` | — | Git; DMCR Config wins |
| `dmcr.idWidth` | `3` | Deprecated: change folders always get a 3-digit prefix |

---

## Commands and keybindings

Inside the panel:

| Key | Opens |
|---|---|
| `Ctrl/Cmd+H` · `Ctrl/Cmd+1` | Home |
| `Ctrl/Cmd+2` | DDL |
| `Ctrl/Cmd+3` | DML |
| `Ctrl/Cmd+4` | Freeform |
| `Ctrl/Cmd+5` | Schema Diff |
| `Ctrl/Cmd+6` | Assistant |
| `Ctrl/Cmd+R` · `Ctrl/Cmd+7` | Runner |
| `Ctrl/Cmd+,` · `Ctrl/Cmd+8` | Settings |

Six commands are registered under `DMCR:` in VS Code's palette:
**Open Change Builder**, **Open Conversation**, **Open Copilot Chat with
@dmcr**, **Open Schema Explorer**, **Refresh Schema Explorer** and **Change
Database Location**.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  VS Code extension host  (Node)                              │
│  src/ — 108 files                                            │
│                                                              │
│  message handlers · LLM and MCP clients · git · SQLite       │
│  @dmcr chat participant · lock lint · conflicts · releases   │
└──────────────┬───────────────────────────────┬───────────────┘
               │  postMessage                  │  spawn
┌──────────────┴───────────────────┐  ┌────────┴───────────────┐
│  Webview  (React 19 + Vite)      │  │  Runner                │
│  webview-ui/src/ — 180 files     │  │  scripts/runner/       │
│                                  │  │  dmcr.ps1 · dmcr.sh    │
│  tabs · forms · Monaco           │  │  → psql → PostgreSQL   │
│  @salilvnair/dui                 │  │                        │
│  @salilvnair/convengine-chat     │  │                        │
└──────────────────────────────────┘  └────────────────────────┘
```

**Everything privileged happens in the extension host.** The webview renders
and asks. The host reads files, calls the model, runs git and spawns the
runner.

**The runner** keeps its registry in the `dmcr` schema of each database:
`dmcr.change_log`, `dmcr.event_log`, `dmcr.tags` and `dmcr.repeatable_log`.

**`pgsql_mcp/`** is a reference database MCP server in Python, with 13
schema tools over stdio. Its database sessions are read-only.

**`local-server/`** is [DMCR Web](#dmcr-web): the same handlers outside VS Code.

**Storage** is SQLite (`sql.js`) at `dmcr.dbPath`. Secrets are the exception:
database passwords and API keys go to `SecretStorage`.

---

## Development

DMCR builds against two sibling checkouts: `dui` and `convengine-chat` next to
`dmcr`.

```bash
npm ci
npm run watch          # extension host, incrementally
npm run dev:webview    # the webview, in another terminal
# then press F5 in VS Code — an Extension Development Host opens
```

| Command | |
|---|---|
| `npm run build:all` | Build dui's CSS, the webview, type-check, then the extension |
| `npm run build:webview` | The webview only |
| `npm run compile` | Type-check both halves, lint, build the extension |
| `npm run lint` | ESLint over `src/` |
| `npm run web` · `web:dev` | [DMCR Web](#dmcr-web) |

Tests:

| Command | What it checks | Needs |
|---|---|---|
| `npm run test:unit` | 33 suites: conflicts, danger scan, data diff, lock lint, the deploy gate, redaction, the prompt template resolver, two VS Code windows sharing one SQLite file, and more | — |
| `npm run test:runner` | `dmcr.sh` against PostgreSQL 16: transactions, verify, guards, dependencies, tags, danger rules, `dmcr test`, the promotion gate, and a production-style rehearsal (500k rows, a failing change mid-batch, an application lock, racing deploys, drift, `CONCURRENTLY`) | Docker |
| `npm run test:runner:ps` | The same suites for `dmcr.ps1` under Windows PowerShell 5.1 | Docker, Windows |
| `npm run test:e2e` | The extension in a real VS Code: activation, settings, saving a change, `dmcr test` and the runner end to end, secrets in the real SecretStorage, AI through a local fake model, and `pgsql_mcp`. With `DMCR_E2E_DEEPSEEK_KEY` set, also a real model | Docker, VS Code |

Packaging:

```bash
npm run vsix                                 # -> dmcr-1.2.0.vsix
code --install-extension dmcr-1.2.0.vsix
```

---

## License

MIT — see [LICENSE](https://github.com/salilvnair/dmcr/blob/main/LICENSE).
