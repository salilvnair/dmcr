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

- VS Code with GitHub Copilot Chat enabled (this extension uses the Copilot language model).
- Optional (only if you enable or extend DB introspection): `psql` available and a connection string (see settings).

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

This extension uses these settings (configure in VS Code Settings UI or in `settings.json`):

- `dmcr.changesDir` (default: `db/changes`)
  - Folder where change directories are created.
- `dmcr.idWidth` (default: `3`)
  - Width of the numeric prefix used for change folders (e.g., `002_...`).
- `dmcr.psqlPath` (default: `psql`)
  - Path to `psql` for optional schema introspection.
- `dmcr.connection` (no default)
  - Connection string for DB introspection (required only if introspection is used/enabled in your flow).

Example `settings.json`:

```json
{
  "dmcr.changesDir": "db/changes",
  "dmcr.idWidth": 3,
  "dmcr.psqlPath": "psql",
  "dmcr.connection": "postgresql://user:pass@host:5432/dbname"
}
```

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

## Release Notes
See CHANGELOG.md.