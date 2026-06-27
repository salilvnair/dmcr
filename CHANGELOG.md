# Change Log

All notable changes to the "dmcr" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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