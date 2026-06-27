# Zapper DB — DMCR Change Prompts

Use these prompts in the DMCR chat assistant to generate change cards. Each generated change will be saved to `fake/zapper/changes/` and can be deployed via `dmcr deploy` to ST and PROD.

---

## DDL Form (schema changes)

### DDL Example 1 — Add a column

```
Generate a DMCR change card to add a new column `reconnect_confirmed_at TIMESTAMPTZ` to the `disconnect_requests` table.
The column should be nullable and have no default.
Add a comment: "Timestamp when DNO confirmed physical reconnection."
Target both zapper_st and zapper_prod.
Use DDL form.
```

**Expected output:** A change card in `fake/zapper/changes/` with:
- `deploy.sql`: `ALTER TABLE disconnect_requests ADD COLUMN reconnect_confirmed_at TIMESTAMPTZ;`
- `verify.sql`: `SELECT column_name FROM information_schema.columns WHERE table_name='disconnect_requests' AND column_name='reconnect_confirmed_at';`
- `revert.sql`: `ALTER TABLE disconnect_requests DROP COLUMN IF EXISTS reconnect_confirmed_at;`

---

### DDL Example 2 — Add an index

```
Generate a DMCR change card to add a composite index on `disconnect_requests(status, bundle_code)` named `idx_disc_req_status_bundle`.
This index improves the RATSNI backlog query which filters by status=700 and groups by bundle.
Use DDL form. Target zapper_st only for now (will promote to prod after testing).
```

**Expected output:** A change card with:
- `deploy.sql`: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disc_req_status_bundle ON disconnect_requests(status, bundle_code);`
- `verify.sql`: checks `pg_indexes` for the index name
- `revert.sql`: `DROP INDEX IF EXISTS idx_disc_req_status_bundle;`

---

## DML Form (data changes)

### DML Example 1 — Update reference data

```
Generate a DMCR change card to update the BASIC bundle SLA from 24 hours to 48 hours.
The bundle code is 'BASIC'. This is a business decision to give BASIC-tier customers more time before SLA breach.
Use DML form. Target both zapper_st and zapper_prod.
```

**Expected output:** A change card with:
- `deploy.sql`: `UPDATE bundles SET sla_hours = 48 WHERE code = 'BASIC';`
- `verify.sql`: `SELECT code, sla_hours FROM bundles WHERE code = 'BASIC';` (asserts result is 48)
- `revert.sql`: `UPDATE bundles SET sla_hours = 24 WHERE code = 'BASIC';`

---

### DML Example 2 — Insert new reference row

```
Generate a DMCR change card to insert a new disconnect status code 750 with label 'RATSNI_ESCALATED'.
Description: 'Request has been manually escalated within RATSNI queue after SLA breach. Awaiting priority DNO slot.'
system_owner = 'RATSNI', is_terminal = false, next_statuses = ARRAY[800, 999], sla_hours = 1.
Use DML form.
```

**Expected output:** A change card with:
- `deploy.sql`: `INSERT INTO disconnect_status_codes (...) VALUES (750, 'RATSNI_ESCALATED', ...);`
- `verify.sql`: `SELECT * FROM disconnect_status_codes WHERE code = 750;`
- `revert.sql`: `DELETE FROM disconnect_status_codes WHERE code = 750;`

---

## Freeform

### Freeform Example 1 — Business rule as function update

```
The SLA check function `check_sla_breaches()` should also set a new alert severity to 'critical' (not 'warning') for SAVE360 bundle when arrears exceed £1,000. 
Currently it sets severity based only on ENT vs non-ENT bundle.
Update the function to add this extra condition.
Generate a DMCR change card in freeform style.
```

**Expected output:** A change card with updated `09_functions.sql` logic targeting the INSERT INTO alerts section in `check_sla_breaches()` — the CASE expression gains a new condition: `WHEN b.code = 'SAVE360' AND dr.arrears_amount_gbp > 1000 THEN 'critical'`.

---

### Freeform Example 2 — New view

```
I want a new view called `high_value_backlog` that shows all disconnect requests at status 700 (RATSNI) where arrears_amount_gbp > 500.
Include: request_id, customer_name, bundle_code, arrears_amount_gbp, sla_breached, age_days.
Sort by arrears descending.
Generate a DMCR change card in freeform style. Add it to 10_views.sql.
```

**Expected output:** A change card with:
- `deploy.sql`: `CREATE OR REPLACE VIEW high_value_backlog AS SELECT ... FROM ratsni_backlog WHERE arrears_amount_gbp > 500 ...`
- `verify.sql`: `SELECT COUNT(*) FROM high_value_backlog;` and `SELECT * FROM high_value_backlog LIMIT 3;`
- `revert.sql`: `DROP VIEW IF EXISTS high_value_backlog;`

---

## Between-schema (ST vs PROD comparison)

### Between-schema Example 1 — Detect drift

```
Compare the schema between zapper_st and zapper_prod.
Specifically check:
1. Do both have the same set of tables?
2. Does `disconnect_requests` have the same columns in both?
3. Are the same indexes present in both?
Report any differences as anomalies and suggest a migration SQL to bring PROD in sync with ST.
Use the MCP schema compare feature.
```

**What this tests:** The AI schema diff feature — DMCR connects MCP to both DBs, fetches DDL from each, runs AI comparison, surfaces anomalies. For example: if ST has `reconnect_confirmed_at` column from DDL Example 1 above but PROD doesn't, the anomaly report will flag it and generate the migration SQL automatically.

---

### Between-schema Example 2 — Function drift

```
I deployed a new version of `check_sla_breaches()` to zapper_st but haven't promoted it to zapper_prod yet.
Compare the function definitions between ST and PROD.
Show me a side-by-side diff and generate the migration SQL to apply the ST version to PROD.
Use the pgsql_mcp compare_schemas tool.
```

**What this tests:** The `compare_schemas` tool in `pgsql_mcp/app_mcp/server.py`. DMCR calls `get_ddl` on both connections, AI diffs the function body, returns the migration SQL as a DMCR change card ready to deploy.

---

## How to use these prompts

1. Open DMCR chat assistant (or Claude with DMCR context)
2. Paste a prompt above
3. DMCR generates the change card and saves it to `fake/zapper/changes/change_MM_DD_YYYY_HH_MM_SS.md`
4. Review the generated SQL in the change card
5. Run `dmcr deploy --env st` to apply to `zapper_st`
6. Verify with `dmcr verify --env st`
7. Promote to prod: `dmcr deploy --env prod`
8. Optional: test the between-schema prompts to confirm ST and PROD are in sync
