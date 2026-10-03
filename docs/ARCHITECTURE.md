# DMCR Architecture Reference

A full map of the DMCR codebase as of commit `8e2c788` (plus the uncommitted `duration_ms` fix in `CommandViews.tsx`). It was built from a complete read of `src/`, `webview-ui/src/`, `scripts/runner/`, `pgsql_mcp/` and the build config, so it can serve as the base for further work.

Paths are relative to the repo root. `file:line` citations point at the code as read; re-check them after edits.

---

## 1. System overview

DMCR is a PostgreSQL change-management tool made of five parts:

| Part | Tech | Where | Role |
|---|---|---|---|
| Extension host | TypeScript, esbuild → `dist/extension.js` | `src/` | VS Code activation, message handlers, LLM/MCP/git/storage services, `@dmcr` Copilot participant |
| Webview UI | React 19 + Vite + Tailwind, `@salilvnair/dui`, `@salilvnair/convengine-chat` | `webview-ui/` → `webview/dist` | Change Builder panel (8 tabs), Schema Explorer and Wiki sidebar views |
| Runner | PowerShell (`dmcr.ps1`) / Bash (`dmcr.sh`) wrapping `psql` | `scripts/runner/` | init/deploy/verify/revert/tags/repeatables, registry in schema `dmcr` |
| Reference DB MCP server | Python, `mcp` + psycopg3 | `pgsql_mcp/` | 13 schema-introspection tools over stdio |
| Sample DB | SQL | `fake/zapper/` | UK electricity-disconnect domain, 15 tables, 6 functions, 7 views |

Each change is a folder `NNN_slug/` holding `deploy.sql`, `verify.sql`, `revert.sql` and an optional `meta.json`. Folders named `R__*` are repeatable. Folders containing `danger_` are meant to be manual-only, but see the runner bug in §6.6.

```
 VS Code ─ activate ─► extension.ts
   ├─ @dmcr chat participant ──► forms/llm/chat/chat-handler.ts ─► generator (Copilot only)
   ├─ DmcrPanel (webview) ◄──postMessage──► handlers/{form,chat,settings,runner,mcp,data,config}
   │                                        ├─ services/llm   (Copilot vm.lm | custom HTTP providers)
   │                                        ├─ services/mcp   (stdio/HTTP JSON-RPC clients)
   │                                        ├─ services/agent-pool, prompt-library
   │                                        ├─ services/git   (execFile git)
   │                                        ├─ storage/db     (sql.js in-memory → ~/.dmcr/db/dmcr.db)
   │                                        └─ spawn pwsh/bash ► scripts/runner/dmcr.{ps1,sh} ► psql ► PostgreSQL
   ├─ SchemaExplorerProvider (webview) ─► reuses mcp/data handlers
   ├─ QuickAccessViewProvider, WikiViewProvider
   └─ MCP servers (e.g. pgsql_mcp) spawned on demand
```

---

## 2. Extension host

### 2.1 Activation (`src/extension.ts:17-170`)
1. `initDb` (sql.js), `initPromptLibraryDb`, `initDangerRulesDir`, `initSecretStore`, `migrateLegacyApiKeys`, `loadActiveFamilyFromDb`, `initMcpService` (a no-op).
2. Chat participant `salilvnair.copilot.dmcr`; its followup provider reads `result.metadata.dmcr_followups`.
3. Views:
   - `dmcr.canvasView` (Quick Access, retained)
   - `dmcr.wikiView` (retained)
   - `dmcr.schemaExplorer` (not retained; shown when `dmcr.hasDbMcp`)
4. Commands: `dmcr.open`, `dmcr.conversation` (posts `navigateToTab` after a fixed 300 ms), `dmcr.openCopilotChat`, `dmcr.openSchemaExplorer`, `dmcr.schemaExplorer.refresh`, `dmcr.changeDbLocation`. Also a status-bar item and a `dmcr.dbPath` config listener.
5. Auto-opens `DmcrPanel`.
6. `deactivate`: `killActiveRunnerChild`, `disposeMcpService`, `closeDb`.

### 2.2 DmcrPanel (`src/panel/main/DmcrPanel.ts`)
- **Lifetime:** singleton `createOrShow` (`:82-108`), with `retainContextWhenHidden`.
- **Extra tabs:** `openInNewTab` (`:114-149`) creates independent secondary panels (`dmcr.panel.tab`).
- **HTML (`_getHtml`, `:191-247`):**
  - loads `webview/dist/webview-ui/index.html` and rewrites asset URLs;
  - injects `__DMCR_VSCODE_API__` and `__DMCR_MODE__`;
  - CSP is `script-src 'unsafe-inline' 'unsafe-eval'`, `connect-src 'none'`, `frame-src *`.
- **Double render:** the HTML is set twice, the second time about 80 ms later or on first visibility (`:55-72`). This reloads the webview and duplicates the bootstrap messages.
- **Dispatch (`_handleMessage`, `:178-187`):** chain form → chat → settings → runner → mcp → data → config, first `true` wins. A fresh `HandlerContext` is built per message, but `state` is shared by reference.

`PanelState` (`handlers/types.ts:18-22`):

| Field | Set by | Read by |
|---|---|---|
| `activeFormType` | `setActiveForm` | `submit` |
| `pendingGeneration` | DMCR chat branch (single slot) | `metadata_confirmed` / `metadata_skipped` |
| `inlineConvSessionStartId` | `conversationSessionStart` | `getAuditTimeline` without a conversation id |

### 2.3 Message protocol (webview ↔ host)
All host messages are broadcast to `window`. Several always-mounted components listen independently: App, the DDL/DML/Freeform pages, every ChangeCard, ConversationPage, RunnerPage and SchemaDiffPage. **There is no request-id correlation except in chat (`msgId`).**

| Handler | Inbound types (→ outbound) |
|---|---|
| `form-handlers.ts` | `submit` → `showProgress`, `generating`, `progressUpdate`, `streamChunk`, `generationDone`/`generationError` · `cancel` → `formCancelled` · `browseFolder` → `folderPicked` (top-level `path`) · `saveChange` → `saved`, `generationDone`, `gitCommitDone/Error`, `saveError` · `lintSql`/`lint` → `lintResult` · `setActiveForm` · `conversationSessionStart` · `manualCommitAndPush` → `commitResult` · *(dead)* `openForm` |
| `chat-handlers.ts` | `chat{msgId,payload}` → `sseEvent{stage:VERBOSE\|ENGINE_RETURN}`, `reply{msgId,text: JSON}` (`text`, `DmcrChange`, `DmcrMetadataForm`, `SchemaServerPicker`, `dmcrHelp`), `error` · *(dead)* `requestConversationHtml` |
| `settings-handlers.ts` | `ready` → `init` · `saveTheme` · `saveUiSnapshot` · `saveSettings` / `activateProvider` → `saved` · `addProvider` → `providerAdded` · `deleteProvider` → `providerDeleted` · `fetchModels` → `modelsFetched` |
| `runner-handlers.ts` | `runDmcr{args,scriptPath}` → `terminalData`, `terminalJsonResult`, `terminalExit` · `lsChanges` → `lsChangesResult` · `gitSync` → `gitSyncResult` · `listMcpServers` → `mcpServers` · `compareSchemasMcp` → `schemaMcpProgress`, `schemaMcpResult` · `fetchDdlPairs` → `ddlPairsResult` · *(dead)* `clearDmcrLock` |
| `mcp-handlers.ts` | `getMcpServers` → `mcpServers` (**different shape** from `listMcpServers`) · `upsertMcpServer` → `mcpServers`, `dbMcpValidation` · `deleteMcpServer` · `validateDbMcpServer` · `getMcpTools` → `mcpTools` · `restartMcpServer` → `mcpRestarted` · `getDbMcpStatus` → `dbMcpStatus` · `getDbMcpServers` → `dbMcpServers` · `discoverAllDbSchemas` → `allDbSchemas` · `discoverMcpSchemas` → `mcpSchemas` · `discoverMcpObjects` → `mcpObjects` · `describeMcpTable` → `mcpTableDesc` · `getObjectDefinition` (clipboard) · `openFormWithPrefill` → `formPrefill` (main panel only) · *(dead)* `mcpCallTool` |
| `data-handlers.ts` (1427 lines) | Existing changes, DB info, AI footprint/audit, system info, SQLite rebuild, `runCommand`, `openInNewTab`, DB explorer, git user/status, runner history, conversation history, conv chips, SQL policies, plus all AI_* feature handlers (§3.6) and `saveTextFile` |
| `config-handlers.ts` | `getDmcrConfig` → `dmcrConfig` · `saveDmcrConfig` → `dmcrConfigSaved` · `testDbConnection` · `fetchGitBranches` · `pickFile` → `filePicked` · `pickFolder` → `folderPicked{payload}` · `revealFolder` · danger rules load/save/reset/pick · prompt library load/save/reset → `promptLibraryLoaded` |

Other channels:
- **Host-originated:** `navigateToTab`, `formPrefill`, `schemaExplorerRefresh`.
- **Webview-internal:** `__dmcr_chatBusy`, synthetic `sseEvent`.
- **Never sent by the host:** `formActivated`, although three pages listen for it.

### 2.4 Key flows
- **Form → change.**
  1. App posts `setActiveForm`; the page posts `submit`.
  2. Host builds the request with `build*NormalizedRequest` (from the legacy `forms/core/panels/*-form.ts`), then `loadDmcrContextText` reads `dmcr.ps1`, `dmcr.cfg` and the DDL from the workspace root.
  3. Host calls `generateDmcrChangeWith{Custom,Copilot}`, merges the form metadata into `metaJson`, runs `insertAudit`, and posts `generationDone`.
  4. The page renders `ChangeCard`, which runs `lintSql` ×3; the user then sends `saveChange`.
  5. `saveChangeToDisk` (`types.ts:155-198`):
     - resolves `changesDir` from SQLite `dmcr_config`;
     - forces a `danger_` prefix via `hasDangerPatterns`;
     - computes `NNN` with a hard-coded width of 3;
     - writes the files, replacing `__DMCR_CHANGE_ID__`.
  6. If enabled, `gitAutoCommitIfEnabled` runs: an AI commit message, then `commitAndPush`.
- **Conversation.**
  1. `ConversationPage` monkey-patches `fetch` and `EventSource` (`:85-279`), so `convengine-chat` talks to the host via `chat`.
  2. Host: DIALOGUE_INTENT → MASTER_AGENT route. The DMCR route stores `pendingGeneration` and replies with `DmcrMetadataForm`.
  3. The metadata form's confirm/skip comes back as another `chat`. The host generates, runs `saveConversationSql`, and replies with `DmcrChange`. Saving uses the same `saveChange` path.
- **Runner.**
  1. `runDmcr{args}`. The host resolves the script: payload path → `dmcr.scriptPath` → bundled → workspace candidates.
  2. It builds the env: `DMCR_ANSI_OUTPUT=1`, `-c <dmcr.cfg>`, and `DMCR_CONN` = cfg URL plus the SecretStorage password.
  3. It always appends `--json` except for `parse`, then spawns `pwsh -NonInteractive -File` (falling back to `powershell`) or `bash`.
  4. stderr streams to the webview as `terminalData`. stdout is parsed into `terminalJsonResult`, rendered by `runner/views/CommandViews.tsx`.
- **Schema Explorer.** Sidebar webview → `getDbMcpServers` → `discoverMcpSchemas`/`Objects` → `describeMcpTable`, all via `callSchemaCapability` with a 15 s timeout race.

### 2.5 Where configuration lives (three sources of truth)
| Value | VS Code settings | SQLite `kv` `dmcr_config/main` | `scripts/runner/dmcr.cfg` |
|---|---|---|---|
| changesDir | `dmcr.changesDir` (chat metadata, existing-changes list) | save path, runner `ls`, data handlers | runner script |
| git remote/branch/auto-commit | declared, mostly **unused** (`resolveTargetBranch` reads the setting) | written by UI, read by auto-commit | — |
| connections | — | URLs in plaintext | URLs; passwords in SecretStorage `dmcr.devPassword` / `dmcr.prodPassword` |

`dmcr.cfg` is written **inside the extension install directory** (`config-handlers.ts:107-110`), so it is lost when the extension updates.

---

## 3. AI layer

### 3.1 LLM client (`src/services/llm/`)
- **Provider selection:** `llm-settings.ts` holds an active Copilot family or an active custom provider. Setting one clears the other, and both persist in the `llm_prefs` collection.
- **`callActiveLlm(system, user, temp, token?, onMcpProgress?, retryInstr, vars?, conversationId?)`** (`llm-client.ts:37-114`):
  1. Runs MCP tool discovery (uncached, on every call).
  2. Resolves `{{vars}}` in **both** the system and user prompts.
  3. Calls the provider.
  4. If the reply contains the substring `"mcpToolCalls"`, executes the tools once and re-calls the model.
- **Copilot path:** `vscode.lm.selectChatModels({vendor:'copilot', family})`. The system prompt is sent as an **Assistant** message.
- **Custom adapters:**
  - OpenAI-compatible (also used for LM Studio), Anthropic (`max_tokens` hard-coded to 4096), Ollama.
  - No timeouts, no AbortController, cancellation ignored.
  - API keys are in SecretStorage (`dmcr.llm.<id>`); headers are in plaintext SQLite.
- **The generator bypasses `callActiveLlm`:** `forms/llm/generation/generator.ts` has its own streaming, MCP round and one repair retry.
  - The `@dmcr` participant and the form legacy path always use Copilot and ignore the custom provider.
- **Cancellation is effectively dead:** CancellationTokenSources are created per request, pushed to `_disposables`, and never cancelled.

### 3.2 Prompt library (`src/storage/prompt-library.ts`)
- **Storage:** 40 scenarios. Table `prompt_library(scenario PK, system_prompt, user_prompt, agent_name, variables, updated_at)`. DB overrides take precedence over defaults (`prompt-template.ts` and inline defaults).
- **Resolver** (`services/llm/template/prompt-template-resolver.ts`):
  - supports `{{fn['a']}}`, then `{{key}}`;
  - unknown keys are left in the text verbatim;
  - there is **no `{{#if}}`** support.
- **UI:** Settings → Prompt Library.

**Prompt library edits do not affect:**
- all 22 AI_* handlers, whose prompts are hard-coded in `data-handlers.ts` and whose defaults disagree with the handlers' JSON schemas;
- `MCP_AGENT`, which uses a hard-coded preamble;
- the user prompts of INTENT_DETECTOR, REQUEST_PLANNER and FOLLOWUP_DECIDER, which send raw or JSON text instead;
- the FREEFORM_SQL, ADD_COLUMNS and INSERT_ROWS templates when used from the forms, which use code builders under `DMCR_RULES`.

**Unresolved placeholders reach the model:**
- every generation sends literal `{{schemaContext}}{{changeNameContext}}{{conversationHistory}}`;
- agent-pool form agents send literal `{{#if}}` blocks.

### 3.3 Agents and their output contracts

| Scenario | Temp | Output | Parse / fallback |
|---|---|---|---|
| DMCR_RULES (generator) | 0.2 (repair 0) | `{changeName, deploySql, verifySql, revertSql, metaJson}` | `tryParseGenerated`; `ensureVerifyHasDmcrGuard` overwrites verify.sql without a guard; `validateGenerated` (slug, change_log, placeholder, no ELSE); otherwise `DMCR_NOT_SQL_REQUEST` |
| INTENT_DETECTOR | 0 | `{intent, object, risks[], confidence}` | `UNKNOWN`/`AMBIGUOUS`; risk vocabulary in the prompt ≠ the `DmcrRisk` enum |
| REQUEST_PLANNER | 0 | `generate` \| `clarify{question,suggestions}` \| `cancel` | hard-coded clarify |
| FOLLOWUP_DECIDER | 0 | `cancel\|generate_anyway\|safe_split\|clarify\|unknown` | unknown |
| MASTER_AGENT | 0 | `{agent: GREETING\|GENERAL_FAQ\|SQL_FAQ\|MCP_TOOL\|SQL_REFINE\|WIKI\|DMCR, confidence}` | DMCR |
| DIALOGUE_INTENT | 0.1 | standalone question text | original text |
| GREETING / GENERAL_FAQ / SQL_FAQ / WIKI | 0.7 / 0.3 | markdown (SQL_FAQ may return `agentPoolCall`) | — |
| SQL_REFINE | 0.2 | same 5 keys as DMCR_RULES | **no validation, verify guard or danger check** |
| MCP_TOOL_AGENT | 0.1/0.3 | `mcpToolCalls` \| `SchemaServerPicker` \| markdown | — |
| SCHEMA_DRIFT_SUMMARY | — | `{riskLevel, headline, summary, …}` | strict `JSON.parse`; null on failure |
| GIT_COMMIT_MESSAGE | 0.1 | text of 5–200 characters | default message |

`extractJsonObject` is duplicated four times, and there are more than 20 other ad-hoc JSON slicers. A single shared helper would replace them all.

### 3.4 Master routing (`chat-handlers.ts:207-558`)
- DIALOGUE_INTENT runs when there is history.
- MASTER_AGENT then routes:
  - low-confidence DMCR on a question becomes GENERAL_FAQ;
  - SQL_REFINE with no prior SQL becomes DMCR.
- **Memory:**
  - the webview keeps the last 10 history entries in `sessionStorage`;
  - the host truncates each to 600 characters;
  - history is sent several times per turn;
  - generated SQL is kept in `conversation_sql`, which is **purged after 1 day**.

### 3.5 Agent pool (`src/services/agent-pool.ts`)
- 17 registered agents. `executeAgentPoolCall` is a 16-case switch; **SCHEMA_DIFF has no case**.
- **Delegation never actually happens:**
  - no caller passes `conversationId`, so `{{agentPool['SQL_REFINE']}}` resolves empty;
  - the only call site is the SQL_FAQ route;
  - results are never fed back to the calling agent.
- `agent-pool.ts` and `prompt-library.ts` import each other.

### 3.6 AI power features (`data-handlers.ts`, toggles in `AiFeaturesPanel.tsx`)
**Wired to the UI:**
- Change Explainer, Risk Scorer and Changelog — Runner
- Rollback Advisor, Gatekeeper, Perf and Ticket Linker — Runner history
- Schema Documenter and Dead Columns — Schema Explorer
- Dependency Analyzer and SQL Policy Guard — change card
- Drift Detective and Env Diff Explainer — Schema Diff
- Semantic Version is a regex badge with no LLM call.

**Host handlers with no UI trigger:** Promotion Order, Blast Radius, Blue/Green, Post-Deploy Health, Compliance, Conflict Resolver, Canary. The Test Data Generator has no handler at all; it is only a chat chip.

**The toggles do nothing.** They are written to `localStorage` and never read, so the footer claim is false.

**Known handler bugs:**
- Drift reads `.tables` off `{success,data}`, so it is always empty.
- Canary casts its result to an array, so it always returns 0 rows.
- Perf sends `serverId:''`.
- Gatekeeper calls `JSON.parse` on a `string[]`, so it throws whenever policies exist.
- Health-check executes **LLM-generated SQL** via MCP.

### 3.7 `@dmcr` Copilot participant (`src/forms/llm/chat/chat-handler.ts`)
1. `planNextStep` runs; on `clarify` it returns chips.
2. `detectIntentAndRisks` runs; if there are risks it shows the `FOLLOW_UPS[risk]` chips: `safe_split`, `generate_anyway`, `clarify`, `cancel`.
3. `continueGeneration` writes the folder directly:
   - honours `dmcr.idWidth`;
   - uses CRLF line endings;
   - substitutes `__DMCR_CHANGE_ID__` with back-compat regexes.

`pendingFollowUp` is a module global shared across chats. `@dmcr forms` still opens the legacy standalone HTML form panels, whose lint/save sub-protocol is partly unhandled. About 280 lines of commented-out code remain.

---

## 4. MCP layer

### 4.1 Client (`src/services/mcp/server/mcp.ts`)
- **Config:**
  - Server configs live in the `kv` collection `mcpServers`.
  - `env` and `headers` are stored in plaintext and sent to the webview.
  - There are two different `McpServerConfig` interfaces (also `mcp-agent.ts:44`).
- **stdio transport:**
  - `spawn` without a shell (Windows `npx.cmd` won't resolve), newline-delimited JSON-RPC, `initialize` with protocol `2024-11-05`, 30 s timeout per request.
  - No `proc.on('error')`; JSON-RPC `error` responses are never checked; the session is registered before the handshake.
- **HTTP transport:** a single POST with no timeout and no `initialize`. `sse` is only a label and goes through the same plain HTTP path.
- **Tool listing:** a list failure returns `[]` **and is cached**, so a down server shows up as "non-compliant".
- **Editing a DB server that fails validation deletes the saved server** (`mcp-handlers.ts:38,65`).

### 4.2 DB capability contract (`src/services/mcp/agent/mcp-db-agent.ts`)
- **Capabilities (13):** `discover_schemas`, `discover_objects`, `describe_table`, `describe_function`, `describe_sequence`, `get_ddl`, `compare_schemas`, `run_readonly_query`, `enable_objects`, `disable_objects`, `list_enabled`, `enable_all_in_schema`, `get_enabled_context`.
- **Matching:** each capability is matched heuristically on description keywords plus `inputSchema` parameter names. A server is compliant only if all 13 resolve.
- **Tool calls:** `callMcpTool` audits every call, including its args (connection strings for `compare_schemas`).
- **Result parsing:** `parseToolResult` always returns `success:true` and reads only `content[0]`.

### 4.3 Reference server (`pgsql_mcp/`)
- **Package:** `app-mcp`, Python ≥3.10, psycopg pool (min 1, max 3), sessions set `default_transaction_read_only=ON`.
- **Tools:** the 13 above. `compare_schemas` keys objects by name only and uses the **same schema name on both sides**. Missing objects carry no DDL.
- **ObjectFilter** (`config.py`):
  - only applied by `discover_schemas` and `discover_objects`;
  - fails open if the config is missing or invalid;
  - "exclude wins", contradicting its docstring.
- **`run_readonly_query` is unsafe:**
  - the only check is the first keyword;
  - the query is f-string-wrapped and `limit` is interpolated;
  - it **executes twice**;
  - `EXPLAIN` can never work;
  - a statement breakout can flip the read-only session default on a pooled connection.
- **Logging:** `compare_schemas` logs `second_conn`, password included. The tool description embeds a sample connection string with a password.
- **Config file:** the tracked `app_mcp.yml` filters to schema `zapper_st`, which is a database name. That hides the whole sample DB, which lives in `public`.

---

## 5. Storage

### 5.1 SQLite via sql.js (`src/storage/db.ts`)
- **Location:** `dmcr.dbPath`, else `~/.dmcr/db/dmcr.db`. WASM at `dist/sql-wasm.wasm`.
- **Persistence:**
  - The whole DB lives in memory; each write schedules a 500 ms debounced, synchronous `writeFileSync` of the full file.
  - Writes are not atomic.
  - **Multiple VS Code windows overwrite each other.**
  - A corrupt file sets `_sqliteOk=false`, after which all writes are silently dropped.
- **Tables:**
  - `kv(collection,id,data)`
  - `ce_audit` (trimmed to 10,000 rows on every insert)
  - `runner_event_log` (last 200)
  - `conversation_sql` (1-day purge)
  - `prompt_library`
- **Migrations:** none beyond 3 `ALTER`s.
- **`relocateDb`** leaves `prompt-library` holding the closed DB handle.
- **KV collections:** `mcpServers`, `settings`, `dmcr_config`, `sql_policies`, `drift_schedule`, `custom_providers`, `llm_prefs`, `ui_state`.

### 5.2 Danger rules (`src/storage/danger-rules.ts`)
- **File:** `<extension>/scripts/runner/dmcr_danger.json` as `{deployOnlyPatterns, alwaysPatterns, deleteWithoutWhereEnabled, updateWithoutWhereEnabled}`, with .NET-style regexes.
- **Per consumer:**

| Consumer | What it uses | Issue |
|---|---|---|
| `dmcr.ps1` | `cwd/dmcr_danger.json` first | A file in the working directory overrides the UI-edited one |
| `dmcr.sh` | the two booleans only, needs `jq` | Pattern arrays are ignored |
| TS `hasDangerPatterns` | label substrings | Not the regexes |

### 5.3 Git (`src/services/git/git-service.ts`)
- **Execution:** `execFile('git', …, {cwd: workspaceFolders[0], timeout: 30s})`.
- **`commit -m` has no pathspec**, so anything already staged gets committed too.
- **Branch handling:** the branch setting is read from VS Code settings, but the UI saves it to SQLite. `push <remote> <branch>` pushes the local branch of that name, not HEAD.
- **`fullSync`:** `pull --rebase` errors are swallowed.
- **No `GIT_TERMINAL_PROMPT=0`**, so an auth prompt can hang until the timeout.

---

## 6. Runner (`scripts/runner/`)

### 6.1 Structure (`dmcr.ps1`)
- **Startup:** `$ErrorActionPreference=Stop`, ANSI setup, orphan temp/lock cleanup, danger rules loaded.
- **Arguments:** flags anywhere: `--debug --dry-run --json --to <v> --env <v> -c/--config <p> -h`.
- **Dispatch order:**
  1. help
  2. `Get-Cfg`
  3. `--env`
  4. no-registry commands (`show config`, `init`, `parse`)
  5. `Require-Registry` gate (auto-upgrades to v1.1)
  6. `switch ($command)`
- **Config:**
  - INI sections `[dmcr]`, `[<env>]`, `[placeholders]`; inline comments are not stripped.
  - `DMCR_PLACEHOLDER_*` env vars override placeholders.
  - psql is found from `psql_path`, then `DMCR_PSQL`, then PATH.
  - Actor is `DMCR_ACTOR`, else `user@host`.
- **psql:** everything goes through `Invoke-DmcrPsql`, which puts the **connection string on argv**.
  - Change files run via temp files wrapped in `BEGIN; SET LOCAL lock_timeout/statement_timeout; …; COMMIT`.
  - Placeholders are resolved only in those wrappers.

### 6.2 Registry (`dmcr_change_log_ddl.sql`)
- **Tables:**

| Table | Columns |
|---|---|
| `dmcr.change_log` | `change_id` PK, `applied_at/by`, 3 checksums, `ticket_id`, `git_commit`, `app_name`, `environment`, `actor`, `description` (never written) |
| `dmcr.event_log` | `action ∈ {deploy, revert, lock, unlock, repair, baseline, tag, cleanup}`, `duration_ms` |
| `dmcr.tags` | — |
| `dmcr.repeatable_log` | — |

- **Upgrade DO blocks** swallow all errors.
- **Runtime upgrade** creates `tags`/`repeatable_log` with nullable columns and no defaults, which differs from the DDL.

### 6.3 Commands
| Command | Behaviour |
|---|---|
| `deploy [--to id\|@tag] [--dry-run]` | Preflight (missing files, duplicate/gap prefixes, missing deps; **no cycle check**). Then the file lock (+ a no-op advisory lock). Then per folder **in name order (the Kahn plan is not used)**: danger scan → `deploy.sql + INSERT change_log` in one transaction → verify **in a separate session after COMMIT** → auto-revert on failure. Then the repeatables phase under a second lock, where failures are swallowed. |
| `verify [all\|id]` | `verify.sql` inside BEGIN/ROLLBACK |
| `revert <id>` / `revertLast` / `revert to <id\|@tag>` / `revert list` | Must be the latest applied. Checksum policy compares only `deploy_checksum`: `block` and `repair` both throw. **Runs `verify.sql` after the revert.** `revert to @tag` also reverts the tagged change. |
| `status`, `history`, `info`, `plan` (Kahn), `check`, `show config` | Inspection |
| `baseline`, `repair --mark-applied/--mark-reverted/--checksums` | No lock, not atomic |
| `tag list/create/delete`, `repeatable`, `init`, `parse` | `parse` never reads stdin; its line numbers are off by one |

### 6.4 `--json` contract (consumed by `CommandViews.tsx`)
- **Error behaviour:**
  - Errors go to stderr with exit code 1 and never produce JSON.
  - PowerShell piping turns a single-element array into an object and an empty array into **no output**. The host's `JSON.parse` then fails.
- **Durations:** ps1 sends `duration_ms`; sh sends `duration_s` and writes seconds into `event_log.duration_ms`. The view now handles both.

### 6.5 ps1 vs sh, and the `terminal/` copies
- **Connection precedence:**
  - sh: `DMCR_CONN` wins over the cfg.
  - ps1: the cfg `conn` wins, so **the keychain password the extension injects is ignored on Windows**.
  - sh + `--env prod` connects to the *active* env's URL but labels the run prod.
- **Folder matching:**
  - sh `[0-9]*_*` also matches `1_x` and `1000_x`.
  - ps1 `^\d{3}_` silently ignores `1000_x`.
- **JSON output:**
  - sh does not escape JSON values.
  - sh always emits real arrays.
- **sh platform quirks:**
  - Without `jq`, `meta.json` parsing is broken.
  - `grep -oP` and `flock` are missing on macOS.
  - Human mode exits 1 after success in several commands.
- **`terminal/` copies:** legacy, unreferenced by the extension, and missing `--env` and JSON in several commands. `terminal/dmcr.sh` has a broken sed in `redact_conn`.

### 6.6 Critical runner bugs
1. **`danger_` detection never matches.** `\bdanger_` fails on `003_danger_x` because there is no word boundary after `_`. Danger folders block deploy instead of being skipped.
2. **`Exec-PsqlScalarSafe` likely broken.** It uses `-v` with `:'var'` inside `-c`, and psql does not interpolate variables in `-c`. That would break `Is-Applied`, tag lookup, repeatables and every `event_log` insert. **Needs a live psql test first.**
3. **The PostgreSQL advisory lock is a no-op.** It is taken and released in short-lived sessions. The file lock is per-user `%TEMP%` and keyed by a hash of the connection string.
4. **PowerShell 5.1:** psql NOTICEs abort the run (`2>&1` with `Stop`), and temp files get a UTF-8 BOM.
5. **The VSIX does not ship `scripts/**`** (`.vscodeignore:7`). A packaged install has no runner, cfg or danger rules.
6. **SQL built by string escaping only.** `lock_timeout` and `statement_timeout` are not escaped at all.
7. **Change files can contain `COMMIT` or `\c`** and escape the transaction wrapper.

---

## 7. Webview (`webview-ui/src/`)

- **Shell:**
  - `App.tsx` (931 lines) holds the tab state.
  - Home and Settings are conditionally mounted.
  - DDL, Insert, Freeform, SchemaDiff, Conversation and Runner are **always mounted** (`display:none`). That plus the message broadcast causes cross-talk.
  - Forms are reset by changing their `key`.
- **State:**
  - `useState` plus many ref mirrors; no store.
  - Global shims: `window.__dmcrUiSnapshot`, `window.__dmcrRunnerSetRunning`, plus the fetch/EventSource monkey patches.
- **Persistence:**
  - the host `ui_state` snapshot (debounced 1.5 s);
  - `sessionStorage` chat history;
  - `localStorage` for AI toggles (unused);
  - `vscode.getState` is never used.
- **Libraries:**
  - Monaco comes from `@salilvnair/dui`; the local `monaco-setup.ts` is dead.
  - xterm is a dependency but **unused**; the Runner uses a custom `VirtualTerm` with `ansi-to-html`.
- **CSS:**
  - `index.css` is 2,446 lines with **two conflicting token blocks** (`--bs-accent:#6366f1` vs `--accent:#7c6af7`). The second block breaks light-theme text colours.
  - About 25 other CSS files, and 841 hex literals in TSX.
- **Hotspots:** `WikiPanel.tsx` (218 KB), `RunnerPage.tsx` (1,523 lines), `SchemaDiffPage.tsx` (1,492), `ConversationPage.tsx` (917).
- **Chat:** `@salilvnair/convengine-chat` (source in `../convengine-chat`, latest 1.7.0) in fullscreen mode. DMCR renderers live in `chat-renderers/`:
  - Help and Change render inside a bubble;
  - Metadata, Error and SchemaPicker render raw.
- **Accessibility:** no tab/tablist roles; clickable divs; modals without focus traps; unlabeled inputs.

---

## 8. Build, packaging, tests
- **esbuild:**
  - `src/extension.ts` → `dist/extension.js`; externals `vscode` and `libpg-query`.
  - Copies the sql.js WASM, `libpg-query` and `DmcrWiki.md` into `dist/`, but **only in non-watch builds**.
- **Vite:**
  - Four entries (index, conversation (dead), wiki, schema-explorer) → `webview/dist`.
  - Aliases into `../dui` (source and dist), so the sibling checkout is required.
- **Type-checking:**
  - `check-types` covers `src/` only; the webview is never type-checked in CI.
  - The webview tsconfig has `noUnusedLocals=false`.
- **Lint:** ESLint has 5 warn-level rules only.
- **Tests:** only the scaffold sample test.
- **VSIX:**
  - excludes `scripts/**` (it should not);
  - includes `pgsql_mcp/**` and `fake/**` (it probably should not).
- **Unused dependencies:** `node-sql-parser`, `@xterm/*`, `pydantic` (Python).

---

## 9. Security summary
| Issue | Location |
|---|---|
| DB connection URLs (with passwords) injected into LLM prompts | `chat-handlers.ts:437-448` |
| Credentials in audit rows and logs (`second_conn`, MCP args, pgsql_mcp INFO log) | `mcp-agent.ts:140-145`, `server.py:259` |
| Passwords on the psql command line | `dmcr.ps1:1803`, `config-handlers.ts:194` |
| Plaintext secrets in SQLite (MCP env/headers, provider headers, conn URLs) sent to the webview | `mcp.ts`, `custom-providers.ts`, `config-handlers.ts` |
| LLM-requested MCP tool calls with no allow-list; LLM-generated SQL executed | `llm-client.ts:86`, `data-handlers.ts:1390` |
| `run_readonly_query` bypassable | `pgsql_mcp/app_mcp/introspect.py:689-706` |
| Webview can run any VS Code command and choose the runner script path | `data-handlers.ts:286`, `runner-handlers.ts:131` |
| Path traversal via `changeName`/`command` in file reads | `data-handlers.ts` (many) |
| Identifier injection in DB explorer delete | `db.ts:605` |
| Template injection (user text re-resolved for `{{…}}`) | `llm-client.ts:56` |
| Fail-open checks (policy/compliance/gatekeeper on parse failure, ObjectFilter on bad config) | `data-handlers.ts`, `pgsql_mcp/config.py` |
| CSP `unsafe-inline unsafe-eval`, `frame-src *` | `DmcrPanel.ts:227-236` |
| Quick Access CSP nonce never substituted, so the view is **broken** | `QuickAccessViewProvider.ts:203` |

---

## 10. Prioritised fix list

**P0 — broken for users today**
1. Ship the runner: remove `scripts/**` from `.vscodeignore`, and move `dmcr.cfg` and `dmcr_danger.json` out of the extension directory (use global storage or the workspace).
2. Fix Quick Access: substitute the `${nonce}` that is escaped at `QuickAccessViewProvider.ts:203`.
3. Make form submit carry `form`, so it no longer depends on `activeFormType` (which is null after save/cancel or restore, and hangs the form forever).
4. Runner `danger_` detection: use `(^|_)danger_` instead of `\bdanger_`, in both scripts.
5. Verify `Exec-PsqlScalarSafe` against a live psql; switch it to `-f`/stdin if confirmed broken.
6. ps1 should honour `DMCR_CONN` over the cfg `conn` (keychain passwords on Windows).
7. Add a correlation id to every request/response pair (lint, folderPicked, saved, mcpSchemas, filePicked, aiFootprint, …).

**P1 — correctness**
- Use the Kahn order and enforce `requires` in deploy; detect cycles in preflight.
- Remove verify-after-revert; fix `revert to @tag` semantics; enforce all three checksums.
- Hold a real advisory lock in one psql session for the whole deploy.
- Emit JSON arrays with `ConvertTo-Json -InputObject @($x)`, and always emit JSON for empty results.
- Unify `changesDir`, git and connection config into one source of truth.
- Fill all prompt placeholders; route all LLM calls through `callActiveLlm`; respect the custom provider in `@dmcr` and forms.
- Fix the four AI handler bugs; make the AI toggles actually gate features, or remove them.
- MCP: handle spawn errors and JSON-RPC errors, don't cache an empty tool list, never delete a server on failed validation.
- `pendingGeneration` should be per message; history retention should be longer than 1 day.

**P2 — security hardening**
See §9. Start by removing credentials from prompts and logs, then rewrite `run_readonly_query`.

**P3 — maintainability**
- One shared `extractJson`; a typed message-protocol map shared by host and webview.
- Split `data-handlers.ts`, `RunnerPage.tsx` and `SchemaDiffPage.tsx`.
- Delete dead code:
  - legacy `openForm` and the standalone form panels (keep the `build*NormalizedRequest` exports);
  - `conversation.tsx`, `db-introspector.ts`, `runDmcrParse`;
  - `scripts/archive/` and `scripts/runner/terminal/`.
- Fix the CSS token duplication.
- Add tests for the generator validation, `saveChangeToDisk`, the prompt resolver, and the runner JSON contract.
