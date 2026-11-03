# Get started

## What DMCR is

DMCR manages changes to PostgreSQL databases. You describe a change, the AI writes the SQL, DMCR test-runs it, and you save it as a folder in your git repository. Releases then deploy those folders to each environment through the runner.

### A change is a folder

Each change is one folder in the changes folder, for example `004_a_add_order_note`. It holds four files:

| File | What it does |
|---|---|
| `deploy.sql` | What the change does. |
| `verify.sql` | Raises an error when the change is applied but its objects are missing. It checks `dmcr.change_log` first. |
| `revert.sql` | Undoes `deploy.sql` exactly. |
| `meta.json` | The change id and its details: project, requested by, kind, who created it and when. |

Example of the three SQL files for a new table:

```sql
-- deploy.sql
CREATE TABLE order_note (
  id       bigint PRIMARY KEY,
  order_id bigint NOT NULL,
  note     text
);
```

```sql
-- verify.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '004_a_add_order_note') THEN
    IF to_regclass('order_note') IS NULL THEN
      RAISE EXCEPTION 'order_note is missing';
    END IF;
  END IF;
END $$;
```

```sql
-- revert.sql
DROP TABLE order_note;
```

The SQL never names a schema. Each environment runs it in its own schema (see [Key ideas](#key-ideas)). The only qualified names are those of the dmcr registry, such as `dmcr.change_log`.

### Environments

An environment is one database, for example `test` and `prod`. For each one you set:

- the connection URL (no password in it),
- the schema its SQL runs in (empty means `public`),
- the password, kept in the OS keychain.

One environment can be marked as production. DMCR uses that mark for Import, Never send to prod and the "shipped" marks on releases.

### The dmcr registry

Each database gets a `dmcr` schema that records what is applied there. It is created once per database by the setup wizard ("Set up each database").

| Table | Holds |
|---|---|
| `dmcr.change_log` | One row per applied change: change id, when, checksums, project, release, kind, requested by, created by, the deployment it came from. |
| `dmcr.event_log` | Every deploy, revert and other runner action, with its status. |
| `dmcr.tags` | Named deployment snapshots. |
| `dmcr.repeatable_log` | Repeatable (`R__`) changes and the checksum last applied. |
| `dmcr.deploy_lock` | One row held while a deploy or revert runs. |

### Releases and projects

- A **release** is a date you ship on.
- A **project** is a piece of work in a release: New, Bug fix, CR, Hotfix or Other.
- A **change** joins a project when you pick the project on its change card. Its release is its project's release, so moving a project moves all its changes.

Releases and projects are kept in `releases.json` in the changes folder. Every edit you make on the Releases tab is committed and pushed at once.

### The runner

The runner does the database work: set up, status, deploy, revert and test runs. It is `dmcr.ps1` on Windows and `dmcr.sh` elsewhere, and it calls `psql`. When you deploy from the Releases tab, the command runs in the **Runner** tab so you can watch it.

## First run: the setup wizard

Until DMCR is set up, every tab except **Settings** shows the setup wizard ("Set up DMCR"). The wizard has six steps. The current step is open; a finished step folds to one line with an **Edit** button; later steps wait their turn. The footer shows "N of 6 done" and an **Open DMCR** button, which turns on when all six are done.

| # | Step | What it asks for |
|---|---|---|
| 1 | psql | The PostgreSQL client |
| 2 | Your databases | Connection, schema and password per environment |
| 3 | Changes folder | Where change folders are created |
| 4 | Your DBA name | Your name |
| 5 | AI provider | An AI provider with a key |
| 6 | Set up each database | The dmcr registry and schema in each database |

### 1. psql

"The PostgreSQL client every database step runs."

DMCR looks for `psql` on its own. If it finds it, the step shows its version and path. If not, it shows "psql not found: install the PostgreSQL client, or give the full path to psql here". Type the full path or use **Browse**, then **Save**.

### 2. Your databases

"Per environment: the connection (no password in it), the schema its SQL runs in, and the password (kept in the OS keychain)."

1. Click **Add your first database**. The first new row is named `test`, the next `prod`; after that you type a name.
2. Fill in the row:
   - the connection, like `postgresql://user@host:5432/database`,
   - the schema (empty means `public`),
   - the password. Every database needs one.
3. Click **Test** to check the connection.
4. Click the **Production?** pill on the production database. It then reads **Production**. Only one database can be production.
5. Click **Save databases**.

A name must start with a letter and use letters, digits, `_` and `-`. **More in DMCR Config** opens the full settings.

### 3. Changes folder

"Where change folders are created: relative to the workspace, or a full path."

Type a folder such as `db/changes`, or use **Browse**, then **Save**.

### 4. Your DBA name

"Recorded on every change you build and deploy."

Type your name and click **Save** (or press Enter). DMCR does not save a change, or let you edit releases, without it.

### 5. AI provider

"Writes deploy, verify and revert in the DDL, DML, Freeform and Assistant tabs."

Click **Choose a provider**. It opens Settings > LLM Provider. The step is done once a provider is chosen and has its key.

### 6. Set up each database

"Creates the dmcr registry (what is applied where) and the environment's schema, once per database."

The wizard checks each database and shows **Ready** or **Not set up**. Click **Set up all (N)**, or **Set up \<env\>** on one row. For each database this creates:

- the `dmcr` schema and its registry tables,
- the environment's schema from step 2, if it is not `public`.

This step needs psql, your DBA name and your databases saved first. **Check again** reads the state of each database again.

When all six are done, the heading changes to "DMCR is ready". Click **Open DMCR**.

## Your first change

### 1. Describe the change

Pick a tab:

| Tab | How you describe the change |
|---|---|
| **DDL** | A form: CREATE TABLE, ALTER TABLE (add columns), CREATE SEQUENCE, GRANT, CREATE SCHEMA. |
| **DML** | A form for rows to insert, with ON CONFLICT handling. |
| **Freeform** | Paste any SQL (DDL, DML, a function). |
| **Manual** | Write `deploy.sql`, `verify.sql` and `revert.sql` yourself. No AI. |
| **Assistant** | Chat with the DMCR Assistant. |

In DDL, DML and Freeform, click **Generate DMCR request**. The AI writes deploy, verify and revert. In Manual, fill in the three SQL tabs and a name, pick an environment, and click **Self-check on \<env\>**. In the Assistant, the change card appears in the chat.

### 2. The self-check

Before you see the card, DMCR runs the change for real and rolls it back. It runs deploy, verify, revert and verify again in one transaction, then rolls it back, so nothing is left in the database.

- The forms and the Assistant test-run on the `test` environment when there is one, else on the default environment.
- In Manual you pick the environment. If you pick production, DMCR warns you: the test run is rolled back, but it still runs there.

The banner on the card shows the result:

- **Self-check passed**: deploy, verify, revert and verify passed, and the schema and data were restored exactly.
- **Self-check failed**: the error PostgreSQL reported. **Save to workspace** stays disabled until you edit the SQL. The edit is not test-run again on the card; the deploy's own round-trip test checks it.
- **Not test-run**: why not. A `danger_` change is never test-run.

If DMCR fixed something before showing the card, the banner lists it under "Fixed before you saw it".

### 3. The change card

The card shows the change name and four tabs: `deploy.sql`, `verify.sql`, `revert.sql` and `meta.json`. Use the pencil button to edit the SQL on the card.

Fill in the release fields:

| Field | What to enter |
|---|---|
| **Project** | The project from `releases.json`. Without projects it reads "(no releases.json yet: add projects in Releases)". |
| **Requested by (developer)** | The developer who asked for the change. |
| **Kind** | Leave "auto (from deploy.sql)", or pick insert, update, delete, dml, ddl, function, type or other. |

DMCR remembers the last project you picked and the developer you named for each project.

### 4. Save to workspace

Click **Save to workspace**. DMCR:

- gives the change the next free number,
- puts the project id in the folder name,
- writes the four files,
- adds `project`, `requested_by`, `kind`, `created_by` (your DBA name) and `created_at` to `meta.json`.

The card then shows "Saved to" and the folder path. Example `meta.json`:

```json
{
  "change_id": "004_a_add_order_note",
  "description": "add order note",
  "requires": [],
  "tags": [],
  "author": "",
  "project": "A",
  "requested_by": "Priya",
  "created_by": "Sam",
  "created_at": "2026-11-01"
}
```

DMCR refuses to save when:

- your DBA name is not set,
- `revert.sql` would empty or rewrite a whole table (TRUNCATE, or a DELETE or UPDATE of every row),
- the same `deploy.sql` is already saved as another change.

If you change the project, requested by or kind after saving, click **Save details** to write them to `meta.json`.

### 5. Commit

Click **Commit**. DMCR commits the change folder, and pushes when the repository has a remote. If the pull before the push brings in a change with the same number, DMCR moves your change to a free number and the card follows the new folder.

If **Auto-commit** is on in Settings > DMCR Config, DMCR commits and pushes each new change on its own.

## Deploying a release

### 1. Create a release and its projects

On the **Releases** tab:

1. Click **New release**. Pick the release date (it fills the release id), add a name, and **Save**.
2. Click **New project** (or **Add a project** on a release). Give it a project id, a name, a type (New, Bug fix, CR, Hotfix, Other) and its release. **Save**.
3. Assign changes: pick the project on the change card when you save, or in the changes table on this tab.

Changes with no project are not deployed by a release deploy.

### 2. Pick the environment

Use the **Environment** picker at the top. Each release card shows how many of its changes are on that environment, for example "3/5 on test", with the pending count.

### 3. Deploy

Click **Deploy** on the release card.

1. A preview opens: "Deploy release \<id\> to \<env\>", "Dry run: nothing has been applied yet." It lists the changes that will be deployed, in order, and the ones this deploy skips.
2. If the environment would refuse the deploy, the preview says why, and **Deploy in Runner** stays off.
3. Click **Deploy in Runner**. DMCR switches to the Runner tab and runs the deploy there.

When every change of the release is on the chosen environment, the card shows **All on \<env\>** instead of **Deploy**.

To ship to production, pick the production environment in the picker and deploy the same release again.

## Key ideas

### Change id and folder numbering

The folder name is the change id, for example `004_a_add_order_note`. The number has three digits and is the next free number in the changes folder, given when you save. The id is what `dmcr.change_log` records. One numbered sequence covers all projects, so there is one deploy order. Repeatable changes are named `R__<name>` and have no number.

### Project prefix in folder names

When a change has a project, the project id (lowercase, as a slug) goes after the number: project `A` gives `004_a_...`. You can see which project a change belongs to from its folder name.

### danger_ changes (manual-only)

A change whose `deploy.sql` matches a danger rule (for example DROP TABLE, DROP COLUMN, TRUNCATE, or a DELETE or UPDATE without WHERE) is saved with `danger_` in its name. DMCR never test-runs or deploys a `danger_` change. The Releases tab lists the ones waiting on an environment, with:

- **Script for DBeaver**: one script with the deploy, the registry record and verify, in one transaction, to run by hand in DBeaver or psql;
- **Mark applied**: for a change that already ran by hand; DMCR checks it with `verify.sql` first.

### Never send to prod

A change marked "Never send to \<prod\>" stays on the other environments and never goes to production. You set it on the change's row on the Releases tab (the lock button). DMCR writes the allowed environments to `meta.json` (`environments`), and the deploy skips the change on production. Which environment is production is set in the setup wizard or in DMCR Config.

### The environment's schema

Each environment has a schema, set in the wizard or in DMCR Config. DMCR runs every change with that schema as the session `search_path` (then `public`). So change SQL never names a schema: `CREATE TABLE orders`, not a schema-qualified name. One set of files runs on every environment. In catalog checks, use `to_regclass('orders')` or `current_schema()`. The dmcr registry is the one exception and stays qualified: `dmcr.change_log`.

### The dmcr registry

The `dmcr` schema in each database records what is applied there (`dmcr.change_log`) and every action (`dmcr.event_log`). DMCR reads it to know which changes are applied or pending. The setup wizard creates it once per database.

### DBA name vs requested by

| | Who | Where it goes |
|---|---|---|
| **DBA name** | You, the DBA who builds and deploys changes. Set once in the setup wizard or Settings > DMCR Config. | `created_by` in `meta.json`; the actor on deploys run from DMCR. |
| **Requested by** | The developer who asked for the change. Set per change on the change card. | `requested_by` in `meta.json` and `dmcr.change_log`. |

# Writing changes

## The change folder

Every change is one folder in the changes folder of your repository. It holds four files:

| File | What it does |
|---|---|
| `deploy.sql` | Applies the change. |
| `verify.sql` | Checks the database is in the right state, applied or reverted. |
| `revert.sql` | Undoes `deploy.sql`. |
| `meta.json` | Who, why, which project, what it depends on. |

Change SQL never names a schema. Write `orders`, not `public.orders`. Each environment's schema (Settings > DMCR Config) is the session `search_path`, so the same files run on every environment. The only qualified names are DMCR's own tables: `dmcr.change_log`, `dmcr.repeatable_log` and the `dmcr.bak_<change id>` backup tables.

### deploy.sql

The change itself. The runner runs `deploy.sql`, writes the `dmcr.change_log` row and runs `verify.sql` in one transaction. If any part fails, nothing is applied.

If `meta.json` has `"transaction": false`, `deploy.sql` runs statement by statement outside a transaction (for example `CREATE INDEX CONCURRENTLY`). The registry row and `verify.sql` then run in a transaction after it.

### verify.sql

`verify.sql` is a `DO $$ ... $$` block that checks both states. It looks at `dmcr.change_log` to know which state to expect:

- `IF EXISTS (... change_id = '<this change>')`: the change is applied. Assert what `deploy.sql` made (the column exists, the rows exist).
- `IF NOT EXISTS (...)`: the change is not applied. Assert what `revert.sql` leaves (the column is gone, the rows are gone).

The two blocks are separate `IF` blocks, with no `ELSE`. A column or table that exists in only one state is named only inside that state's block.

This works because of when the runner calls it:

- Deploy: `deploy.sql`, then the `dmcr.change_log` row is inserted, then `verify.sql`. The first block is checked.
- Revert: `revert.sql`, then the `dmcr.change_log` row is deleted, then `verify.sql`. The second block is checked. Both run in one transaction; if verify fails, the change stays recorded as applied.

While a change is being written, its id is the placeholder `__DMCR_CHANGE_ID__`. On save, DMCR replaces it with the folder name in all three SQL files.

```sql
-- verify: email column on customers
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = 'email') THEN
      RAISE EXCEPTION 'customers.email is missing';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = 'email') THEN
      RAISE EXCEPTION 'customers.email should not exist after revert';
    END IF;
  END IF;
END $$;
```

A repeatable (`R__`) change is recorded in `dmcr.repeatable_log`, not `dmcr.change_log`. Its `verify.sql` checks `dmcr.repeatable_log` and only the applied state.

### revert.sql

Undoes `deploy.sql` and brings the database back to exactly where it was. It does not touch `dmcr.change_log`; the runner removes the row itself.

DMCR refuses to save a change whose `revert.sql` would wipe data the change does not own: a `TRUNCATE` (and any other "always" danger rule), or a `DELETE` / `UPDATE` with no `WHERE` (or a `WHERE` that is always true, such as `WHERE 1=1`), as switched on in Settings > Danger Rules. The message starts with `Not saved: revert.sql has ...`.

### meta.json

DMCR writes `meta.json` on save. The runner reads it at deploy. Fields:

| Field | Set by | Used for |
|---|---|---|
| `change_id` | DMCR on save: always the folder name | The id in `dmcr.change_log`. |
| `description` | The AI, the Assistant's Change Metadata form, or the Manual tab's Name | A short summary. |
| `tags` | The form's Tags field, or the AI | Labels. |
| `requires` | The form's Requires field, or Deps on the Assistant card | Change ids that must be applied first. Deploy stops with `'<id>' requires '<other>', which is not applied` otherwise. A cycle in `requires` blocks the deploy. |
| `author` | The form's Author field | Kept in `meta.json`. |
| `ticket` | The form's Ticket field | Recorded in `dmcr.change_log.ticket_id` at deploy. |
| `project` | Project on the change card | The project in `releases.json`; the change's release is that project's release. Recorded in `dmcr.change_log`. |
| `requested_by` | Requested by (developer) on the change card | Recorded in `dmcr.change_log`. |
| `kind` | Kind on the change card | `insert`, `update`, `delete`, `dml`, `ddl`, `function`, `type` or `other`. Not set: the runner infers it from `deploy.sql` (DMCR's own `dmcr.bak_*` statements do not count). Recorded in `dmcr.change_log`. |
| `created_by` | Your DBA name (Settings > DMCR Config > DBA name) | Recorded in `dmcr.change_log`. Saving is refused until the DBA name is set. |
| `created_at` | The save date (`YYYY-MM-DD`) | When the change was written. |
| `environments` | Releases page | The only environments the change may go to. Missing means every environment. Deploys elsewhere skip it. |
| `status`, `dropped_reason`, `dropped_by`, `dropped_at` | Drop on the Releases page | `"status": "dropped"` keeps the folder; every deploy skips it. |
| `transaction` | You or the AI | `false` runs `deploy.sql` outside a transaction (see above). |

Example after save:

```json
{
  "change_id": "007_prj_b_add_email_to_customers",
  "description": "Add an email column to customers.",
  "tags": ["ddl", "schema"],
  "requires": ["004_prj_b_create_customers"],
  "author": "",
  "ticket": "PA-1",
  "project": "PRJ-B",
  "requested_by": "dev.name",
  "created_by": "dba.name",
  "created_at": "2026-10-30"
}
```

### Folder names

DMCR names the folder when you save. The pattern is:

```text
NNN_[danger_][project_]name
```

- `NNN`: the next free number, one above the highest folder number, padded to three digits (`001`, `002`, ...). A number the AI put in the name is dropped.
- `danger_`: added when `deploy.sql` matches a danger rule (see [Manual-only (danger_) changes](#manual-only-danger_-changes)). During AI generation, a draft named `danger_` whose fixed SQL no longer matches loses the prefix.
- `project_`: the project from the change card, in lowercase, unless the name already starts with it.
- `name`: lowercase letters, digits and underscores, up to 60 characters. It must start with a letter.

Examples: `003_prj_a_insert_lookup_codes`, `008_danger_prj_b_drop_legacy_orders`.

When Commit pulls in another DBA's change with the same number, your folder moves to the next free number and the card follows it.

### Repeatable (R__) changes

Tick **Repeatable migration R__** on the Freeform tab. The folder is `R__<name>`: no number and no project prefix. Saving again updates the same folder.

- The runner re-applies it whenever `deploy.sql` changes, so `deploy.sql` must be safe to run again and again (`CREATE OR REPLACE`, `IF NOT EXISTS`).
- It is recorded in `dmcr.repeatable_log`.
- DMCR does not revert repeatables. `revert.sql` is there for running by hand.
- A dangerous change cannot be repeatable. Save it as a numbered `danger_` change instead.

### Other save checks

- Same `deploy.sql` as a saved change: `Already saved as <id>`. Nothing is written.
- No DBA name: `Set your DBA name first (Settings > DMCR Config > DBA name).`

## DDL tab

Structure changes from a form: tables, columns, sequences, schemas and grants. You fill in the form, the AI writes deploy, verify and revert, and the result opens on the [change card](#the-change-card).

### Action

| Action | What you fill in |
|---|---|
| CREATE TABLE | Tables, plus optional Schema, Sequence and grants. |
| ALTER TABLE — add columns | Tables and the columns to add, plus optional Schema, Sequence and grants. |
| CREATE SEQUENCE | Sequence and Sequence GRANTs. |
| GRANT — table privileges | Tables to grant on (one per line or comma-separated) and Table GRANTs. |
| GRANT — sequence privileges | Sequence to grant on and Sequence GRANTs. |
| CREATE SCHEMA | Schema name and Schema GRANTs. |

### Fields

- **Tables**: a table name, then rows of **Column name** and **Data type**. Pick `custom…` in Data type and type the full type with constraints in **Custom type** (for example `numeric(12,2) NOT NULL`). Buttons: **Add column**, **Add table**, **Duplicate last table**. **Use same columns for all tables** gives every table the first table's columns.
- **Table GRANTs**: a role name and `SELECT`, `INSERT`, `UPDATE`, `DELETE`.
- **Schema**: **Create schema (if not exists)**, the schema name, and **Schema GRANTs** (`USAGE`, `CREATE`).
- **Sequence**: **Create sequence**, the sequence name, `START WITH`, `INCREMENT BY`, `MINVALUE`, `MAXVALUE`, `CACHE`. **Load example** fills in a sample.
- **Sequence GRANTs**: a role name and `USAGE`, `SELECT`, `UPDATE`.
- **Change name hint (optional)**: the name part of the folder name, in snake_case.
- **Metadata** (optional; the AI fills what you leave empty): **Tags**, **Ticket**, **Requires**, **Author**.

Click **Generate DMCR request**. The form checks its own fields first (for example, a grant needs a role and at least one privilege).

## DML tab

Insert rows into one table from a grid. The result opens on the [change card](#the-change-card).

### Fields

- **Target Table**: the table name, without a schema. **Load example** fills in a sample table, columns and rows.
- **Columns**: **Column name** and **Data type** for each column. For `varchar` and `custom…`, **Type detail** holds the full type (for example `varchar(100)`).
- **Rows**: one grid row per row to insert. **Add row**, **Clear rows**.
- **Idempotency (recommended)**: **Idempotent (use ON CONFLICT)** (on by default), the conflict target columns, the action (**ON CONFLICT DO NOTHING** or **ON CONFLICT DO UPDATE**), and for DO UPDATE the columns to update (blank means all non-key columns). These settings are passed to the AI with the rows.
- **Change name hint (optional)**.
- **Metadata**: **Tags**, **Ticket**, **Requires**, **Author**.

Click **Generate DMCR request**.

### What it produces

`deploy.sql` inserts the rows, `revert.sql` deletes exactly those rows by their key, and `verify.sql` checks the rows exist when applied and are gone when reverted. See [Data changes and backups](#data-changes-and-backups).

## Freeform tab

Any SQL the DDL and DML tabs do not cover: functions, views, triggers, indexes, updates. You paste the SQL you want deployed; the AI writes verify and revert around it. The result opens on the [change card](#the-change-card).

### Fields

- **Current SQL (deploy)**: your SQL. It is parse-checked as you type (`SQL valid` or the parse error). Generation waits until it parses.
- **Previous version** (shown only when your SQL replaces a function, procedure or view): the definition `revert.sql` restores, word for word. DMCR looks it up itself, first in the newest change in the repository, else in the live test database. A note says where it was found, or that the object is new (revert then drops it).
  - **Override**: paste or edit the definition yourself, for example when the object exists only on prod.
  - **Use DMCR's**: drop your text and look it up again.
- **Change name hint**.
- **Repeatable migration R__**: makes an `R__` change (see [Repeatable (R__) changes](#repeatable-r__-changes)).
- **Metadata**: **Tags**, **Ticket**, **Requires**, **Author** (defaults to your git user name).

Tip from the form: put a uniqueness key in a comment so revert can delete DML rows safely.

Click **Generate DMCR request**.

## Manual tab

Write deploy, verify and revert yourself. No AI and no MCP. DMCR only test-runs the change on the environment you pick, then you save and commit it like any other change.

### Fields

- Tabs **deploy.sql**, **verify.sql**, **revert.sql**, each with an editor. On an empty verify.sql, **DMCR verify template** inserts a `DO` block gated on `dmcr.change_log`.
- **Change**: **Name** (becomes the folder name and the description), **Tags**, **Ticket**, **Requires**, **Author** (your git user name by default).
- **Self-check**: one button per environment in `dmcr.cfg`. A test environment is picked first. On production a warning says the test run is rolled back but still runs there.

The checklist must be complete before **Self-check on &lt;env&gt;** is enabled: a name, and all three files written. A `verify.sql` that does not mention `dmcr.change_log` gets a warning.

The self-check result opens on the [change card](#the-change-card). **Back to your SQL** returns to the editor. Nothing is fixed for you: if it fails, change your SQL and run it again.

## Assistant tab

Chat to build a change. Describe it in plain words ("add an email column to customers"). The Assistant also answers questions about DMCR and, with a database MCP server, about your tables.

### How a change is made

1. You describe the change. Optional: type a **Change Name Hint** in the bar at the top; it wins over the name the AI proposes.
2. The **Change Metadata** form appears, filled in from your message: **Description**, **Tags (comma-separated)**, **Ticket (change request)**, **Requires (dependencies)**, **Author**. Requires suggests only changes your message names, or changes that created a table you mention.
3. Click **Confirm & Generate**, or **Skip — generate without metadata**.
4. The change appears on a change card in the chat.

To adjust the last change, ask in the same chat ("make that column NOT NULL", "also add a created_at column"). The Assistant changes the generated change instead of starting a new one.

Other buttons in the top bar: discover schemas and tables (with a database MCP server), export the conversation as Markdown, and browse conversation history.

## The change card

Every tab ends on a change card. It shows the generated change before anything is written. Nothing is in your repository until you click **Save to workspace**.

### Header

The change name, with a `danger_` chip for a [manual-only change](#manual-only-danger_-changes) and an `R__ repeatable` chip for a repeatable. A name that is not lowercase snake_case shows a warning and cannot be saved.

On the form tabs, **Save location (relative to workspace root)** chooses the folder; leave it empty for the configured changes folder (**Browse** picks one).

### Self-check

Before you see the card, DMCR runs the change for real with the runner's `test` command:

1. Copies the changes folder to a temporary folder and adds this change as the next folder.
2. Runs deploy, verify, revert, verify for it (and every pending change before it) in one transaction.
3. Rolls the transaction back. Nothing is left in the database. Schema and data must come back exactly.

It runs on the `[test]` environment of `dmcr.cfg` if there is one, else the default environment. On the Manual tab it runs on the environment you picked.

The banner shows one of:

| Title | Meaning |
|---|---|
| Self-check passed | `Test-run on <env>: deploy, verify, revert and verify passed; schema and data restored exactly (rolled back).` |
| Self-check failed | `Test-run on <env> failed.`, with the PostgreSQL error. |
| Not test-run | The change could not be tested, with the reason (no `dmcr.cfg`, no changes folder, an earlier pending change fails its own round trip, or a `danger_` change). |

When a generated change fails, DMCR sends the exact error back to the AI and tests the corrected version, up to two times. Each error fixed this way is listed as **Fixed before you saw it: &lt;error&gt;**. If a fix could not be used, a note says why.

A `danger_` change is never test-run: `A manual-only (danger_) change is never test-run: the DBA runs it by hand.`

### Previous definition

When `deploy.sql` replaces a function, procedure or view, the banner says how `revert.sql` was made:

- `Revert restores <object> word for word, from <source>`: revert is exactly the previous definition.
- `Revert puts back <object> word for word, from <source>`: the previous definition is placed in the AI's revert.
- `New: <object> was not defined before, so revert drops it`.

The source is a change in the repository, the live test database, or the Freeform tab's Previous version.

### Already added by another change

If this change adds a column, table, type or sequence that a saved change already adds, the banner lists that change and says not to save this one. Changes that need the object should require the existing change instead.

### Lock risks

DMCR checks `deploy.sql` for statements that take a long lock or rewrite a table on a live database. Findings are advisory and never block a save. Each one shows the line, why it matters, and **Safer:** what to write instead. Tables created earlier in the same `deploy.sql` are not checked.

| Rule | Finding |
|---|---|
| `index-without-concurrently` | `CREATE INDEX` without `CONCURRENTLY` blocks writes. Use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` with `"transaction": false`. |
| `alter-column-type` | A type change rewrites the table (a notice only for text / varchar). |
| `set-not-null` | `SET NOT NULL` scans the table, unless a validated `CHECK (col IS NOT NULL)` comes first. |
| `constraint-without-not-valid` | `FOREIGN KEY` / `CHECK` without `NOT VALID`. |
| `unique-without-index` | `PRIMARY KEY` / `UNIQUE` without `USING INDEX`. |
| `volatile-default` | A new column with `now()`, `random()`, `gen_random_uuid()`, `nextval` and similar defaults. |
| `rename` | A rename breaks running queries and applications (notice). |
| `table-rewrite` | `VACUUM FULL`, `CLUSTER`. |
| `reindex-without-concurrently` | `REINDEX` without `CONCURRENTLY`. |

### Project, Requested by, Kind

- **Project**: a project from `releases.json` (dropped projects are not offered). Without a `releases.json` it says to add projects in Releases.
- **Requested by (developer)**: the developer who asked. DMCR remembers it per project.
- **Kind**: `auto (from deploy.sql)` or one of `insert`, `update`, `delete`, `dml`, `ddl`, `function`, `type`, `other`.

They go into `meta.json` on save. If you change them after saving, **Save details** writes them to the saved `meta.json`; then commit again.

### The file tabs

**deploy.sql**, **verify.sql**, **revert.sql**, **meta.json**. Each tab has a copy icon. Under the code, each SQL file is parse-checked with PostgreSQL's parser (a check mark, or the parse error); `meta.json` is checked as JSON.

### Edit

The pencil (**Edit SQL**) opens the current tab in an editor. The eye (**Back to view mode**) returns. Your edits are what gets saved. On the Assistant card an `edited` chip appears, and **Show what you changed** shows a diff.

### Save to workspace

**Save to workspace** writes the folder (see [Folder names](#folder-names)). DMCR stays in front: no editor tab opens. The card then shows **Saved to** with the folder path and **Reveal in Explorer**.

**Cancel** before saving asks **Discard unsaved changes?**. After saving, **Close** returns to an empty form.

If Settings > DMCR Config > **Auto-commit** is on, DMCR commits and pushes each new change as soon as it is saved.

### Commit

**Commit** commits the saved folder, and pushes when the repository has a remote (it pulls first, so other DBAs' work comes in). The button becomes a chip:

- `Committed <hash>` with `pushed`: committed and pushed.
- `Committed <hash>` with `local only`: no git remote; committed locally.
- `Committed` with `nothing new`: there was nothing to commit.

If the pull brought in commits, or the push did not happen, a note next to the chip says so. Commit is disabled while there are unsaved detail changes (use **Save details** first).

### Deps (Assistant card)

With **AI Dependency Analyzer** switched on in Settings > AI Features, the Assistant card has a **Deps** button. The AI looks at your existing changes and lists the ones this change depends on, or `No dependencies found`. Click a name to open that change; click the arrow next to it to add it to `requires` in `meta.json`.

## Manual-only (danger_) changes

### What makes a change danger_

On save, DMCR checks `deploy.sql` (comments ignored) against the danger rules. The rules come from `dmcr_danger.json`; you edit them in Settings > Danger Rules. The defaults:

| Rule set | Patterns |
|---|---|
| Deploy-only patterns (checked in `deploy.sql`) | `DROP TABLE`, `DROP SCHEMA`, `DROP DATABASE`, `DROP FUNCTION`, `DROP PROCEDURE`, `DROP VIEW`, `DROP TRIGGER`, `DROP INDEX`, `DROP SEQUENCE`, `DROP TYPE`, `DROP EXTENSION`, `DROP COLUMN` |
| Always patterns (checked in `deploy.sql` and `revert.sql`) | `TRUNCATE` |
| Extra checks | `DELETE` without `WHERE`: on. `UPDATE` without `WHERE`: off. |

"Without WHERE" means a real `DELETE FROM` / `UPDATE ... SET` statement with no `WHERE`, or with one that is always true (`WHERE true`, `WHERE 1=1`, `WHERE 'a'='a'`). `ON DELETE CASCADE`, `GRANT DELETE` and `ON CONFLICT ... DO UPDATE SET` do not count.

A match adds `danger_` to the folder name. `CREATE` statements, `IF NOT EXISTS` guards and `GRANT` are not dangerous.

Only `deploy.sql` is checked against the DROP rules. A `revert.sql` that drops what the change created, including DMCR's own `dmcr.bak_<change id>` backup table, does not make the change `danger_`.

### What DMCR does with them

- The change card self-check never test-runs them.
- Deploy never runs them. They are skipped (status `manual`) and nothing is recorded.
- Revert refuses them. The DBA reverts by hand.
- A repeatable is never `danger_`.
- If someone adds dangerous SQL to an ordinary change after it was saved, deploy blocks it and suggests the `danger_` name.

### Running one by hand

On the Releases page, a banner lists the manual changes waiting on the selected environment: **N manual change(s) waiting on &lt;env&gt;**. Each has two buttons.

**Script for DBeaver** builds one script for that environment:

1. `BEGIN`, the environment's `lock_timeout` and `search_path`.
2. A check that refuses if the change is already applied.
3. `deploy.sql`.
4. The `dmcr.change_log` row and a `dmcr.event_log` entry (recorded "by hand").
5. `verify.sql`.
6. `COMMIT`.

All of it commits, or nothing does. Copy it (**Copy script**) or save it (**Download .sql**), and run it as a script in DBeaver (Execute SQL Script, Alt+X) or with `psql -f`. Then click **I ran it: refresh &lt;env&gt;**. When the environment requires approval, the script refuses to run until the change is approved.

**Mark applied** is for a change you already ran another way. **Verify and mark applied** records the change in the registry on that environment, then runs its `verify.sql`. If verify does not pass, the record is undone and nothing changes. If you used Script for DBeaver, there is nothing to mark: the script records it itself.

### Reverting

DMCR never reverts a `danger_` change. Run its `revert.sql` by hand.

## Data changes and backups

These are the rules DMCR gives the AI for changes that touch rows (from the generation prompt). Check the card's SQL against them.

### Changing or deleting existing rows

Data that a change deletes, or overwrites with values that cannot be recomputed, is kept so revert can put it back exactly.

- `deploy.sql` first copies the affected rows (or their old values) into a backup table, then changes the data.
- The backup table is `dmcr.bak_<change id>`. It is written as `dmcr.bak___DMCR_CHANGE_ID__`; DMCR fills in the change id on save, so two changes never share a backup table.
- It is made once, with `CREATE TABLE dmcr.bak_<change id> AS SELECT ...`. Never `CREATE TABLE IF NOT EXISTS ... (LIKE ...)` followed by `INSERT` or `DELETE`.
- Backups are keyed by the table's primary key, never `ctid`.
- `revert.sql` puts the rows back from the backup (`INSERT ... OVERRIDING SYSTEM VALUE` for identity columns, or `UPDATE ... FROM` the backup), then drops the backup table.
- A restore `UPDATE` that would fire a trigger changing other columns (such as `updated_at`) is wrapped in `ALTER TABLE ... DISABLE TRIGGER <name>` / `ENABLE TRIGGER <name>`.
- No row values from one database are hard-coded: test and prod hold different data.
- A revert that re-creates a dropped column uses its full original definition (type, `NOT NULL`, `DEFAULT`).

Example of the shape, as saved in folder `012_prj_b_close_stale_orders`:

```sql
-- deploy.sql
CREATE TABLE dmcr.bak_012_prj_b_close_stale_orders AS
  SELECT id, status FROM orders WHERE status = 'open' AND created_at < date '2025-01-01';

UPDATE orders SET status = 'closed'
 WHERE id IN (SELECT id FROM dmcr.bak_012_prj_b_close_stale_orders);
```

```sql
-- revert.sql
UPDATE orders o SET status = b.status
  FROM dmcr.bak_012_prj_b_close_stale_orders b
 WHERE o.id = b.id;

DROP TABLE IF EXISTS dmcr.bak_012_prj_b_close_stale_orders;
```

The backup statements do not decide the change's kind: the runner ignores `dmcr.*` statements when it infers it.

### Seed inserts

How new rows are written depends on whether the insert is idempotent (the DML tab's **Idempotent (use ON CONFLICT)**):

- **Not idempotent:** `deploy.sql` is a plain `INSERT ... VALUES` with no `ON CONFLICT`, and no backup table. A row whose key already exists fails the deploy. `revert.sql` deletes exactly those rows by their key: `WHERE <key> IN (...)`.
- **Idempotent, ON CONFLICT DO NOTHING:** rows already there are skipped, so `deploy.sql` records the keys it really inserted in `dmcr.bak_<change id>`, and `revert.sql` deletes only those. A row that existed before the change is never removed.
- **ON CONFLICT DO UPDATE:** it overwrites rows that were there, so their old values are backed up first and `revert.sql` puts them back.

Sequences are not set with `setval`; the identity or serial column fills itself.

```sql
-- deploy.sql
INSERT INTO order_status (code, label) VALUES
  ('HOLD', 'On hold'),
  ('BACK', 'Backordered');
```

```sql
-- revert.sql
DELETE FROM order_status WHERE code IN ('HOLD', 'BACK');
```

# Releases and teamwork

## Releases tab

The Releases tab plans what ships and when. You put **projects** into **releases**, deploy one release at a time to an environment, mark work as **not going**, and roll back by release, by project or by kind of change.

You need a DBA name first (Settings > DMCR Config). Until it is set, New release, New project, Deploy, Roll back and Archive are disabled, and the tab shows **Your DBA name is required.** with a **Set DBA name** button.

### Releases and projects

A **release** is a date you ship on.

| Field | Notes |
|---|---|
| Release id | Letters, digits, dots, dashes and underscores. Picking a date fills it. |
| Name | Optional. Shown on the card instead of the id. |
| Release date | `YYYY-MM-DD`. |
| Status | `planned`, `deployed` or `cancelled`. |

- The id can change only while nothing of the release is deployed on any environment. Its projects move with it. Once a change of the release is deployed, the id is fixed (the registry records the release id).
- **Delete release** asks you to type the release id first. Its projects and changes are kept: the projects move to **Unscheduled projects**, and release deploys skip them until they are in a release again. A release with a change deployed on any environment cannot be deleted; archive it instead.
- Every edit on this tab (a release, a project, a date, **Not going**, **Restore**, a move, a delete, a zero-downtime change) is committed and pushed at once. While that runs, the row's button shows **Saving…**, a banner says so, and the other edits wait.

A **project** is a piece of work inside a release. Every change belongs to one project.

| Field | Notes |
|---|---|
| Project id | Fixed once the project exists. |
| Name | Optional. |
| Type | New, Bug fix, CR, Hotfix, Other. |
| Release | A release, or `(unscheduled)`. |
| Status | `active: goes out with its release`, or `not going: deploy skips its changes`. |
| Reason | Asked for when the status is not going. |

- **Move** a project: open **Edit / move** on its row and pick another release. Its changes follow it.
- **Not going**: the project stays in the plan, but a release deploy skips its changes. **Restore** brings it back.
- Projects with no release show in an **Unscheduled projects** card.

### Archive and auto-archive

- **Archive** on a release card moves it out of the active view. The button is green once the release is shipped to production. Archiving a release that is not fully on production only hides it.
- The **Releases** picker in the header switches between **Active (N)** and **Archived (N)**. In the Archive view each release is one line; click it to open the full card. **Unarchive** puts it back.
- Archived releases are still seen by deploys, rollbacks and the runner.
- **Auto-archive**: once every environment has been read, DMCR archives a release whose date has passed and whose going changes are applied on every environment. The line shows `auto-archived <date>`.
- A release you unarchive by hand while it is fully deployed everywhere is marked to stay active, so auto-archive leaves it alone.

### releases.json

Releases and projects are stored in `releases.json` in the changes folder. Its shape:

```json
{
  "releases": [
    { "id": "2026-11-14", "name": "November", "date": "2026-11-14", "status": "planned" }
  ],
  "projects": [
    { "id": "billing-v2", "name": "Billing v2", "type": "new", "release": "2026-11-14", "status": "active" },
    { "id": "promo-fix", "type": "bugfix", "release": "2026-11-14", "status": "dropped", "dropped_reason": "Moved to Q1" }
  ]
}
```

- Every edit you make on the tab is saved, committed and pushed at once (when the folder is a git repository and has a remote). The other DBA and CI never deploy from an older plan. The notice under the toolbar says what was committed.
- Before saving, DMCR checks the file: every release and project has an id, no id is listed twice, dates are `YYYY-MM-DD`, a project names a release that exists, and the project type is one of the allowed ones. A problem stops the save and shows the reason.
- **Commit releases.json** appears only when `releases.json` has edits git has not committed, for example edits made outside DMCR. It commits the file, and pushes when the repository has a remote.
- If the file cannot be read, the tab shows `releases.json could not be read:` and the error.

### Environment picker and stats

- **Environment** lists the environments from DMCR Config. The tab remembers the one you looked at last. The production environment is shown in red.
- **Refresh** reads the environment again.
- If DMCR is not set up on the environment yet, the tab offers **Set up DMCR on <env>**. It creates the registry (the `dmcr` schema) and the environment's schema.
- If changes are applied on the environment but their folders are not in your copy, a notice names them and who deployed them, with a **Pull** button.

The four tiles at the top:

| Tile | Sub-line |
|---|---|
| Releases | how many are planned |
| Projects | how many are not going |
| Changes | how many are applied on the selected environment |
| No project | `skipped by release deploys` |

### Release card

| Part | What it shows or does |
|---|---|
| Date tile, name, status | `shipped` is added when every going change is on production. |
| Sub-line | Release id, number of projects, `last deployed on <env> <time>`. |
| Progress | `applied/total on <env>`, `N pending`, `N not going`. Not-going changes do not count in the total. |
| **Approve N** / **Approved** | Only when the environment needs a sign-off. See [Deploying and rolling back](#deploying-and-rolling-back). |
| **Deploy** | Opens the deploy preview. Disabled while the release has no changes. |
| **All on <env>** | Replaces Deploy when every change of the release is already applied there. |
| **Roll back** | Opens the rollback dialog for this release. Disabled when nothing of it is applied. |
| **Edit** | Opens the release fields. |
| **Archive** | See above. |

A release with no projects shows **Add a project**.

### Project rows

Each project row in a release card shows its type, id, name, how many changes and of which kinds, how many are applied on the environment, and `not going: <reason>` when dropped.

| Button | Action |
|---|---|
| **Edit / move** | Change the name, type, release or status. |
| **Not going** / **Restore** | Mark the project not going (asks for a reason), or bring it back. |
| **Roll back** | Roll back this project on the environment. Disabled when none of its changes is applied. |

Click the row to open the files of all its changes.

### Toolbar

**New release**, **New project**, **Zero-downtime change**, **Import from <env>** (only while the tab shows production), **Commit releases.json** (only when needed), **Set up CI**, **Roll back**.

## The Changes table

The Changes card lists every change folder. Click a row to open its files.

### Columns

| Column | Content |
|---|---|
| Change | The change id. |
| Project | The project chip. |
| Kind | From `meta.json`, or worked out from the SQL. A lock-risk chip shows when `deploy.sql` has lock risks. |
| Requested by | The developer who asked for it. |
| Created by | The DBA who created it. |
| <env> | The state on the selected environment. |

With more changes than fit on a page, a search box, a project filter (**Every project**) and state filters show: **Not on <prod>**, **Shipped**, **All**, **Pending**, **Applied**, **Not going**, **Not for <env>**.

### State chips

| Chip | Meaning |
|---|---|
| `applied` | Applied on this environment. |
| `pending` | Not applied here yet. A release deploy runs it. |
| `manual` | A `danger_` change not applied here. Deploy never runs it. The row is red. |
| `not going` | Dropped. Deploy skips it everywhere. |
| `not for <env>` | Its `meta.json` limits it to other environments. Deploys here skip it. |
| `never to <prod>` / `only <envs>` | Which environments it may go to. |
| `needs approval` / `re-approve` / approver name | Only when the environment needs a sign-off. `re-approve` means its files changed after the approval. |

### Row actions

| Icon | Action |
|---|---|
| Script for DBeaver | Manual rows only. See below. |
| Mark applied | Manual rows only. See below. |
| Round-trip test | Pending rows that are not `danger_`. Not on production. |
| Pencil (Edit) | Edit the change's `meta.json` fields. |
| Lock (Never send to <prod>) | Keep the change off production. |
| Open lock (Send to <prod> again) | Undo Never send to prod. |
| Drop / Restore | Mark the change not going, or bring it back. |

### Edit

The pencil edits four fields in the change's `meta.json`: **Project**, **Kind** (`auto: <kind>` or one of `insert`, `update`, `delete`, `dml`, `ddl`, `function`, `type`, `other`), **Requested by** and **Ticket**.

When the change is applied on the selected environment, only the ticket can change. Roll it back to move it to another project.

Saving writes `meta.json` and commits it at once (and pushes when the repository has a remote), like every edit on this tab. The same goes for **Drop**, **Restore** and **Never send to prod**: the other DBA and CI never work from an older copy.

### Never send to prod

The lock icon opens **Keep off <prod>**. **Never send to <prod>** writes the other environments into the change's `meta.json`:

```json
{ "environments": ["test"] }
```

Effects:

- Deploys to production leave it out, and its release does not count it as pending there.
- A change that requires it is refused on production.
- Schema Diff (test vs prod) lists what it creates as an expected difference.

The lock is disabled when the change is already on production: roll it back there first. **Send to <prod> again** removes the limit. The icons show only when there are two or more environments and a production environment is set.

### Drop and Restore

**Drop** asks for a reason and marks the change not going. The folder stays in the repository; deploy skips it in every environment until you restore it. Drop is disabled when the change is applied on the selected environment: roll it back first. **Restore** clears the drop.

### Round-trip test

**Round-trip test** in the Changes header opens a picker of pending changes. A row's test icon opens it with that change ticked. The test runs in the Runner tab: deploy, verify, revert, verify, all rolled back. It is disabled when the selected environment is production.

A deploy runs the same test by itself first, on the changes it would apply, and is refused if one fails. See [Round-trip test before a deploy](#round-trip-test-before-a-deploy).

### Manual changes

A change whose folder name contains `danger_` is manual. Deploy never runs it.

When manual changes are waiting on the selected environment, a red banner says `N manual changes waiting on <env>`. It lists the first 3, each with **Script for DBeaver** and **Mark applied**. **Show all (N)** opens the full list.

**Script for DBeaver** builds one script for this environment: deploy, the DMCR registry record and verify, in one transaction. All of it commits, or nothing does.

1. Open DBeaver (or psql) on that environment, as a user that may change the schema.
2. Paste the script and run it as a script (**Execute SQL Script**, Alt+X). In psql, use `-f`.
3. It stops at the first error and nothing is applied. When it commits, DMCR sees the change as applied.

The dialog has **Copy script**, **Download .sql** and **I ran it: refresh <env>**.

**Mark applied** is for SQL you already ran another way. **Verify and mark applied** records the change in the registry, then runs its `verify.sql`. If verify does not pass, the record is undone and nothing changes. If you ran DMCR's script, there is nothing to do: the script records the change itself.

## Deploying and rolling back

### Deploy preview

**Deploy** on a release card runs a dry run first. Nothing is applied. The dialog **Deploy release <id> to <env>** shows:

- `N changes will be deployed to <env>` and the plan table (#, Change, Project, Release, Kind), in deploy order.
- Lock risks of the changes in the plan.
- What the deploy skips: `N not for <env>` and `N not going`, each with its reason.
- `Nothing to deploy` when every change is already applied.
- `<env> would refuse this deploy` with the reasons, when a check fails. Fix them and preview again.

**Deploy in Runner** runs the deploy in the Runner tab. It is disabled while the preview shows a refusal.

### What refuses a deploy

Before the runner starts, DMCR refuses a deploy (the dialog **Deploy to <env> refused**) when:

- a pending change has no project or no requested by (set them with the pencil in the Changes table, then commit), or
- a conflict between changes the deploy would apply is not resolved. See [Conflicts and merge changes](#conflicts-and-merge-changes).

The runner then checks the whole plan before anything runs:

- a change requires one that is not applied and not in this deploy, is dropped, or never goes to this environment;
- the environment's release rules (below);
- `danger_` changes are never in the plan.

### Release rules

Settings > DMCR Config > **Release rules** sets, per environment:

| Column | Choices | Effect |
|---|---|---|
| Promote from | `anything`, or `only what ran on <env>` | Deploy here only changes already applied on that environment, with identical deploy, verify and revert files. Production always has this rule when another environment has a database: it offers no `anything`, and starts on the environment before it. Other environments start on `anything`. |
| Older changes | `allowed`, `blocked` | Blocked: refuse a pending change that sorts before one already applied here. |
| Sign-off | `not needed`, `required` | Each change needs a DBA sign-off for this environment. |
| Who signs off | DBA names, comma separated | Empty = any DBA. Only when sign-off is required. |

**Edited after deploy** sets what happens when files of an applied change are edited later: `warn and continue (default)`, `block the deploy`, or `accept the edit (logged)`.

**Conflicts between changes** sets what a deploy does when two changes it applies change the same thing and no merge change resolves it: `block the deploy (default)`, `warn and continue`, or `do not check`. DMCR and the runners follow it (`conflict_check` in `dmcr.cfg`).

### Sign-off

When an environment needs a sign-off, the release card shows **Approve N** (N changes still need it) or **Approved**. The dialog **Approve release <id> for <env>** lists each pending change with its state and takes an optional note.

- You sign as the DBA name in Settings.
- Each change is approved with its current files. An edit afterwards needs a new sign-off (`re-approve`).
- Whoever created or requested a change cannot approve it. Those are skipped, with the reason.
- If you are not in **Who signs off**, the dialog says so and the buttons are disabled.
- **Revoke** removes approvals already given.

### Rolling back

**Roll back** (toolbar, release card or project row) opens **Roll back on <env>**:

1. **What to roll back**: **Projects** (in whichever release they went out) or **Whole releases**.
2. Pick one or more. Each pill shows how many of its changes are applied on the environment.
3. **Only some kinds of change** (optional; nothing picked means everything): Data (**Inserts**, **Updates**, **Deletes**) and Structure (**DDL**, **Functions**, **Types**).

The dialog shows the runner command it will run. **Preview** is required first: it lists the changes that will be reverted, newest first. **Roll back in Runner** then runs it in the Runner tab.

To undo one deploy run, use the Runner tab: every deploy and revert has a deployment id. `dmcr deployments` lists them, and the Runner shows each deploy's id with `dmcr revert <id>` to undo it.

```text
dmcr deployments
dmcr revert 3f2a9c1
```

### What blocks a rollback

The preview shows **Blocked** and the button turns into **Blocked** when:

- a picked change is a `danger_` change: the DBA reverts it by hand. Its row has **Revert script for DBeaver**: one script with its `revert.sql`, removing its registry record and its `verify.sql`, in one transaction. Run it in DBeaver or psql, then **Preview** again: the change is no longer applied, so the rest of the pick can be rolled back;
- a change applied later, outside your pick, requires a picked change;
- a change applied later, outside your pick, uses an object whose structure a picked change changed.

A later change outside the pick that only writes the same objects gives a warning, not a block.

## Two DBAs on one repository

Change folders live in one git repository. DMCR pulls, commits and pushes for you.

### Every commit pulls before it pushes

When DMCR commits and pushes (for example `releases.json`, a merge change, **Commit releases.json**), it pulls first, then pushes. If the push is rejected because someone pushed in between, it pulls again and retries once. With no remote, the commit stays on your machine and the notice says so.

A pull rebases your local commits on what the remote has. If the rebase stops on a file, DMCR backs out and merges instead, so there is one set of conflicts to resolve. Resolve them in the Commits tab.

### Pull

- **Pull** in the Commits tab brings in what the other DBAs pushed. The button shows how many commits are waiting, for example `Pull (3)`.
- On the Releases tab, a notice with **Pull** appears when changes are applied on the environment but are not in your folder: another DBA deployed them.

### Renumbering

Two DBAs can both save change `031`. After a pull or merge, DMCR keeps the number for the change that is already shared and moves yours to the next free number. Its id is replaced everywhere in the change folders: `meta.json` `change_id`, `requires`, and the SQL. A committed folder's move is committed. The notice says, for example:

```text
031 came from anika.rao, yours is now 032
```

### Branches

The branch button in the Commits tab header opens the branch menu:

- your local branches (click to switch);
- **Pushed by other DBAs**: branches on the remote you have not checked out (click to check out);
- **New branch…**: starts a branch from the current one. It stays local until the first push.

Switching is refused while change folders on this branch have edits that are not committed.

When you are not on the main branch, the header shows:

| Button | Action |
|---|---|
| **Bring <main> in** | Merge what the main branch has now into your branch, then push your branch. |
| **Merge into <main>** | Push your branch, switch to main, pull, merge your branch, push main. You end up on main. Disabled until your changes are committed. |

The main branch is the **Branch** set in Settings > DMCR Config > Git; if empty, the remote's default branch, else `main` or `master`.

### When a pull or merge stops

If you and another DBA changed the same lines of a file, the Commits tab shows **Merge waiting** with each file (`both changed` or `resolved`). For each file:

- **Keep mine (<who>)**
- **Take theirs (<who>)**
- **Edit by hand**: edit the file with both sides between the conflict markers, remove the marker lines, then **Use this text**.

**Finish merge and push** commits the merge, renumbers clashing changes and pushes. **Cancel merge** puts everything back as it was before the merge.

## Conflicts and merge changes

The **Conflicts** card on the Releases tab compares changes between projects, the way git compares two branches. Whichever change deploys last would silently win, so each conflict needs a decision.

### What is a conflict

Two changes from different projects conflict when they touch the same part of the database:

| Kind | Example |
|---|---|
| Same function, view or trigger | Both redefine `price_label(numeric)`. The definitions are merged three-way against the version before both. |
| One drops what the other changes | `deleted by <project>`. |
| Same column, same rows | Both `UPDATE` the same column on overlapping rows with different values. |
| Same row keys | Both insert rows with the same keys, or one deletes rows the other writes. |
| Same column | Both add, drop or alter the same column; or one drops, renames or retypes a column the other writes data into. Adding the same column twice is still a conflict. |
| Same table | Both create or both drop it. |
| Same type | Both change the same type, or both add the same enum value. |

Not a conflict:

- One change requires the other, directly or through others.
- Both are in the same project. Exception: two DBAs each wrote one (`created_by`) and neither requires the other.
- Dropped changes.
- A change that clearly comes first: DMCR compares two changes only when both are in releases, and they are in the same release or the later-numbered change goes out in an earlier release.

**Auto-merged** pairs touch the same table but different columns, different rows, different insert keys or different enum values. They merge by themselves. **N auto-merged** in the card header lists them.

### The card

The header counts `N conflicts`, `N clean merges to write` and `N resolved`. **Check again** reads the changes again.

Each row shows the object, the label (`both modified`, `both added`, `deleted by …`), the two changes (the first deploys first), and a summary.

| Row button | When |
|---|---|
| **Resolve** | A conflict. |
| **Merge** | A clean merge: the lines do not overlap, but deploying both would still keep only one. |
| **Commit** | A merge change that is saved but not committed. |
| **Reopen** | A conflict resolved with Keep the deploy order. |

### The merge editor

**Resolve** or **Merge** opens the merge editor. Side 1 deploys first; side 2 deploys later and wins today.

- **Function or view definitions**: each conflicting hunk shows both sides with **Accept <side 1>**, **Accept <side 2>** and **Accept both**. Lines only one side changed are taken. The **Result** pane can be edited by hand; **Rebuild from the picks** discards hand edits.
- **Data**: each conflicting row shows the value each side sets, with buttons for each side, or **All <side>** for every row. When the rows cannot be listed from the SQL, you pick whose value wins where both write.
- **Preview merge change** shows the deploy, verify and revert SQL. It needs every conflict decided.
- **Merge change goes to** picks the project of the merge change.
- **Create merge change** writes a new change after both sides.

Other kinds (columns, tables, types, row keys) cannot be fixed by a merge change. The editor says so: edit one side (it must not be applied anywhere yet), or keep the deploy order.

### The merge change

- It requires both sides, so it always deploys after them.
- It keeps what it replaced in a backup table, so its `revert.sql` restores exactly that.
- Before it is saved, it gets a round-trip test (deploy, verify, revert, rolled back). If that fails, nothing is saved.
- The later side's `revert.sql` (and `verify.sql` when both added the object) is pointed at the earlier side's definition, so reverting it never drops the other DBA's work.
- It is committed and pushed right away. If the commit fails, the editor offers **Commit**.

### Keep the deploy order

**Keep the deploy order instead** resolves the conflict with no merge change: the later side's version stays. Write why, then **Keep: <side 2> wins**. The decision is recorded in `conflicts.json` in the changes folder and committed (and pushed) at once, so the other DBA's deploy gate agrees. **Reopen** removes it the same way.

### The deploy gate

A conflict that is neither merged nor kept, where the deploy would apply one side, blocks the deploy. Clean merges that still need a merge change count too.

DMCR (the deploy preview and the Runner tab) and the runners (`dmcr.ps1` and `dmcr.sh`, for example in CI or from a terminal) follow the same setting: **Settings › DMCR Config › Release rules › Conflicts between changes**, stored as `conflict_check` under `[dmcr]` in `dmcr.cfg`. With **block** DMCR refuses the deploy with the list of conflicts; with **warn** it lists them and deploys.

```ini
[dmcr]
conflict_check = block
```

| Value | Effect |
|---|---|
| `block` (default) | Refuse the deploy. Nothing is applied. |
| `warn` | Print a warning and deploy anyway. |
| `off` | No check. |

Any other value refuses the deploy. The runner check needs Node.js (on PATH, or `DMCR_NODE`) and `dmcr_conflicts.cjs` next to the runner. If the check cannot run, `block` refuses the deploy and `warn` deploys with a warning.

## Commits tab

The Commits tab is git for the change folders, without typing git.

### Header

- The current branch (opens the branch menu, see [Branches](#branches)).
- `↑N ↓N` and the remote branch: commits to push and to pull. `local only` when the branch has no remote branch.
- Total commits, and how many changes are not committed.
- **Bring <main> in** and **Merge into <main>** when you are not on the main branch.
- **Pull** and **Push** when there is a remote. **Push** pulls first, then pushes.
- **Refresh** also asks the remote, so the `↓` count is current.

### Not committed

Saved changes not in git yet, grouped by change folder, each with A/M/D counts.

- Tick the changes to commit (**All** / **None**). The commit message is filled in for you and can be edited.
- **Commit N changes** (or Ctrl+Enter) commits only the ticked change folders. It does not push: use **Push**.
- **Review all picked** shows their diffs.
- Files outside the change folders are counted but left alone.

### Action history in git

Everything DMCR records in an environment's `dmcr.event_log` is also committed and pushed to the repository: deploys and rollbacks (failed ones too), sign-offs, repairs, baselines, tags and manual scripts. The lock bookkeeping is left out.

- One small JSON file per action, in `.dmcr-history/<env>/` in the changes folder: the environment, action, status, time (UTC), who did it, the deployment id and each change. A database error message is kept, cut to 500 characters, with passwords masked.
- The commit says what happened: `chore(dmcr): revert on prod: 002_b_x, 001_a_y (d1973349): the price label is wrong`.
- **Why (optional)** in **Roll back** and **Revert the last change** is saved in the file and the commit message.
- The copy comes from the database, so actions DMCR did not run itself come along too: a manual script run in DBeaver, a deploy from CI or a terminal. They are picked up the next time DMCR reads that environment's status, at most once a minute.
- The first time, an environment's earlier actions are recorded in one commit.
- It is a record only. DMCR still reads `dmcr.change_log` to know what is applied, and a rollback that was recorded does not stop its changes from being deployed again: mark them **Not going** for that.
- It commits on the current branch. If the commit or push fails, the action still stands, Releases says so, and the next sync tries again.
- Not a git repository: nothing is written.

### History

- Commits newest first, with day labels, author, time, `+adds −dels` and the changes each commit touched.
- Search by message, sha, author or change. **Changes only** hides commits that touch no change folder.
- 300 commits load at a time; **Load N more** loads the next.

### Diffs

Click a commit or a not-committed change to see its files. Pick a file to see the diff, **Side by side** or **Inline**. **Open the change files** opens the changes in the change viewer.

**Undo commit** shows on the newest commit only while it is not pushed and is not a merge commit. Its files go back to Not committed.

## Importing changes

**Import from <env>** turns SQL files someone already ran by hand on a test environment into DMCR changes for production. The button shows only while the Releases tab shows the production environment and there are two or more environments. It is disabled until at least one project exists: the imported changes go into a project.

1. **Files**: where the SQL files are (a GitHub commit, pull request or folder link, or a local folder), **Already ran on** and **Goes to**. **Load files**. A GitHub link is read with your own git sign-in.
2. **Order**: DMCR suggests an order from the SQL: a file that uses a column, table or row another file creates goes after it; where several files replace the same function, the version the test environment has now runs last. Move files up or down. A file placed before one it needs blocks the next step.
3. **Changes**: **Make N changes** writes deploy, verify and revert for each file, with production as the "before" state. A function or view keeps the file's exact text. Remake one with its refresh icon. **never send to <prod>** keeps a file on the test environment only.
4. **Trial on prod**: **Run on <prod>, rolled back** runs every change going there, in order, each deployed, verified, reverted and verified, inside one transaction that is rolled back. Nothing stays. A busy table fails the trial after 3 seconds instead of waiting.
5. **Save**: pick **Project**, **Requested by** and **Ticket**, then **Save, commit and mark applied on <test env>**. DMCR saves the changes, commits them in one commit (and pushes when the repository has a remote), records them as applied on the test environment (no SQL runs there) and runs their verify there.

Then deploy them to production from the Releases tab: the project, in its release, **Deploy**.

## Zero-downtime changes

**Zero-downtime change** builds expand and contract changes from a template. The contract change requires the expand change and ships after the application has switched over.

| Template | Changes |
|---|---|
| **Rename / change type** | Expand: new column, backfill, both kept in sync with a trigger. Contract: drop the trigger and the old column. The contract is `danger_`: the DBA runs it. |
| **NOT NULL** | Step 1: `CHECK (... IS NOT NULL) NOT VALID`. Step 2: `VALIDATE`, then `SET NOT NULL`. |
| **Foreign key** | Step 1: `FOREIGN KEY ... NOT VALID`. Step 2: `VALIDATE CONSTRAINT`. |
| **Index** | One change: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, outside a transaction. |

Fill in the table, the columns the template asks for, **Project** and **Requested by**. The dialog shows each change's deploy, verify and revert, lock-risk chips, and what has to happen before the next change (for example, fill NULL rows before step 2). **Create N changes** saves them.

The table name has no schema: each environment's schema is the search_path.

## Set up CI

**Set up CI** writes a GitHub Actions check into the repository that holds the changes folder, then commits it (and pushes when the repository has a remote).

On every pull request that touches the changes folder, the check:

- lints `deploy.sql` for lock risks, checks `meta.json` and `requires`, and flags edits to changes already on the base branch;
- starts a PostgreSQL 16 service and builds the whole history from an empty database (`danger_` changes through their manual script, as the DBA runs them);
- round-trips each changed change: deploy, verify, revert, deploy again;
- posts one comment on the pull request, updated on every push. The job fails when a change does not apply or its revert leaves something behind.

The dialog lists the files and whether each is `new` or will be replaced:

| File | Purpose |
|---|---|
| `.github/workflows/dmcr.yml` | The workflow. |
| `.github/dmcr/dmcr-ci.cjs` | The check. |
| `.github/dmcr/dmcr.sh` and its helper files | The runner it drives, including `dmcr_conflicts.cjs` and the danger rules. |

**Write the files** (or **Update the files**) writes and commits them; the dialog says whether they were pushed. The check runs on the next pull request once the workflow is on the remote. Run Set up CI again to update the files.

# Runner and the command line

DMCR applies changes with a runner script that ships with it:

- `scripts/runner/dmcr.ps1` for Windows PowerShell 5.1 and later.
- `scripts/runner/dmcr.sh` for bash (Linux, macOS, Git Bash).

Both scripts take the same commands, the same options and the same `dmcr.cfg`. They write the same registry. Where they differ, this page says so.

The Runner tab in DMCR is a front end for the same script. Every button and typed command starts the script with `--json` (except `parse`) and shows the result.

## Runner tab

### What runs when you press a button

DMCR picks the script in this order:

1. The **script path override** at the bottom of the Runner tab (blank means the bundled script).
2. The `dmcr.scriptPath` setting.
3. The bundled `dmcr.ps1` on Windows, `dmcr.sh` elsewhere.

On Windows DMCR starts the script with `pwsh` (or the `dmcr.pwshPath` setting) and `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. On macOS and Linux it uses `/opt/homebrew/bin/bash` when present, else `/bin/bash`.

It passes `-c <dmcr.cfg>` and builds the connection for the environment of the run: the `conn` URL from `dmcr.cfg` plus the password from the OS keychain (`dmcr.<env>Password`). When you type `--env <name>`, that environment's connection is built instead of the one in `[dmcr] env`. See [Environment variables](#environment-variables) for everything DMCR sets.

### Quick buttons

The toolbar runs one command per click. All buttons are disabled while a command runs.

| Button | Runs |
|---|---|
| status | `status` |
| deploy | `deploy` |
| deploy --dry-run | `deploy --dry-run` |
| test | `test` (opens the test picker first) |
| verify | `verify` |
| history | `history` |
| log | `log` |
| diff | `diff` |
| check | `check` |
| repeatable | `repeatable` |
| release list | `release list` |
| tag list | `tag list` |
| revertLast | `revertLast` (asks first) |
| revert list | `revert list` |
| init | `init` |
| show config | `show config` |

On the right of the toolbar:

- **Branch chip**: the git branch of the workspace. A `*` after the name means change folders have uncommitted edits. With more than one local branch, click it to switch branch.
- **Copy output**: copies everything in the terminal area.
- **Clear terminal**: asks "Clear terminal?" and then clears the output.

### Typing commands

Type a command at the prompt and press Enter. These forms all work:

```text
status --env test
dmcr status --env test
/status
```

- Words in double or single quotes stay together: `tag create v1.0 "Sprint 42 release"`.
- Up and Down walk through the last 200 commands you typed.
- Esc or Ctrl+C clears the line.
- `<command> --help` (or `-h`) prints the help for that command in the terminal.
- `revert` with nothing after it prints `Usage: revert <change_id>`.
- A word that is not a runner command gives a **Failed** card: "Unknown: `<word>` Not a valid DMCR command. Type /help to see all available commands."

The prompt accepts these runner commands: `status`, `deploy`, `verify`, `revertLast`, `revert`, `init`, `parse`, `show`, `history`, `info`, `plan`, `check`, `baseline`, `repair`, `tag`, `repeatable`, `test`, `release`, `deployments`, `log`, `diff`.

`approve`, `approvals` and `manual-script` are not accepted at the prompt. DMCR runs them from the Releases page; on the command line they work as described in [Commands](#commands).

The prompt also has commands of its own:

| Command | What it does |
|---|---|
| `help` | Shows the command list as a card. |
| `clear` | Clears the terminal area. |
| `config` | Runs `show config`. |
| `ls [pattern]` | Prints a tree of the changes folder. |
| `it` | Interactive revert: pick an applied change with the arrow keys, then pick `revert <id>` or `revert to <id>`. Esc leaves. |
| `sync` | Git pull, stage the changes, commit with an AI message, push. |
| `dmcr` | Prints the DMCR logo. |

### Slash commands

Type `/` to open the command list. Keep typing to filter it (names, descriptions and aliases all match). Up and Down move the selection; Enter or Tab picks it.

- A command that needs no argument runs at once (for example `/status`, `/deploy --dry-run`, `/revertLast`).
- A command that needs an argument is put on the prompt for you to finish (for example `/revert to <id|@tag>`, `/tag create <name>`, `/release show <id>`, `/deploy --release <id>`, `/revert --project <id> [--kind update]`).

### Run cards

Each run is a card. The header shows `dmcr <command>`, the time it took and a badge:

| Badge | Meaning |
|---|---|
| Running | The script is still running. |
| Done | The script exited with code 0. |
| Failed | The script exited with an error, or the command was unknown. |

On the header:

- Click the header to fold or unfold the card. When a new run starts, finished **Done** cards fold, except the last one. **Failed** cards stay open.
- **>_** (terminal icon) switches between the result view and the full log the script printed while it ran.
- **Copy** copies the command as `dmcr <command>`, ready to paste.

Below the terminal, **recent runs** lists earlier runs. Each row has a copy button for its command (`dmcr <command>`). A trash button deletes the run history.

### Result views

When the script returns JSON, the card shows a view made for the command:

| Command | View |
|---|---|
| `status` | Counts (total, applied, pending, not going) and one row per change with its state. Filter chips: Pending, Applied, Not going, All. Click a row to open its files. |
| `deploy` | What was applied, what was skipped as dropped or manual, and the repeatables. A dry run lists the changes, dropped changes, repeatables to re-apply and the reasons the deploy would be blocked. |
| `verify` | Per change: ok, failed, superseded or no backup; for the last deployment, all changes, or one change. |
| `test` | The round-trip result per change. |
| `history` | The applied changes, newest first. |
| `log`, `deployments`, `show <deploy-id>` | Deployments, or one deployment change by change. |
| `diff` | The differences found, by mode. |
| `show <change_id>` | The change: who, what, its state here and its `deploy.sql`. |
| `show config` | The active configuration (connection redacted). |
| `info` | Environment, counts, registry health, checksum policy. |
| `check` | The preflight issues, or a pass. |
| `plan` | The dependency-aware order with each change's `requires`. |
| `release` | Releases with counts, or one release change by change. |
| `tag` | Tags, or the tag created or deleted. |
| `revert`, `revertLast`, `revert list` | What was reverted, or the applied changes. |
| `revert --project / --release / <deploy-id>` | The scope, its changes, warnings and problems. |
| `repeatable`, `baseline`, `repair`, `init` | The result of that command. |

Anything else is shown as plain output.

### revertLast asks first

`revertLast` from a button, the prompt or `/revertLast` never runs straight away. The Runner opens **Revert the last change** (with "on `<env>`" when you typed `--env`):

1. It runs `revertLast --dry-run --json` to find the change it would revert.
2. It shows the change id, "its revert.sql runs, then verify.sql", and the change's `revert.sql`, with **Copy** and **Open revert.sql**.
3. **Revert it** runs `revertLast`. **Cancel** closes the dialog and nothing is reverted.

Other outcomes:

- No change applied: "Nothing to revert: no change is applied."
- The last change is a `danger_` change: the dialog says DMCR never reverts it and the DBA runs its `revert.sql` by hand. There is no **Revert it** button.

`revertLast --dry-run`, `revertLast --json` and `revertLast --help` run without the dialog.

### Test picker

`test` without `--to`, `--release`, `--project` or `--kind` opens **Round-trip test** before anything runs. It lists the pending changes, newest first, from `status --json`.

- Each row shows `tested ×N` (passed N round trips with its current files) or `not tested`.
- Changes that never passed start ticked; the others start unticked.
- An unticked change older than the newest ticked one is still applied inside the test first, without checks, and rolled back with the rest. Its row says "applied for the test, not checked".
- The test stops at a `danger_` change. That row and every newer one cannot be ticked.
- The dialog shows the exact command it runs, for example `test --to 012_add_index --only 010_x,012_add_index`.
- **Round-trip N changes** runs it. Nothing is deployed.

## Commands

### Usage

```powershell
.\dmcr.ps1 <command> [args] [options]
```

```bash
./dmcr.sh <command> [args] [options]
```

With no command, or with `help`, `-h`, `--help` or `/?`, the runner prints its help and stops. An unknown command also prints the help.

Every command except `help`, `show config`, `init` and `parse` needs the registry. Without it the runner stops with:

```text
ERROR  DMCR registry not found.
       Please run: dmcr init
```

Errors go to stderr as `✗  <message>` and the exit code is 1.

### Options

Options can go anywhere on the line.

| Option | Used by | What it does |
|---|---|---|
| `--env <name>` | all | Run against `[<name>]` instead of `[dmcr] env`. The section must exist. |
| `-c`, `--config <path>` | all | The `dmcr.cfg` to read. Default: `DMCR_CONFIG`, else `dmcr.cfg` next to the script. |
| `--json` | most | JSON on stdout instead of tables and log lines. |
| `--debug` | all | Verbose debug logging (same as `DMCR_DEBUG=1`). |
| `--dry-run` | `deploy`, `revertLast`, `revert <id>`, `revert to`, scoped revert | Show what would happen; change nothing. |
| `--to <id\|@tag>` | `deploy`, `test` | Stop at this change, or at the change a tag points to. |
| `--only <id,id,...>` | `test` | Round-trip only these changes (see `test`). |
| `--allow-prod` | `test` | Allow `test` on a production environment. |
| `--release <spec>` | `deploy`, `revert`, `status`, `repeatable`, `approve`, `approvals` | Only changes whose project is in these releases. |
| `--project <id[,id]>` | same | Only changes of these projects. |
| `--kind <kind[,kind]>` | same | Only changes of these kinds. |
| `--by <name>` | `approve` | Who approves (default: the actor). |
| `--note <text>` | `approve` | A note stored with the approval. |
| `--revoke` | `approve` | Remove the approval instead. |

Kinds are `insert`, `update`, `delete`, `dml`, `ddl`, `function`, `type`, `other`. `dml` also matches `insert`, `update` and `delete`; `ddl` also matches `function` and `type`. A change without `"kind"` in `meta.json` gets a kind from the statements in its `deploy.sql`.

A `--release` value can name several releases, like `git revert`:

| Form | Releases |
|---|---|
| `a` | Release `a`. |
| `a,b` | Releases `a` and `b`. |
| `a..b` | After `a`, up to and including `b`. |
| `a^..b` | `a` up to and including `b`. |
| `a..` | Everything after `a`. |
| `..b` | Everything up to and including `b`. |

Ranges follow release order: the release `date` in `releases.json`, else the id. `--release` and `--project` need `releases.json` in the changes folder; an unknown project stops the run.

A change id typed on the command line must be a change folder name (letters, digits, `_`, `.` and `-`, like `001_add_orders` or `R__user_view`). Anything else stops with `Not a change id: '<value>'`.

### Setup

| Command | What it does |
|---|---|
| `init` | Creates the registry from `dmcr_change_log_ddl.sql` in one transaction. When the environment has a `schema` (other than `public`), it also creates that schema. Safe to run again. |
| `show config` | Prints the active configuration: config path, env, changes_dir, psql_path, lock_timeout, statement_timeout, checksum_policy, placeholders, conn (password redacted). |

### Deploy

| Command | What it does |
|---|---|
| `deploy` | Applies every pending change in folder-number order, then re-applies repeatable (`R__`) changes whose `deploy.sql` changed. |
| `deploy --to <id\|@tag>` | Stops after that change. The target must be a change folder. |
| `deploy --release <spec>` / `--project <id>` / `--kind <kind>` | Applies only the pending changes in that scope. Changes outside it are skipped. |
| `deploy --dry-run` | Prints each pending `deploy.sql`, the repeatables it would re-apply, and every reason the deploy would be refused. Runs the conflict check. Changes nothing. |
| `repeatable` | Applies every `R__` change whose `deploy.sql` checksum changed. Honours `--release`, `--project`, `--kind`. |
| `manual-script <id> [--env <env>]` | Prints one script for a `danger_` change that the DBA runs by hand (see [Safety checks](#safety-checks)). |

What `deploy` skips, and how the log says it:

| Change | Log |
|---|---|
| Already applied | `SKIP <id> already applied` |
| Dropped (change or project `"status": "dropped"`) | `SKIP <id> — change not going: <reason>` |
| Not for this environment (`"environments"` in `meta.json`) | `SKIP <id> — only for <envs>, not <env>` |
| Outside `--release` / `--project` / `--kind` | `SKIP <id> — outside the scope (...)` |
| `danger_` change | `SKIP <id> — manual-only (danger_): the DBA runs it by hand; script: dmcr manual-script <id> --env <env>` |

After a deploy that applied something, the runner prints the deployment id: `Deployment <short id> on <env>: N change(s) applied (dmcr deployments <id>; undo with dmcr revert <id>)`.

How one change is applied (in one psql call):

1. `BEGIN`, `SET LOCAL lock_timeout`, `SET LOCAL statement_timeout`.
2. `deploy.sql`.
3. The row in `dmcr.change_log` and the success row in `dmcr.event_log`.
4. `verify.sql` inside a savepoint that is rolled back.
5. `COMMIT`. If anything failed, nothing is applied and nothing is recorded; a failure row goes to `dmcr.event_log`.

The deploy stops at the first failed change. Changes applied before it stay applied.

### Test (round trip)

| Command | What it does |
|---|---|
| `test` | Round-trips every pending change in one transaction that always ends in `ROLLBACK`. |
| `test --to <id\|@tag>` | Only the pending changes up to that one. |
| `test --only <id,id,...>` | Round-trips only these. Other pending changes up to `--to` are applied inside the test without checks and rolled back too. Each `--only` id must be a pending change up to `--to`. |
| `test --allow-prod` | Needed on a production environment. |

For each change: deploy, verify, revert, verify again; schema and data must match the state before the deploy; then deploy again so the next change builds on it. Nothing is kept.

The test skips applied, dropped and not-for-this-environment changes. It stops at a `danger_` change, a change blocked by the deploy guards, a change without `revert.sql`, and a `"transaction": false` change it cannot test inside a transaction (`CREATE/DROP INDEX CONCURRENTLY` and `REINDEX CONCURRENTLY` are tested without `CONCURRENTLY`).

On a production environment without `--allow-prod`:

```text
Refusing to run 'test' against environment '<env>': it holds locks on the tables it changes until it rolls back. Run it against staging or a copy of production, or add --allow-prod.
```

### Verify

| Command | What it does |
|---|---|
| `verify` | Runs `verify.sql` for every change of the last deployment. |
| `verify all` | Runs `verify.sql` for every applied change. |
| `verify <id>` | Runs `verify.sql` for one applied change (also an `R__` change). |

See [Verify, revert and tags](#verify-revert-and-tags).

### Revert

| Command | What it does |
|---|---|
| `revertLast` | Reverts the most recently applied change. |
| `revert <id>` | Reverts that change. It must be the latest applied. |
| `revert to <id>` | Reverts changes newest first, down to and including `<id>`. |
| `revert to @<tag>` | Reverts changes applied after the tagged change. The tagged change stays. |
| `revert list` | Lists applied changes, newest first. |
| `revert --project <id> [--kind <kind>]` | Reverts every applied change of the project, newest first, wherever it sits. |
| `revert --release <spec> [--kind <kind>]` | Reverts every applied change of the releases, newest first. |
| `revert <deploy-id> [<deploy-id> ...]` | Reverts what those deployments applied that is still applied, newest first. Ids can also be comma-separated. |

Add `--dry-run` to see the plan. `bash` also accepts `revert-last` for `revertLast`; PowerShell does not.

### Inspect

| Command | What it does |
|---|---|
| `status` | Every change folder with its state: `APPLIED`, `PENDING`, `NOT GOING`, `NOT FOR <ENV>`. Honours `--release`, `--project`, `--kind`. |
| `history` | Applied changes, newest first: applied_at, applied_by, deploy checksum, ticket, git commit, environment, actor, project, release, kind, requested_by, created_by, deployment id. |
| `info` | Environment, total / applied / pending / danger counts, registry status, checksum policy. |
| `plan` | Dependency-aware order from `meta.json` `requires`, with each change's state. A cycle stops it. |
| `check` | Preflight without deploying (see below). Also reports edited applied files and `danger_` changes waiting on this environment. |
| `log [--oneline] [<deploy-id>]` | Deploy and revert runs, newest first (up to 200), like `git log`. With an id: that run change by change, like `git show`. |
| `deployments [<deploy-id>]` | Same as `log --oneline`; with an id, same as `log <id>`. |
| `events [<since>]` | Every recorded action as JSON, without the lock bookkeeping, since a UTC time like `2026-11-02T05:26:59Z`. What DMCR copies into `.dmcr-history` in git. |
| `show <change_id>` | The change: who, what, its state here, its `deploy.sql`. |
| `show <deploy-id>` | Same as `log <deploy-id>`. |
| `diff` | This environment against the change files: not applied yet, edited since applied, applied but missing here. |
| `diff <env> [<env>]` | Two environments' registries: changes only on one side, and changes applied with different files. With one name, the active environment against it. |
| `diff <change_id>` | That change's files since the commit it was applied from. |
| `release [list]` | Releases in `releases.json` with applied / pending / dropped counts on this environment. |
| `release show <id>` | Every change of a release: project, kind, requested by, created by, status. |
| `parse [sql]` | Runs the SQL (from the arguments, else stdin) in `BEGIN ... ROLLBACK` and prints JSON `{ ok, msg, line }`. Needs no registry. Refuses psql backslash commands and transaction control, empty SQL, and SQL over 200,000 characters. |

A deployment id is 40 hex characters, shown as 7. Any unique prefix of 4 or more characters works.

What `check` (and the deploy preflight) reports:

| Code | Meaning |
|---|---|
| `MISSING` | A non-`danger_` change has no `deploy.sql`, `verify.sql` or `revert.sql`. |
| `BLOCKED: unsafe change folder name` | A folder starts like a change but has other characters. |
| `DUPLICATE PREFIX` | Two folders have the same number (`001_a` and `0001_b` are both 1). |
| `MALFORMED` | A folder name is not `001_descriptive_name`. |
| `GAP` | Folder numbers skip (for example `003` then `005`). |
| `RELEASES`, `PROJECT`, `KIND` | Problems in `releases.json`, an unknown project, release or project type, or an unknown kind. |
| `DEPENDENCY` | `requires` names a folder that does not exist. |
| `CHECKSUM` | An applied file was edited (`check` only). |
| `MANUAL` | A `danger_` change is waiting on this environment (`check` only). |

A deploy refuses to start while any preflight issue is present, including `GAP`.

### Tags

| Command | What it does |
|---|---|
| `tag` / `tag list` | Lists tags: name, change, created_at, whether that change is still applied, description. |
| `tag create <name> [description]` | Tags the most recently applied change. Name: letters, digits, `.`, `-`, `_`. Refused when nothing is applied or the name exists. |
| `tag delete <name>` | Removes a tag. |

### Approvals

| Command | What it does |
|---|---|
| `approve <id> [--env <env>] [--by <name>] [--note <text>]` | Signs off a pending change for the environment. |
| `approve --release <spec> \| --project <id> [--kind <kind>]` | Signs off every pending change in the scope. |
| `approve ... --revoke` | Removes the approvals. |
| `approvals [--env <env>] [--release ... \| --project ...]` | Pending changes with `approved`, `stale` (files changed since) or `not approved`. |

`--by` must be in the environment's `approvers` when that list is set. With `self_approval = block` (the default), the DBA who created or requested a change cannot approve it. Applied and dropped changes are skipped.

### Repair

| Command | What it does |
|---|---|
| `baseline <id>` | Records every change up to and including `<id>` as applied without running it. Skips applied, dropped and `danger_` changes. |
| `repair --mark-applied <id>` | Records one change as applied without running it. Refused for a dropped or not-for-this-environment change. |
| `repair --mark-reverted <id>` | Removes one change from `dmcr.change_log` without running `revert.sql`. |
| `repair --checksums` | Stores the current checksums of `deploy.sql`, `verify.sql` and `revert.sql` for every applied change. |
| `repair --unlock` | Clears the deploy lock left by a crashed run. |

Each repair writes a row to `dmcr.event_log`.

## dmcr.cfg

### Format

`dmcr.cfg` is an INI file: `[section]` lines, then `key = value` lines.

- Lines starting with `#` or `;` are comments.
- Put comments on their own line. The runners keep everything after `=` as the value, so `env = dev # note` sets the env to `dev # note`.
- DMCR's DMCR Config page writes this file. Keys and sections it does not manage are kept as they are.

The runner reads `dmcr.cfg` from `-c`/`--config`, else `DMCR_CONFIG`, else the file next to the script. DMCR looks for it in its own settings folder, then the workspace root (`dmcr.cfg`, `dmcr/dmcr.cfg`, `v2/dmcr.cfg`), then next to the script.

### Example

```ini
[dmcr]
env = dev
changes_dir = db/changes
psql_path =
lock_timeout = 30s
statement_timeout = 5min
checksum_policy = warn

[envs]
names = dev, test, prod
production = prod

[dev]
conn = postgresql://app@localhost:5432/app_dev

[test]
conn = postgresql://app@test-db:5432/app
schema = app_st
out_of_order = block

[prod]
conn = postgresql://app@prod-db:5432/app?sslmode=verify-full
schema = app
promote_from = test
out_of_order = block
approval = required
approvers = dba.one, dba.two

[compare]
conn =
```

### [dmcr]

| Key | Values | Default when the key is missing | What it does |
|---|---|---|---|
| `env` | an environment name | first name in `[envs] names`, else `dev` | The active environment. Its `[<env>]` section must exist. |
| `changes_dir` | path | none (required) | The changes folder. A relative path is resolved from `DMCR_BASE_DIR` (DMCR sets it to the workspace root), else from the folder of `dmcr.cfg`. |
| `psql_path` | path | `psql` on the PATH | The psql executable. See [Environment variables](#environment-variables) for how it combines with `DMCR_PSQL`. |
| `lock_timeout` | number with `ms`, `s`, `min`, `h` or `d` | `5s` | Each statement gives up when it waits on a lock longer than this. |
| `statement_timeout` | same format | `5min` | Each statement is stopped when it runs longer than this. |
| `checksum_policy` | `warn`, `block`, `repair` | `warn` | What happens when files of an applied change were edited. An invalid value prints a warning and uses `warn`. |
| `conflict_check` | `block`, `warn`, `off` | `block` | The conflict check before a deploy. Any other value stops the deploy. |
| `round_trip_check` | `block`, `off` | `block` | The [round-trip test before a deploy](#round-trip-test-before-a-deploy). Any other value stops the deploy. Only in `dmcr.cfg`. |
| `out_of_order` | `allow`, `block` | `allow` | Default for environments that do not set `out_of_order`. |
| `sslmode` | a libpq sslmode | none | Default `sslmode` for environments that do not set one. |

The DMCR Config page writes `lock_timeout = 30s` when the field is empty. An invalid timeout stops the run: `Invalid lock_timeout '<value>' in dmcr.cfg: use a number with ms, s, min, h or d (like 5s).`

In the DMCR Config page, `checksum_policy` is **Edited after deploy**: "warn and continue (default)", "block the deploy", "accept the edit (logged)". `conflict_check` is **Conflicts between changes**: "block the deploy (default)", "warn and continue", "do not check".

### [envs]

| Key | What it does |
|---|---|
| `names` | The environments, comma-separated. The first one is the active environment when `[dmcr] env` is empty. |
| `production` | The production environment's name, or `none` for no production. Without it, a name that contains `prod`, `prd`, `live` or `trunk`, or is exactly `main` or `master`, counts as production. |

The runners treat a production environment like this:

- `test` refuses to run there without `--allow-prod`.
- When it has no `sslmode` (in `dmcr.cfg`, the connection string or `PGSSLMODE`), every run prints: `Connection to production environment '<env>' does not require TLS: set sslmode = verify-full (or require) for [<env>] in dmcr.cfg.`

### [\<environment\>]

One section per environment. Section names `dmcr`, `envs`, `compare` and `placeholders` are never environments.

| Key | Values | Default | What it does |
|---|---|---|---|
| `conn` | `postgresql://...` or `key=value` connection string | none | The database. `DMCR_CONN` wins over it. DMCR stores the URL here without the password; the password is in the OS keychain as `dmcr.<env>Password`. |
| `schema` | a plain identifier | none | The environment's schema. Every session runs with `search_path = <schema>, public`, so change SQL without a schema name lands in it. `init` creates it. A name with capitals is lowercased with a warning. When it is set but missing in the database, runs stop: `Schema '<schema>' does not exist on <env>. Run dmcr init`. |
| `sslmode` | a libpq sslmode | `[dmcr] sslmode` | Passed to psql as `PGSSLMODE` when the connection string and `PGSSLMODE` set none. |
| `promote_from` | another environment | none | Promotion gate: deploy here only changes applied in that environment with the same `deploy.sql`, `verify.sql` and `revert.sql`. |
| `out_of_order` | `allow`, `block` | `[dmcr] out_of_order`, else `allow` | `block` refuses a pending change whose number is lower than an applied one. |
| `approval` | `required`, `none` | none | `required`: every change needs `dmcr approve` for this environment before it deploys. |
| `approvers` | DBA names, comma-separated | anyone | Who may approve here. |
| `self_approval` | `block`, `allow` | `block` | `block`: the DBA who created or requested a change cannot approve it. The DMCR Config page does not write this key. |

### [placeholders]

```ini
[placeholders]
default_tenant = 1
```

A `${default_tenant}` in a change file is replaced with `1` before it runs. `DMCR_PLACEHOLDER_<NAME>` environment variables override these values (the name is lowercased). A `${name}` with no value stops the run: `Unresolved placeholder(s): <names>. Define them in [placeholders] section or set DMCR_PLACEHOLDER_<name> env vars.`

### [compare]

| Key | What it does |
|---|---|
| `conn` | A second database for Schema Diff in DMCR. The runners do not read it. |

## Environment variables

These are the variables the runners read. DMCR sets most of them when it starts the runner; on the command line you set them yourself.

| Variable | Set by DMCR | What the runner does with it |
|---|---|---|
| `DMCR_CONFIG` | no | Path of `dmcr.cfg` when `-c` is not given. |
| `DMCR_CONN` | yes: `conn` plus the keychain password | Connection string; wins over `[<env>] conn`. Must look like `postgresql://...` or `key=value`, else: `DMCR_CONN is not a connection string (expected postgresql://... or key=value).` |
| `DMCR_CONN_ENV` | yes | The environment `DMCR_CONN` was built for. A run for another environment stops: `DMCR_CONN was built for environment '<a>', not '<b>'.` |
| `DMCR_PROMOTE_FROM_CONN` | yes, when `promote_from` is set | Connection to the `promote_from` environment; wins over its `conn`. |
| `DMCR_PSQL` | yes, from `psql_path` | Path to psql. PowerShell uses `psql_path` first, then `DMCR_PSQL`, then `psql`. Bash uses `DMCR_PSQL` first, then `psql_path`, then `/opt/homebrew/bin/psql`, `/usr/local/bin/psql`, `/usr/bin/psql`, then the PATH. |
| `DMCR_BASE_DIR` | yes: the workspace root | Base for a relative `changes_dir`. |
| `DMCR_ACTOR` | yes: the DBA name from Settings | Who ran it (`actor` in the registry, the lock holder). Default: `user@machine`. |
| `DMCR_DANGER_RULES` | yes, when danger rules were edited in Settings | Danger rules file; wins over `dmcr_danger.json` next to the script. |
| `DMCR_NODE` | yes: VS Code's own Node | Node.js for the conflict check. Default: `node` on the PATH. |
| `DMCR_CONFLICTS_JS` | yes, when the script has no helper next to it | The conflict check helper. Default: `dmcr_conflicts.cjs` next to the script. |
| `DMCR_PLACEHOLDER_<NAME>` | no | Overrides `[placeholders] <name>`. |
| `DMCR_DEBUG` | no | `1`, `true`, `yes`, `y` or `on`: debug logging, like `--debug`. |
| `DMCR_ANSI_OUTPUT` | yes: `1` | PowerShell: `1` prints ANSI colours instead of console colours. Bash: `0` turns colours off. |
| `PGPASSWORD` | no | Used by psql when the connection string has no password. A password inside the connection string is moved to `PGPASSWORD` for each psql call, so it never appears on psql's command line. |
| `PGSSLMODE` | no | When set, `dmcr.cfg` `sslmode` is not applied. |
| `PGOPTIONS` | no | Kept; the runner adds `-c standard_conforming_strings=on` and `-c search_path=<schema>,public`. |
| `PGCLIENTENCODING` | no | Set to `UTF8` when empty. |

The conflict check helper runs without `PGPASSWORD`, `DMCR_CONN` and `DMCR_PROMOTE_FROM_CONN` in its environment.

## The dmcr registry

`dmcr init` creates the registry in the `dmcr` schema of each environment's database. The runner adds missing tables and columns on later runs (it prints `Registry upgraded ...`).

### dmcr.change_log

One row per applied change. Deploy inserts it; revert deletes it.

| Column | What it holds |
|---|---|
| `change_id` | The change folder name (primary key). |
| `applied_at` | When it was applied. |
| `applied_by` | The database user (`current_user`). |
| `description` | Not written by the runner. |
| `deploy_checksum`, `verify_checksum`, `revert_checksum` | SHA-256 of each file when it was applied. |
| `ticket_id` | `meta.json` `ticket`. |
| `git_commit` | Short commit of the changes folder at deploy time. |
| `app_name` | `meta.json` `app_name`. |
| `environment` | The environment name. |
| `actor` | Who ran it (`DMCR_ACTOR`, else `user@machine`). |
| `project_id`, `project_type`, `release_id` | The change's project, its type and its release at deploy time. |
| `change_kind` | `insert`, `update`, `delete`, `dml`, `ddl`, `function`, `type` or `other`. |
| `requested_by`, `created_by` | From `meta.json`. |
| `deploy_id` | The deployment (run) that applied it. |

### dmcr.event_log

Append-only audit trail.

| Column | What it holds |
|---|---|
| `id` | Sequence. |
| `event_ts` | When. |
| `action` | `deploy`, `revert`, `baseline`, `repair`, `manual`, `tag`, `approve`, `unapprove`, `lock`, `unlock`, `cleanup`. |
| `change_id` | The change, or `*` for lock events and `repair --unlock`. |
| `status` | `success` or `failure`. |
| `message` | The error, or a note (for example `Manually marked as applied`). |
| `environment`, `actor` | Where and who. |
| `duration_ms` | How long it took. |
| `deploy_id` | The deploy or revert run it belongs to. |

A deploy writes its success event in the same transaction as the change. A failed deploy or revert writes a `failure` row with the error.

### dmcr.tags

| Column | What it holds |
|---|---|
| `tag_name` | The tag (primary key). |
| `change_id` | The change that was latest when the tag was made. |
| `created_at`, `created_by` | When and which database user. |
| `description` | Optional text from `tag create`. |

### dmcr.repeatable_log

One row per `R__` change.

| Column | What it holds |
|---|---|
| `change_id` | The `R__` folder name. |
| `last_checksum` | SHA-256 of the `deploy.sql` last applied. |
| `applied_at`, `applied_by`, `environment`, `actor` | When, where and who. |

### dmcr.deploy_lock

At most one row (`lock_id = 1`): `holder` (actor, process id and a run id), `environment`, `acquired_at`. See the deploy lock under [Safety checks](#safety-checks).

### dmcr.approval

Created by the first `dmcr approve`.

| Column | What it holds |
|---|---|
| `change_id`, `environment` | The change and the environment (primary key together). |
| `checksums` | The `deploy.sql`, `verify.sql` and `revert.sql` checksums that were approved. |
| `approved_by`, `approved_at`, `note` | Who, when, and the note. |

An approval only counts while the change's files still match `checksums`.

## Safety checks

### Order of the checks in a deploy

1. Unsafe change folder names stop the deploy.
2. The preflight (`check` codes above).
3. `requires` cycles.
4. The deploy plan: promotion gate, out of order, `requires`, approvals.
5. Two environments sharing one database.
6. The conflict check.
7. The round-trip test, except on production.
8. The deploy lock.
9. Edited applied files (`checksum_policy`).
10. Per change: danger rules, `requires` applied, transaction control and psql meta-commands.

Steps 4 to 6 look at the whole plan before anything runs, so on those rules a deploy is all or nothing.

### The deploy lock

`deploy`, `revert` (all forms), `revertLast` and `repeatable` take two locks:

- A lock file in the temp folder, per connection. It stops two runs on the same machine. A lock file left by a process that is no longer running is cleared.
- A row in `dmcr.deploy_lock`. It stops two runs from different machines or users.

If another run holds the database lock:

```text
Another DMCR run holds the database lock (<holder>, since <time>). Wait for it to finish. If that run crashed, clear the lock with: dmcr repair --unlock
```

The lock is released when the run ends, also after a failure. Lock and unlock are logged in `dmcr.event_log`.

### Two environments, one database

`deploy`, `revert`, `revertLast`, `repeatable` and `baseline` refuse a registry that already records changes for another environment of this `dmcr.cfg`:

```text
BLOCKED: this database's DMCR registry already has changes recorded for environment '<other>'. Two environments must not share one database: point '<env>' at its own database.
```

### Checksum policy (Edited after deploy)

When a change is applied, the runner stores the SHA-256 of its `deploy.sql`, `verify.sql` and `revert.sql`. Later runs compare the files with those checksums. Line endings alone (CRLF and LF) do not count as an edit.

| `checksum_policy` | Deploy | Revert of that change |
|---|---|---|
| `warn` (default) | Prints `Applied change files edited since they were deployed: <id>/<file> (checksum_policy=warn — continuing)` and goes on. | Warns and reverts. |
| `block` | Stops: `BLOCKED: applied change files edited since they were deployed: <files>. Restore them, or accept the edit with: dmcr repair --checksums (checksum_policy=block)` | Stops: `BLOCKED: <files> for '<id>' changed since it was applied (checksum mismatch). Policy='block'. Use 'dmcr repair --checksums' to reconcile.` |
| `repair` | Stores the new checksums, logs `Accepted edited <files> (checksum_policy=repair)` in `dmcr.event_log`, and goes on. | Same, then reverts. |

`check` lists every edited applied file as `CHECKSUM`. `deploy --dry-run` with `block` lists them as a blocker.

### The conflict check

Before a deploy (and a dry run), the runner checks the pending changes it would apply with `dmcr_conflicts.cjs`, the same detector as Releases › Conflicts in DMCR. Two changes that define or change the same object, with no merge change resolving it, are a conflict.

| `conflict_check` | Conflicts found | Check cannot run (no Node.js, no helper, helper error) |
|---|---|---|
| `block` (default) | `BLOCKED: N conflict(s) between changes not resolved: ... Merge them in DMCR Web (Releases › Conflicts), or add a merge change, then deploy again.` | `BLOCKED: the conflict check failed: <reason>. To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg.` |
| `warn` | Warning, deploy goes on. | Warning, deploy goes on. |
| `off` | Not checked. | Not checked. |

With `--json` the refusal is a JSON object with `code` `conflicts_unresolved` or `conflict_check_failed`. The check runs before the lock is taken; nothing is applied.

### Danger rules and danger_ changes

A change folder with `danger_` at the start of its name or after an `_` (for example `003_danger_truncate_audit_log`) is manual-only:

- `deploy` skips it and records nothing.
- `revert` refuses it: `BLOCKED: '<id>' is a manual-only (danger_) change. DMCR will not revert it. The DBA must run revert.sql directly against the database.`
- `test` stops at it.
- `check` lists it as `MANUAL` while it is not applied here.
- `manual-script <id> --env <env>` prints one script for the DBA. It refuses when the change is already applied, sets `lock_timeout` and the environment's `search_path`, runs `deploy.sql`, writes the same registry row as `repair --mark-applied`, then runs `verify.sql`, all in one transaction. With `approval = required` the script also refuses to run unless the change is approved with the same files.
- `manual-script <id> --revert --env <env>` prints the same for its revert: `revert.sql`, removing its registry row (as `repair --mark-reverted` does) and `verify.sql` (the reverted state), in one transaction. It refuses when the change is not applied. After it, DMCR sees the change as reverted, so a rollback it blocked can go on.

Other folders are scanned before deploy and revert. SQL in comments and string literals is ignored.

| Rule | Checked in |
|---|---|
| `DROP TABLE`, `DROP SCHEMA`, `DROP DATABASE`, `DROP FUNCTION`, `DROP PROCEDURE`, `DROP VIEW`, `DROP TRIGGER`, `DROP INDEX`, `DROP SEQUENCE`, `DROP TYPE`, `DROP EXTENSION`, `DROP COLUMN` | `deploy.sql` |
| `TRUNCATE` | `deploy.sql` and `revert.sql` |
| `DELETE FROM` without a `WHERE` | `deploy.sql` and `revert.sql` |
| `UPDATE ... SET` without a `WHERE` | `deploy.sql` and `revert.sql`, when turned on |

A `WHERE` that is always true (`WHERE true`, `WHERE 1=1`, `WHERE 'a'='a'`, `WHERE NOT false`, `WHERE 1`) counts as no `WHERE`. A match stops the change:

```text
BLOCKED: Dangerous SQL detected in '004_cleanup_orders':
  >> deploy.sql: DROP TABLE

Rename the folder so a DBA can run it manually — DMCR will never execute it:
  Current : 004_cleanup_orders
  Renamed : 004_danger_cleanup_orders
```

The rules come from `DMCR_DANGER_RULES`, else `dmcr_danger.json` next to the script, never from the current folder. The `dmcr_danger.json` that ships with DMCR has `updateWithoutWhereEnabled` set to `false` and `deleteWithoutWhereEnabled` set to `true`. Each rule gets 2 seconds; a rule that runs out of time counts as a match.

### Transaction control and psql meta-commands

The runner wraps each change in its own transaction. It refuses change files that would get out of it:

- `BEGIN` (not `BEGIN ATOMIC`), `START TRANSACTION`, `COMMIT`, `END`, `ABORT`, `PREPARE TRANSACTION`, and `ROLLBACK` (not `ROLLBACK TO`).
- Any psql backslash command, anywhere on a line (`\c`, `\i`, `\!` and the rest).

Comments, string literals, quoted names and dollar-quoted bodies are left out of the check. The files checked: `deploy.sql` and `verify.sql` at deploy, `revert.sql` and `verify.sql` at revert, `verify.sql` at verify, and the SQL given to `parse`.

```text
BLOCKED: <id>/deploy.sql contains 'COMMIT'. DMCR wraps each change in its own transaction; remove explicit transaction control.
BLOCKED: <id>/deploy.sql contains the psql meta-command '\c otherdb'. Change files run inside a transaction and cannot use psql backslash commands.
```

### Changes outside a transaction

`"transaction": false` in `meta.json` (the JSON value `false`, not the string) runs `deploy.sql` statement by statement, for example for `CREATE INDEX CONCURRENTLY`. The registry row and `verify.sql` then run in a transaction.

- The change must be safe to run again: `CREATE INDEX CONCURRENTLY` needs `IF NOT EXISTS`, `DROP INDEX CONCURRENTLY` needs `IF EXISTS`. Otherwise it is blocked.
- When a statement or `verify.sql` fails, the runner runs `revert.sql` (if it passes the danger and transaction checks) and records nothing.
- A revert of such a change also runs outside a transaction; when it fails, the change stays recorded as applied.

### Lock and statement timeouts

Every transaction the runner opens starts with:

```sql
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
```

with the values from `[dmcr]`. A deploy that waits on a lock held by the application gives up after `lock_timeout` instead of hanging.

### Never send to an environment (environments in meta.json)

```json
{ "environments": ["dev", "test"] }
```

A change with `"environments"` goes only to the environments it names. On any other environment:

- `status` shows `NOT FOR <ENV>` and `deploy`, `repeatable` and `test` skip it.
- `manual-script` and `repair --mark-applied` refuse it: `BLOCKED: <id> is not for <env> (only for dev, test, not <env>)`.
- A pending change that `requires` it is refused: `<id> requires <other>, which never goes to <env> (...)`.

### Promotion gate

With `promote_from = test` in `[prod]`, every change a prod deploy would apply must be applied in `test` with the same `deploy.sql`, `verify.sql` and `revert.sql`. The runner reads the `test` registry through `DMCR_PROMOTE_FROM_CONN`, else `[test] conn`.

Production has this gate even with no `promote_from`: it uses the environment with a connection just before it in `[envs] names`, else any other. Only a production with no other database, or `production = none` in `[envs]`, has no gate.

```text
BLOCKED by promotion gate (test -> prod):
  >> 014_add_status is not applied in test
  >> 012_fix_totals/deploy.sql differs from the one applied in test
```

### Round-trip test before a deploy

On every environment except production, a deploy first runs the changes it would apply through the round trip: deploy, verify, revert, verify, in one transaction that is rolled back. If one fails, nothing is applied:

```text
BLOCKED by round-trip test (test):
  >> 003_add_thing failed the round trip: ERROR: relation "thing" does not exist
  >> Nothing was applied: this ran in a transaction that was rolled back. verify.sql also runs after revert.sql, so it must pass with the change gone.
```

- `deploy --dry-run` runs it too, so **Deploy** on Releases shows the refusal before the Runner opens.
- It covers only what this deploy applies: the same scope and `--to`, without `danger_` changes, dropped changes or repeatables.
- A change that cannot pass, such as one whose revert cannot restore its data exactly, goes out as a [`danger_` change](#manual-only-danger_-changes).
- `round_trip_check = off` under `[dmcr]` in `dmcr.cfg` turns it off. It has no setting in the DMCR Config page. Production's promotion gate stays on.
- A `"transaction": false` change that cannot run in a transaction (for example `VACUUM`) stops the test with a warning, and the changes after it are not tested. The deploy goes on.
- The change runs up to three times on that environment, so a long data change takes that much longer.
- Production never runs it: the promotion gate takes only what was applied on the environment before it. A change applied there before this check existed is not tested again.

### Out of order

With `out_of_order = block`, a pending change whose number is lower than an applied change is refused: `<id> is out of order: <applied id> is already applied (out_of_order=block)`. With `--release`, `--project` or `--kind`, only applied changes in the same scope count, so a project moved to a later release can still go out after the others.

### Approval gate

With `approval = required`, every change in the plan needs an approval for this environment with its current files:

```text
BLOCKED by approval gate (prod):
  >> 014_add_status is not approved for prod — dmcr approve 014_add_status --env prod
```

## Verify, revert and tags

### Verify

| Form | Changes verified |
|---|---|
| `verify` | Every change of the last deployment (the deployment of the most recently applied change). |
| `verify all` | Every applied change, in folder order. |
| `verify <id>` | One applied change, or one applied `R__` change. |

Each `verify.sql` runs in `BEGIN ... ROLLBACK`; nothing it does is kept. Results:

| Status | Meaning |
|---|---|
| `ok` | `verify.sql` passed. |
| `failed` | It failed. The run exits with 1: `verify FAILED: <ids>`. |
| `superseded` | It failed, but a change applied later on this environment rewrote the same objects. The log names those changes. Not a failure. |
| `no_backup` | The change was recorded without running (`baseline` or `repair --mark-applied`) and its `verify.sql` reads a `dmcr.bak_*` backup table that does not exist here. Not a failure. |

`verify` also runs inside every deploy and revert: in the deploy transaction after `deploy.sql`, and in the revert transaction after `revert.sql` and the registry delete. A failure there rolls the whole change back.

### revertLast and revert \<id\>

`revertLast` reverts the most recently applied change. `revert <id>` does the same, but only when `<id>` is that change:

```text
Refusing to revert non-latest change. Latest is '<latest>'. To revert a project, release, kind of change or deployment out of order use: dmcr revert --project <id> | --release <id> [--kind <kind>] | dmcr revert <deployment id>
```

A revert, in one transaction: `revert.sql`, delete the `dmcr.change_log` row, write the event, run `verify.sql` in a savepoint that is rolled back. If anything fails, the revert is rolled back and the change stays applied.

Before it runs, a revert checks the change's files against the stored checksums (see `checksum_policy`), the danger rules on `revert.sql`, and transaction control in `revert.sql` and `verify.sql`.

### revert to

| Form | Reverts | Keeps |
|---|---|---|
| `revert to <id>` | Every change applied after `<id>`, and `<id>` itself, newest first. | Changes applied before `<id>`. |
| `revert to @<tag>` | Every change applied after the tagged change, newest first. | The tagged change and everything before it. |

The target must be applied. `--dry-run` lists the changes it would revert, newest first.

### Scoped revert

`revert --project`, `revert --release` (with an optional `--kind`) and `revert <deploy-id>` revert the applied changes in the scope, newest first, wherever they sit in the stack.

Before anything runs, the runner looks at every change applied later and outside the scope:

- It `requires` a change in the scope: refused.
- It uses an object whose structure a change in the scope changed: refused.
- It only writes the same table's data: a warning, the revert goes on.

Also refused: a `danger_` change in the scope, and an applied change in the scope whose folder is gone.

```text
BLOCKED scoped revert (project B, kind update):
  >> 015_b_more (applied later, outside the scope) requires 011_b_update
```

`--dry-run` prints the plan, the warnings and the problems, and reverts nothing.

`revert <deploy-id>` reverts only what that deployment applied and is still applied from it. A revert deployment cannot be reverted: `Deployment <id> is a revert; to put its changes back, deploy them (dmcr deploy)`.

Every revert run gets its own deployment id; `log` and `deployments` list it.

### Deployment tags and the Tags field of a change

These are two different things.

| | Deployment tag | `tags` in `meta.json` |
|---|---|---|
| Made with | `tag create <name>` | The Tags field of a change |
| Stored in | `dmcr.tags` in each environment's database | The change folder |
| Points to | The change that was latest when the tag was made | Nothing; a label |
| Used by | `deploy --to @<name>`, `test --to @<name>`, `revert to @<name>` | Shown by `status --json` and `plan --json` |

A deployment tag belongs to one environment. `tag list` shows whether the tagged change is still applied there. An unknown tag stops the run: `Tag '@<name>' not found. Use 'dmcr tag list' to see available tags.`

### Repair

| Situation | Command |
|---|---|
| A run crashed and the next run says the database lock is held. | `repair --unlock` |
| A change was applied by hand and must be recorded. | `repair --mark-applied <id>` |
| A change was undone by hand and its record must go. | `repair --mark-reverted <id>` |
| Applied files were edited on purpose and the edit is accepted. | `repair --checksums` |
| An existing database already has the changes up to `<id>`. | `baseline <id>` |

`repair --mark-applied` stores the checksums of the three files as they are now; `baseline` stores the `deploy.sql` checksum only. `repair --checksums` updates the checksums of every applied change, not one.

# Tools and settings

## Schema Diff

Schema Diff compares the objects of two databases: tables, views, functions and sequences. Open it from the **Schema Diff** card on Home (or Ctrl/Cmd + 5). The switch at the top picks **Schema** or **Data**. This page is **Schema**; **Data** is the next page, Data Diff.

Both sides are read through database MCP servers (see Database MCP servers). With no server, the page shows: "No MCP servers configured. Add servers in Settings → MCP Servers."

### Compare two schemas

1. Under **Source**, pick a database and select a schema in its tree.
2. Under **Target**, pick a different database and select a schema.
3. Click **Compare schemas**.

The button stays off until both sides have a server and a schema, and the two servers differ. Its tooltip says what is missing. **Start Again** clears both sides.

### The result

| Card | Meaning |
|---|---|
| Missing | In the source, not in the target. |
| Extra | In the target, not in the source. |
| Drifted | On both, with different DDL. |
| In sync | Identical on both. |
| Expected | Made by a change that only goes to some environments. Shown only when there are any. |

The lists below the cards are **Missing from Target**, **Extra in Target**, **DDL Drift** and **Expected differences**. A drifted object that a change for only some environments also touched says "also changed by &lt;change&gt; (only &lt;environments&gt;)": part of that drift may be expected.

Buttons under the result:

| Button | What it does |
|---|---|
| **Node Graph** / **Hide graph** | Shows the result as a graph. |
| **Export Markdown** | Downloads the report as a `.md` file. |
| **Generate Migration** | Opens Freeform with migration SQL filled in. Shown only when something is missing or drifted. |
| **Show raw JSON** / **Hide raw JSON** | Shows the raw compare result. |

**Generate Migration** writes the SQL without a schema name. Each environment's schema from DMCR Config is its search path. For a drifted table it writes only the statements the target is missing, not the whole `CREATE TABLE`. For a drifted sequence it alters the target to the source's options. Review the SQL in Freeform before you save it.

### Side-by-side DDL

1. In the **Source** tree, check the objects you want.
2. Click **Diff View**.

The diff shows the source and target DDL of each checked object. For an object that is on both sides with different DDL, **Resolve** asks the AI to merge both versions into one script. It lists conflicts, its merge strategy and warnings, with a **Copy** button. Review the merged SQL before you use it.

### AI buttons

| Button | What it does |
|---|---|
| **Drift Check** | Compares the two servers now, asks the AI for a risk-scored summary and shows a notification. **Drift Result** opens the last result again. |
| **Explain Diff** | After a compare: the AI explains why the two databases differ. |

These buttons follow Settings > AI Features (AI Drift Detective, AI Conflict Resolver).

## Data Diff

Data Diff compares the rows of one table on two databases, for example test and prod. Open Schema Diff and switch to **Data**. It only reads: nothing is changed in either database.

### Pick the databases

On top, pick **Source** and **Target**: a database and a schema on each side. On the first visit DMCR picks a test environment as the source and the production environment as the target, each with its schema from DMCR Config. The production side shows a **PROD** tag. Source and target cannot be the same database and schema.

### The sync list

The left pane lists only what is in the **Sync list**: the lookup tables, sequences and functions you keep the same on every environment. Busy tables stay out of the way.

Click **Edit** to change it. The **Sync list** popup takes names separated by commas or spaces:

| You type | Stored as | Meaning |
|---|---|---|
| `country` | `table|country` | That object, under its kind (table, view, materialized view, sequence or function). |
| `lookup_*` | `rule|lookup_*` | Everything whose name starts with `lookup_`, also objects made later. |
| `!lookup_audit_*` | `rule|!lookup_audit_*` | Leaves those out, even when another rule keeps them. |

A name is looked up in the source schema. A function is also found by its name alone, without its argument types. Names that are not found are shown as "Not in &lt;schema&gt;". Before you click **Add**, the popup shows how many objects the words match.

The list is saved in `data-sync.json` in the changes folder, next to `releases.json`. It is shared with every DBA through the repository. When you click **Done** and the list changed, DMCR commits the file and pushes it. You do not run git yourself.

```json
{
  "$comment": "Data Diff sync list: kind|name, rule|prefix_* (keeps), rule|!pattern (leaves out). Edit it in DMCR > Diff > Data > Edit.",
  "items": [
    "rule|!lookup_audit_*",
    "rule|lookup_*",
    "table|country"
  ]
}
```

Under the list, a status line says where the file stands:

| Status | What to do |
|---|---|
| "data-sync.json has changes the other DBAs do not have yet" | Click **Commit**. |
| "Committed &lt;hash&gt; and pushed: the other DBAs get it on their next pull" | Nothing. |
| "Committed &lt;hash&gt; here" | Committed, not pushed. |
| "Not shared: &lt;error&gt;" | Click **Try again**. |

Objects that are only on one side are listed dimmed and cannot be opened. Schema Diff shows those.

### Compare a table

Click a table in the list. It is compared at once.

- Rows are matched by the primary key, else by a unique index whose columns are all NOT NULL.
- **Match by** picks another column to match by.
- A table with no key shows **No key**: rows are compared whole, so you only see rows that are on one side.
- Click a column chip to ignore it (for example `updated_at`), then **Compare again**.
- Columns that exist on only one side are not compared; a note lists them.

The tiles show **Same on both**, **Different values**, **Only on &lt;source&gt;** and **Only on &lt;target&gt;**. Click a tile to see its rows. In **Different values**, each changed cell shows the source value over the target value.

Limits:

- DMCR reads at most 200,000 rows a side. Past that, it says "Read the first 200,000 rows of a side only" and does not write the change.
- When more than 1,000 rows of one kind differ, it does not write the change. Write it in Freeform or Manual instead.

### Make the target match

When rows differ, the **Make &lt;target&gt; match &lt;source&gt;** card writes the change: inserts, updates and, if you check **Also delete the N rows only on &lt;target&gt;**, deletes. It comes with its exact revert and a verify that checks one row of each kind.

- **Preview SQL** shows the deploy SQL.
- **Open in Manual** opens it in Manual, named `sync_<table>_data` with the tag `data-sync`, to self-check and save.

The SQL uses the plain table name. Each environment runs it in its own schema.

```sql
-- country: make the rows match test (1 insert, 1 update, 0 delete)
INSERT INTO "country" ("code", "name") VALUES
  ('NO', 'Norway');
UPDATE "country" SET "name" = 'Germany' WHERE "code" = 'DE';
```

### Sequences, functions and views

| Object | What you see | The change |
|---|---|---|
| Sequence | Last value, Called, Increment, Start, Min, Max, Cycle on both sides. | Moves the target forward with setval to the source's value; the revert puts it back. If the target is ahead, DMCR does not write a change: moving a sequence back could hand out values already used. |
| Function | Both definitions side by side. | `CREATE OR REPLACE` with the source's definition; the revert puts the target's back. If the return type differs, the change drops the function first. |
| View, materialized view | Their rows. | None: compare the tables they read from. |

When a sequence also differs in how it counts (increment, start, min, max or cycle), Schema Diff changes that.

## Schema Explorer

Schema Explorer is a tree of your databases: MCP server, schema, object groups (Tables, Views, Functions, Sequences), objects and columns. In VS Code it is a view in the DMCR side bar, shown when a database MCP server exists. The **Schema Explorer** card on Home opens it.

- Type in **Search tables, views, columns...** to filter the tree.
- **Refresh** reads the servers again.
- With no database server: "No database MCP servers configured. Add one in Settings → MCP Servers."

Right-click a node:

| Node | Menu items |
|---|---|
| Any | **Copy Name** |
| Table, view, function, sequence | **Copy DDL** |
| Schema | **Document Schema**, **Detect Dead Columns** (when on in AI Features) |
| Table | **Generate INSERT rows** (opens DML), **Generate ALTER TABLE** (opens DDL), **Snapshot table** |

**Document Schema** writes a Markdown data dictionary of the schema; **Export .md** saves it. **Detect Dead Columns** lists columns that look unused, with a confidence and a reason.

### Snapshot table

**Snapshot table** creates a change folder that copies the table into a backup table (default name `<table>_backup_DD_MM_YYYY`). Pick the rows:

| Option | What is copied |
|---|---|
| All rows | Structure and every row. |
| Matching rows | Structure and the rows that match a WHERE condition. **Count** shows how many match now. |
| Structure only | Structure, no rows. |

The copy has the same columns and exact types, NOT NULL and the primary key; no defaults, indexes, triggers or foreign keys. The copy is taken when the change deploys, in each environment, through the normal pipeline. The revert drops only the copy. Deploy stops if the table's columns changed since you made the snapshot. Click **Create change folder**.

## AI checks on the Runner

Run `/status` in the Runner. Each change row gets AI check chips. Each chip appears only when its feature is on in Settings > AI Features.

### The checks

| Chip | Rows | Needs a database | What it does |
|---|---|---|---|
| **Gate** | Pending | No | Pre-flight checklist before promoting to production (the production environment in DMCR Config): meta.json has a ticket reference (ticket, jira, linear or issue), deploy.sql and revert.sql exist, the changes in `requires` exist, and the SQL Policies pass. Then the AI gives a verdict: **GO** or **BLOCKED**. |
| **Perf** | Pending | Yes | Lock type, whether it is safe to run concurrently, whether it blocks traffic, estimated duration and a recommendation. Reads the table's size. |
| **Blast** | Pending | Yes | Which views, functions and triggers depend on the tables the change touches (from pg_depend), lock type, estimated block time, risk and a recommendation. |
| **Blue/Green** | Pending | No | Splits a breaking change into two phases: before the app deploy and after it, each with SQL to copy. |
| **Compliance** | Pending | No | Checks deploy.sql against the profiles you tick: GDPR, SOC 2, HIPAA. Click **Check**. |
| **Canary** | Pending | Yes | Reads the table's estimated row count and says whether a gradual rollout is needed: first percentage, metrics to watch, the go-ahead threshold and a rollout script. |
| **Health** | Applied | Yes | The AI writes 3 to 5 read-only checks for what deploy.sql changed, DMCR runs them, and the AI reads the results. Only single SELECT / WITH / EXPLAIN statements are run. |

Click a chip to run it. The result opens in a popup. Click the chip again to open the result; **Run again** (or **Check again** for Compliance) asks again.

### Which database the checks query

Perf, Blast, Canary and Health query a database, read-only, through an MCP server. **AI checks query** above the list picks the server. It starts on the environment the `/status` ran against (its `--env`), else the active environment from DMCR Config. **Auto (first MCP server with run_readonly_query)** lets DMCR choose.

Health runs its checks in that environment's schema, the same as deploy.sql.

### Chip colours

Before it runs, a chip has its own colour. After it runs:

| Colour | Meaning |
|---|---|
| Green | Passed. |
| Amber | Warnings. |
| Red | Failed, or the check returned an error. |

Gate is green only on GO. Perf is green only when its recommendation is SAFE. Blast follows its risk level. Health follows its status. Compliance is red when it finds violations and amber when it finds only warnings. Blue/Green is amber for a breaking change. Canary is amber when it recommends a gradual rollout.

### Optimize order and Gate all pending

With two or more pending changes, two buttons appear above the list:

- **Gate all pending (N)** runs Gate on each pending change, one at a time, with no popups. It shows **Gate 2/5…** while it runs and **Gate: 4 GO · 1 BLOCKED** when done. Click a chip to open its result.
- **Optimize order (N pending)** asks the AI for the safest apply order. It reads each change's `requires` and the start of its deploy.sql. The popup shows the suggested order, conflicts between changes and why. It changes nothing: DMCR deploys in folder-number order. To follow the suggestion, renumber the folders.

## AI provider and AI features

### LLM Provider

Settings > **LLM Provider** has two parts.

**LLM Provider Configuration**

- **Available Providers**: GitHub Copilot and every custom provider you added.
- **Active Provider** and **Default Model**: what DMCR uses now.
- **Available Models**: click a model chip, then **Save as Default**. **Cancel** drops the choice.

**Custom LLM Providers**

Click **Add Provider** and fill in:

| Field | Notes |
|---|---|
| Provider Name | Any name. |
| Type | OpenAI, Anthropic, Gemini, Grok, Mistral, DeepSeek, Qwen, LM Studio, Ollama. |
| Host | Typing a host fills Chat URL and Models URL. |
| Chat URL, Models URL | Required. |
| API Key | Stored in the OS keychain, not in a file. When editing, leave it blank to keep the saved key. |
| Additional Headers | JSON, optional. Header values that carry credentials are kept in the keychain too. |

Click **Save Provider**. Each provider row has **Refresh Models**, **Edit** and **Delete**.

The OS keychain is Keychain Access on macOS, Windows Credential Manager on Windows, and libsecret / GNOME Keyring / KWallet on Linux.

### AI Features

Settings > **AI Features** lists DMCR's AI features in groups: Change Intelligence, Schema & Documentation, Deploy Safety, ST-to-PROD Workflow, Data & Testing.

- The switch on each feature turns it on or off. A change is saved at once.
- A group can be turned on or off as a whole.
- The book icon (**Open in Prompt Library**) opens the feature's prompt.
- Expand a feature to see where it is and how to use it.

A feature that is off hides its button or chip. If something still asks for it, DMCR says "&lt;feature&gt; is turned off. Turn it on in Settings → AI Features."

### Prompt Library

Settings > **Prompt Library** holds the prompts DMCR's AI uses.

1. Pick a prompt in the sidebar (or search with **Search prompts**).
2. Switch between the **System** and **User** prompt, and between **Preview** and **Edit**.
3. Edit the text. **Variables — click to insert** adds a variable. **Agent Name** can be renamed.
4. Click **Save**.

**Reset** puts the open prompt back to DMCR's default. **Reset defaults** puts every edited prompt back; only prompts change. Leaving a prompt with unsaved edits asks first (**Discard & Continue**).

### Conv Chips

Settings > **Conv Chips** (Conversation Chips) are the quick prompts on the Conversation landing page. Each chip has a label, an icon and the full message it sends. Add one under **Add chip** with **Add Chip**, remove one with its remove button, then **Save**. **Reset to Defaults** brings back DMCR's chips.

## Database MCP servers

DMCR reads your databases through MCP servers: Schema Diff, Data Diff, Schema Explorer and the AI checks all use them. Manage them in Settings > **MCP Servers**.

### Servers made by DMCR

DMCR makes one database server for each environment in DMCR Config. You do not add these. Add or remove an environment in DMCR Config and its server follows.

- Its name is the environment's name and it is tagged **auto**.
- It connects with `APP_PG_CONN=@env:<name>`. When the server starts, `@env:<name>` becomes that environment's database URL from dmcr.cfg with its password from the OS keychain.
- Each session's search_path is set to the environment's schema, then `public`. A query for `order_note` on test reads test's schema.

If you edit an auto server, it is tagged **auto · edited** and DMCR keeps your edits. If you delete one, it stays deleted. **Restore defaults** brings back DMCR's server for every environment, deleted or edited ones too.

The box **Database servers from DMCR Config** shows the **Program** these servers run. **Set** or **Change** it: the command (for example the `python.exe` of the pgsql_mcp venv) and its arguments (`-m app_mcp.server`).

### pgsql_mcp

`pgsql_mcp` is the PostgreSQL MCP server that comes with DMCR (package `app_mcp`). It gives read-only access to the schema:

| Tool | What it does |
|---|---|
| `discover_schemas` | Lists the schemas. |
| `discover_objects` | Lists tables, views, functions, sequences and enums in a schema. |
| `describe_table`, `describe_function`, `describe_sequence` | Details of one object. |
| `run_readonly_query` | One read-only statement (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) in a READ ONLY transaction, 10 s timeout, at most 1000 rows. |

`run_readonly_query` refuses stacked statements and functions such as `pg_terminate_backend`, `pg_sleep`, `set_config` and `dblink`.

### Your own servers

Click **Add server**:

| Field | Notes |
|---|---|
| Name | Required. |
| Description | Optional; given to the AI as a hint. |
| Transport | stdio (spawn subprocess), http (JSON-RPC POST), sse (server-sent events). |
| Category | Database (enables Schema Explorer), General, Docs, Code. |
| Command, Arguments | For stdio. Arguments one per line. |
| Environment | `KEY=value` per line. **Database from DMCR Config:** buttons insert `@env:<name>` so the server uses that environment's URL and password. |
| Working Directory | Optional, for finding config files like `app_mcp.yml`. |
| URL, Headers | For http and sse. |

Each server row has **Tools**, **Restart**, **Edit**, **Duplicate** and delete. A dot shows whether it is connected. Database servers are checked and shown as **Compliant** or **Non-compliant** (the tooltip lists the missing tools). A server of yours that points at the same database as an auto server is tagged **copy** and can be deleted.

## Settings reference

Settings has these sections, in this order.

### General

**Long lists**: **Rows per page** in Releases, Runner results and previews (10, 15, 20, 25, 50 or 100; default 10). Click **Save**.

**Danger zone > Erase local data** makes DMCR as if it were uninstalled and installed again. Type `ERASE` to confirm. It cannot be undone.

| Goes (this machine) | Stays |
|---|---|
| Your environments, their passwords and release rules. dmcr.cfg goes; the setup wizard makes it again. | The databases DMCR connects to and what is in them, the dmcr registry included. |
| AI providers and their keys, MCP servers. | Your change folders, releases.json and git history. |
| DMCR's local database file: your DBA name, chats, the AI footprint, Runner history and drafts. A new, empty one is made. | The extension itself: no reinstall needed. |
| DMCR's storage folder; danger rules go back to the default; saved UI state and open tabs. | |
| DMCR's settings, except where its database file lives. | |

DMCR then starts again on the setup wizard.

### DMCR Config

Where your changes live and which databases they go to. Saved to `dmcr.cfg` (its path is shown at the top). Database URLs are saved without passwords; passwords go to the OS keychain only. Click **Save** at the bottom.

| Card | Fields |
|---|---|
| Basics | **DBA name** (required: DMCR saves nothing until it is set), **Active environment** (the database the Runner and Releases use unless you pick another). |
| Changes folder | Path, relative to the workspace or full; **Browse**. Lists the newest 25 change folders with their last commit, or "not committed". |
| Environments | One card per database: **Name**, **Database URL** (without the password) with **Test**, **Schema**, **Password**. **Production?** marks the one production environment. **Add** adds an environment. |
| Release rules | Per environment, see below. |
| Git | **Remote URL**, **Branch** (with **Fetch**), **Auto-commit**: "Commit and push each new change". |
| Advanced | **psql program**, **Lock wait**, **Statement limit**, **Runner history**. |

The **Schema** of an environment is the schema its changes run in. Change SQL never names a schema, so the same files run on every environment.

Environment names start with a letter, then letters, digits, `_` or `-`. They cannot be `dmcr`, `envs`, `compare` or `placeholders`.

**Release rules**

| Column | Choices | Meaning |
|---|---|---|
| Promote from | anything, or "only what ran on &lt;env&gt;" | Deploy here only what already ran in that environment, with identical files. Production always has this rule when another environment has a database, and offers no anything; it starts on the environment before it. |
| Older changes | allowed, blocked | Block a change older than one already applied here. |
| Sign-off | not needed, required | Each change needs a DBA sign-off for this environment (Releases > Approve). An edit after it needs a new one. |
| Who signs off | names, comma separated | DBAs allowed to sign off; empty means any DBA. Whoever made or asked for a change never signs it off. |

**Edited after deploy**: what happens when files of an applied change are edited later.

| Choice | Effect |
|---|---|
| warn and continue (default) | Logs a warning, deploy goes on. |
| block the deploy | Deploy stops. |
| accept the edit (logged) | The new files are accepted and the edit is recorded. |

**Advanced**

| Field | Default | Meaning |
|---|---|---|
| psql program | from PATH | Full path to psql; empty uses psql from PATH. |
| Lock wait | 30s | Give up when a table lock is not free after this long. |
| Statement limit | 5min | Stop any statement that runs longer than this. |
| Runner history | 50 | How many recent runs the Runner keeps. |

### DMCR Storage

DMCR's local SQLite database: **SQLite Version**, **Database Size**, **Tables**, and the paths of the **Database File** and **Extension Root**. Under **AI Footprint**: **Max audit records to keep** and **Max audit records to show**, each with **Save**. **Refresh** reads it again.

### Developer Tools

| Tool | What it shows |
|---|---|
| Memory Footprint | Extension process, OS memory, CPU and runtime info. |
| AI Footprint | Every AI call with its payload and timing. |
| Audit Log | AI calls, MCP tool calls, metadata, timing. |
| Agent Trace | Step-by-step trace of the Assistant's agents. |
| DB Explorer | DMCR's SQLite tables: view, select and delete rows. |
| Debug Snapshot | Raw diagnostic JSON to copy. |

### MCP Servers

See Database MCP servers.

### Theme

- **Mode**: System, Dark (default) or Light.
- **Palettes**: recolour everything. Edit the **Dark half** or **Light half**. **New**, **Import**, **Export all**, **Show hidden**.
- **Terminal themes**: the colours of the Runner output.
- Hover a palette or terminal theme to preview it; click to use it.

### Danger Rules

The SQL patterns that make a change dangerous. A change with such SQL must have `danger_` in its folder name; deploy never runs a `danger_` change.

| Group | Default rules |
|---|---|
| Deploy-only patterns (blocked in deploy.sql only) | DROP TABLE, DROP SCHEMA, DROP DATABASE, DROP FUNCTION, DROP PROCEDURE, DROP VIEW, DROP TRIGGER, DROP INDEX, DROP SEQUENCE, DROP TYPE, DROP EXTENSION, DROP COLUMN |
| Always patterns (blocked in both deploy.sql and revert.sql) | TRUNCATE |
| Extra checks | Block DELETE without WHERE in deploy.sql; Block UPDATE without WHERE in deploy.sql |

Tick or untick a rule, then **Save rules**. **Reset to defaults** brings back the built-in rules (click it twice: the second click resets). The rules are saved in `dmcr_danger.json` in DMCR's storage folder (shown under **Rules file**). DMCR passes this file to `dmcr.ps1` / `dmcr.sh` on every run, and Set up CI copies it into the repository for the pull-request check.

### AI Features

See AI provider and AI features.

### SQL Policies

Rules in plain words that the AI checks your deploy SQL against, for example "ALTER TABLE ADD COLUMN must be nullable or have a DEFAULT". Type one and click **Add Policy**, or **Add** an example. Each policy has **Edit** and delete.

Policies are checked when a change card loads in the Assistant; violations show as a red or amber banner on the card. Gate also checks them. Policies are stored in DMCR's local database.

### DMCR Wiki

This wiki. **Search the wiki** finds a page. It is the same text the Assistant searches.

## Editing and clipboard

### The right-click menu

Right-click works the same in every DMCR page.

| Where | Menu |
|---|---|
| SQL editor | Cut, Copy, Paste, Undo, Redo, Find and Replace (Find when read-only), Change All Occurrences, Toggle Comment, Format Document, Fold All, Unfold All, Select All, Command Palette |
| Text field | Undo, Redo, Cut, Copy, Paste, Select All |
| Selected text elsewhere | Copy |

In a read-only editor, Cut and Paste are off and the other editing items are left out. In a password field, Cut and Copy are off. Elements that have a menu of their own keep it.

### Paste in VS Code

A VS Code page is often not allowed to read the clipboard, so Ctrl+V (Cmd+V on a Mac) could do nothing. DMCR reads the clipboard through the extension host instead. Paste from the menu and Ctrl+V both work in editors and fields. In DMCR Web the browser's own paste is used.

### Copy buttons

Copy buttons show a copy icon. After a copy the icon turns into a green check for a moment, and a labelled button reads **Copied**.

## Troubleshooting

### psql not found

Messages:

- In the setup wizard: "psql not found: install the PostgreSQL client, or give the full path to psql here"
- On **Test** of a database: "psql not found: install the PostgreSQL client (psql), or set its path in DMCR Config › psql program"

DMCR looks for psql in this order: the path you typed, the saved path, `DMCR_PSQL`, PATH, then the usual install folders. On Windows that includes `PostgreSQL\<version>\bin\psql.exe` under Program Files, and pgAdmin 4's own `pgAdmin 4\runtime\psql.exe`.

What to do:

1. Install the PostgreSQL client, or find psql.exe (pgAdmin 4 ships one in its `runtime` folder).
2. In the setup wizard's **psql** step, click **Browse**, pick psql, then **Save**. Or set it in Settings > DMCR Config > Advanced > **psql program**.

### Releases or another tab shows the setup wizard

Every tab except Settings shows **Set up DMCR** until DMCR can work. That is when any of these is missing:

- the DBA name,
- at least one database,
- the changes folder,
- an AI provider with a key,
- the dmcr registry on an environment ("registry not found").

Finish the open steps. In **Set up each database**, click **Set up &lt;env&gt;** or **Set up all**, then **Check again**. When every step is green, click **Open DMCR**.

### The conflict check failed

Before a deploy, the runner checks that no two changes change the same object without a merge. The check runs on Node.js with the helper `dmcr_conflicts.cjs`. When DMCR runs the runner, it passes its own Node.js and its bundled helper.

Messages:

```text
BLOCKED: the conflict check failed: Node.js not found (put node on PATH or set DMCR_NODE). To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg.
BLOCKED: the conflict check failed: dmcr_conflicts.cjs not found next to the runner (or set DMCR_CONFLICTS_JS). To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg.
```

The part after "failed:" says which piece is missing. When the check finds real conflicts, the message is different: it lists them and says to merge them in Releases › Conflicts, or add a merge change.

### A danger_ change was not deployed

Deploy never runs a change whose folder name has `danger_`. The runner logs "manual-only (danger_): the DBA runs it by hand".

In Releases, the banner "N manual change(s) waiting on &lt;env&gt;" lists them:

- **Script for DBeaver** gives the script: deploy, the registry record and verify in one transaction. Run it in DBeaver or psql and DMCR sees it applied.
- **Mark applied**: when you ran the SQL another way. DMCR checks it with verify.sql first.

When a change in a normal folder has dangerous SQL, the deploy stops:

```text
BLOCKED: Dangerous SQL detected in '004_drop_old_note':
  >> deploy.sql: DROP TABLE

Rename the folder so a DBA can run it manually — DMCR will never execute it:
  Current : 004_drop_old_note
  Renamed : 004_danger_drop_old_note
```

The rules are in Settings > Danger Rules.

### Verify failed

On deploy, deploy.sql, the registry record and verify.sql run in one transaction. If verify fails, nothing is applied:

```text
deploy.sql or verify.sql failed — the whole change was rolled back, nothing was applied.
```

The database error follows the message. Fix the change's SQL and deploy again. A separate verify run logs "&lt;id&gt; verify FAILED" for each change whose verify.sql fails, and ends with "verify FAILED: &lt;ids&gt;".

### Checksum mismatch

The files of an applied change were edited after it was deployed. What happens depends on Settings > DMCR Config > Release rules > **Edited after deploy**:

| Setting | Message |
|---|---|
| warn and continue | "Applied change files edited since they were deployed: … (checksum_policy=warn — continuing)" |
| block the deploy | "BLOCKED: applied change files edited since they were deployed: …" |
| accept the edit (logged) | "Accepted edited applied change files: …" |

Restore the files, or accept the edit: in the Runner, run **/repair --checksums**. It recalculates the stored checksums from the files on disk.

### This page could not be shown

A page failed while drawing. The message under it is the error. Click **Reload**. The rest of DMCR keeps working.

### A feature is turned off

"&lt;feature&gt; is turned off. Turn it on in Settings → AI Features." Turn the feature on in Settings > AI Features.

