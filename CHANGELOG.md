# DMCR — Changelog

All notable changes to the DMCR extension are documented here.

---

## [1.2.0] — 2026-11-21

The first Marketplace release. Releases and projects that go to test and then
to prod, two DBAs on one repository with conflict checks before a deploy,
import of SQL that already ran on test, one set of files for every
environment, and DMCR Web, the same UI in a browser.

### Added

- **Releases tab.** `releases.json` in the changes folder lists releases and
  their projects (new, bugfix, cr, hotfix, other). A change joins a project
  through meta.json and takes its release, so moving a project moves all of
  its changes. Projects can be marked not going, releases archived (or
  archived by themselves once shipped everywhere) and renamed until something
  of them is deployed. An empty project can be deleted.
- **Scoped deploy and rollback.** `deploy` and `revert` take `--release`,
  `--project` and `--kind`, and `--release` takes lists and ranges in release
  order, like git. The Releases tab has a deploy preview and a rollback
  dialog, both dry runs first, that then run in the Runner tab.
- **Change kinds and people.** meta.json records the kind (inferred from
  deploy.sql when absent), who asked, who built it and a ticket. The DBA name
  in Settings is required before anything is saved, and a deploy is refused
  while a pending change has no project or no requested by.
- **Deployment ids, like git commits.** Every deploy and revert run gets an
  id. `dmcr deployments`, `dmcr log`, `dmcr show` and `dmcr diff` list runs,
  show one change or deployment, and compare an environment with the files
  or with another environment. `dmcr revert <deploy-id>` undoes a run.
- **Round-trip test.** `dmcr test` runs every pending change through deploy,
  verify, revert and verify in one transaction that is always rolled back,
  and checks the schema and data come back exactly. A picker chooses which
  changes to test, and the Releases Changes table can start it.
- **A deploy tests first.** On every environment but production, a deploy
  and its preview run the round-trip test first and are refused if a change
  fails (`round_trip_check`).
- **Promotion gate.** Production only takes changes already applied on the
  environment before it, with identical files. `out_of_order = block`
  refuses a change that sorts before an applied one.
- **Approvals.** An environment can require a sign-off per change
  (`dmcr approve`). An edit to the files needs a new sign-off, and the DBA who
  created or requested a change cannot approve it.
- **Self-check while generating.** Every generated change is test-run against
  the test database before it is shown. A PostgreSQL error goes back to the AI
  to fix, and the card says whether the change passed.
- **Manual tab** for changes you write yourself in Monaco, with a self-check
  on the environment you pick and no AI.
- **Manual (danger_) changes.** Releases gives the DBA a one-transaction
  script to run by hand (Script for DBeaver), Mark applied records it and runs
  its verify, and a rollback blocked by such a change offers a revert script.
- **Never send to prod.** A lock action on a change in Releases keeps it off
  production. Deploys skip it, its release does not count it there, and
  Schema Diff lists what it creates as an expected difference.
- **Import from test.** Releases takes the .sql files developers ran on test
  by hand (a GitHub commit, pull request, folder link or local folder), works
  out their order, makes DMCR changes for prod, runs a rolled-back trial on
  prod and records them as applied on test.
- **Two DBAs on one repository.** The Commits tab shows uncommitted changes,
  history and diffs, with Pull, Push, branches, Bring main in and Merge into
  main. A change whose number the other DBA already used moves to the next
  free one. The branch chip in the Runner switches branches.
- **Conflicts between projects.** Changes that touch the same function, view,
  column, enum or rows are found like git conflicts and resolved in a merge
  editor (Accept A, Accept B, Accept both). A merge change is round-trip
  tested and committed by itself.
- **A deploy is refused while a conflict is not merged**, in DMCR and in both
  runners (`dmcr_conflicts.cjs`, `conflict_check = block | warn | off`).
- **An app role per environment.** `${app_role}` is set for each environment
  in DMCR Config and the setup wizard, so one set of files grants to the
  right role everywhere. Save, deploy and the deploy preview refuse SQL that
  names one environment's schema or role.
- **Variables button** in the top bar: `${app_role}`, `[placeholders]` and
  `__DMCR_CHANGE_ID__` with their value on each environment.
- **Environments are one list** in Settings › DMCR Config: any names, any
  number, each with its URL, password, schema and Test. One is marked
  Production.
- **First-run setup wizard**: psql, your databases, the changes folder, the
  DBA name and the AI provider, then each database set up.
- **Data Diff.** One table's rows on two databases, and the change that makes
  the target match. Sequences and functions compare too. The sync list is
  shared through `data-sync.json` in the changes folder.
- **Table snapshot** from the Schema Explorer writes a change that copies a
  table to a dated backup.
- **Zero-downtime change** in Releases writes expand and contract changes:
  rename or retype a column, NOT NULL and foreign keys through NOT VALID and
  VALIDATE, and indexes CONCURRENTLY.
- **Lock and safety lint** on deploy SQL (an index without CONCURRENTLY, a
  type change, SET NOT NULL, constraints without NOT VALID and more), shown in
  the self-check, Releases and the deploy preview.
- **Pull-request check for GitHub Actions.** Releases › Set up CI writes a
  workflow that lints, rebuilds the history on an empty PostgreSQL and
  round-trips every changed change, with one PR comment kept up to date.
- **Action history in git.** Deploys, rollbacks and other actions are copied
  to `.dmcr-history/<env>/` in the changes repository and pushed, including
  runs from DBeaver, CI or a terminal. New command: `dmcr events`.
- **DMCR Web**: the DMCR UI in a browser on the real backend, with its own
  database, workspace and secrets.
- **Database MCP servers made by DMCR**, one per environment in DMCR Config,
  using that environment's URL and keychain password (`@env:<name>`).
- **The Assistant reads the live database** (read-only) on the environment a
  question names, else the active one, and knows each change, its release and
  what is applied where. Answers are short cards with trees and follow-ups.
- **AI checks with buttons**: Blast Radius, Blue/Green Plan, Compliance,
  Canary Rollout, Post-Deploy Health, Optimize order, Gate and Perf in Runner
  status, and an AI risk column on a deploy dry run.
- **Themes**: ten palettes (DMCR, Tokyo Night, Gruvbox, Nord, Rose Pine,
  Catppuccin, Dracula, Kanagawa, Everforest, GitHub) and Runner terminal
  themes, each editable, importable and exportable.
- **Long lists** get search, filters and pages; rows per page in Settings ›
  General.
- **Danger zone › Erase local data** puts DMCR back to a fresh install. Your
  databases and change files are not touched. The Prompt Library has Reset
  defaults.

### Changed

- **No schema in change files.** Each environment's schema in DMCR Config is
  the session's search_path, so changes use plain names. Set up DMCR creates
  the schema too.
- **Generation sees the real objects.** The AI gets the live definitions of
  the objects a request names and the statements that made them in the
  repository. A replaced function, procedure or view is restored word for
  word by its revert.
- **Backups and seeds.** Data a change deletes or overwrites is kept in a
  backup table named after its change id. Inserting new rows is a plain
  INSERT with a revert by key.
- **Safer defaults.** DROP COLUMN and UPDATE without WHERE are danger rules,
  an always-true WHERE counts as none, and a change whose revert would wipe a
  table is refused at save.
- **Team files commit themselves**: releases.json edits, meta.json edits,
  conflicts.json, Set up CI, Import and merge changes are committed and
  pushed with a message saying what changed.
- **Change ids past 999** are seen and run in number order.
- **Faster with 1,000 changes**: one registry read per run, verify all in one
  psql session, and Releases and Commits load only what is on screen.
- **Settings › DMCR Config** rebuilt as cards, with a General tab.
- **One DMCR Wiki**, rewritten from the current code and shared with the
  Assistant.
- **No emoji icons.** Every control is a @salilvnair/dui component with SVG
  icons, 28px high.
- The extension id is `salilvnair.dmcr`. DMCR's storage from the old id
  (dmcr.cfg, danger rules) is copied once.

### Fixed

- **DMCR Web needs its token.** Each start makes a random token, and the
  WebSocket checks Host and Origin. Its saved secrets are locked with
  AES-256-GCM, the key kept by Windows DPAPI, the macOS Keychain or the
  Linux secret service.
- **Webviews run no inline code**: scripts only from the extension plus a
  nonce.
- **Credentials stay out of prompts, logs and command lines.** psql gets the
  password through PGPASSWORD, audit rows are redacted, and MCP secrets live
  in the OS keychain.
- **Read-only queries are read-only.** AI query tools run one statement in a
  READ ONLY transaction, and writing CTEs, EXPLAIN ANALYZE, SELECT INTO, FOR
  UPDATE and writing functions are refused.
- **Runner hardening** in dmcr.ps1 and dmcr.sh: psql backslash commands and
  transaction control are refused anywhere in change files, folder names
  and ids are checked, and passwords in URLs never reach psql's command line.
- The runner ships in the VSIX, and deploys hold a real lock row for the whole
  run (`repair --unlock` clears it).
- verify.sql runs inside the change's transaction, so a failing verify rolls
  the change back.
- `revert to @tag` keeps the tagged change applied.
- Line endings alone are no longer an edit.
- A placeholder without a value no longer deploys an empty change.
- "DELETE without WHERE" no longer flags ON DELETE CASCADE or GRANT DELETE.
- verify all calls a change superseded by what was applied after it on that
  environment, not by a higher number.
- Windows PowerShell 5.1: quoting, cut-off errors and the execution policy.
- Paste and right-click work in every editor and field in VS Code.
- A conversation's history no longer leaks into another.
- An AI request the provider never answers stops after 90 s; dropped
  connections are tried again.
- The connection Test finds psql on Windows and macOS.

---

## [1.1.0] — Feature Complete

### Added
- **Repeatable migrations** — `R__` prefix folders re-run when their `deploy.sql` checksum changes. Tracked in `dmcr.repeatable_log`. No `revert.sql` required (must be idempotent). Applied after versioned changes during `dmcr deploy` and explicitly via `dmcr repeatable`.
- **Placeholder substitution** — `${name}` tokens in SQL are replaced at runtime from `[placeholders]` config section. `DMCR_PLACEHOLDER_<name>` env vars override config values. Unresolved placeholders error immediately (fail-fast).
- **Release tags** — Named deployment snapshots stored in `dmcr.tags`. `dmcr tag create v1.0` bookmarks the current state. `dmcr deploy --to @v1.0` and `dmcr revert to @v1.0` target tagged states.
- **`--to` flag** — `dmcr deploy --to <id|@tag>` stops at a specific change or tag. `dmcr revert to @tag` resolves tag to change_id.
- **`dmcr repeatable` command** — Explicitly apply all repeatable migrations with changed checksums.
- **`dmcr tag` commands** — `tag list`, `tag create <name> [desc]`, `tag delete <name>`.
- **DDL tables** — `dmcr.tags` (tag_name, change_id, created_at, description) and `dmcr.repeatable_log` (change_id, last_checksum, applied_at, environment, actor).
- **DDL migration safety** — v1.1.0 DO block creates tags/repeatable_log for databases upgrading from v1.0.0.

### Changed
- Config now supports `[placeholders]` section
- `Print-Config` shows placeholder count
- `Show-Help` documents repeatable migrations, tags, placeholders, and `--to` flag
- Wiki, WikiViewProvider, and SettingsPage updated with all new features
- Comparison sections updated: Flyway/Sqitch gaps fully closed

## [1.0.0] — Production Release

### Added
- **meta.json** — optional per-change metadata file with `requires`, `tags`, `ticket`, `commit`, `author` fields
- **Advisory locking** — deploy and revert acquire a PostgreSQL advisory lock to prevent concurrent modifications
- **Checksum policy** — `checksum_policy` config option (`warn` | `block` | `repair`) for revert safety
- **Dependency planner** — topological sort via Kahn's algorithm; `dmcr plan` shows execution order
- **Enhanced preflight** — validates missing files, duplicate prefixes, malformed names, prefix gaps, dependency cycles
- **JSON output** — `--json` flag for `deploy`, `status`, `verify`, `history`, `info`, `plan`, `check`
- **New commands** — `history`, `info`, `plan`, `check`, `baseline`, `repair` (mark-applied, mark-reverted, checksums)
- **Enriched registry** — `verify_checksum`, `revert_checksum`, `ticket_id`, `git_commit`, `app_name`, `environment`, `actor` columns in `change_log`; `environment`, `actor`, `duration_ms` in `event_log`
- **DMCR_ACTOR** — environment variable to override actor name for audit logging
- **DDL migration safety** — `ALTER TABLE ADD COLUMN IF NOT EXISTS` block for upgrading v0.x schemas
- **Wiki overhaul** — DmcrWiki.md, WikiViewProvider, and SettingsPage WikiPanel fully rewritten for v1.0.0

### Changed
- Runner commands reorganized into Core / Revert / Inspect / Repair groups
- `dmcr deploy` now stores all three checksums, metadata fields, and logs duration
- `dmcr revert` enforces checksum policy and logs enriched events
- `dmcr verify` supports `all` and single-change modes
- Show-Help rewritten with v1.0.0 header and reorganized command reference

## [Unreleased]

- Initial release