# Zapper DB — Test Verification Guide

ST is loaded manually (it's the source of truth for development).
PROD is **never touched manually** — it is always deployed via `dmcr deploy --env prod`.

---

## Setup

```bash
# 1. Create users (run as postgres superuser)
psql -U postgres -f db/00_create_users.sql

# 2. Create databases (empty shells — PROD starts empty, DMCR fills it)
psql -U postgres -c "CREATE DATABASE zapper_st   OWNER zapper_st;"
psql -U postgres -c "CREATE DATABASE zapper_prod OWNER zapper_prod;"

# 3. Load schema + seed into ST only
for f in db/01_schema.sql db/02_seed_reference.sql db/03_seed_customers_supply.sql \
          db/04_seed_disconnect.sql db/05_seed_logs.sql db/06_meter_readings.sql \
          db/07_payment_history.sql db/08_alerts_notifications.sql \
          db/09_functions.sql db/10_views.sql; do
  echo "→ $f"
  psql -U zapper_st -d zapper_st -f "$f"
done

# PROD: deploy via DMCR, not manually
# dmcr deploy --env prod
```

---

## File-by-file verification queries

### 01_schema.sql — Tables and columns

```sql
-- Confirm all 12 tables exist
SELECT table_name FROM information_schema.tables
WHERE  table_schema = 'public'
ORDER BY table_name;
-- Expect: alerts, api_request_logs, bundles, customers, disconnect_request_logs,
--         disconnect_requests, disconnect_status_codes, external_system_messages,
--         field_engineers, field_jobs, meter_readings, ofgem_compliance_checks,
--         payment_attempts, supply_points, validation_failures

-- Confirm sla_breached column exists with correct defaults
SELECT column_name, data_type, column_default, is_nullable
FROM   information_schema.columns
WHERE  table_name = 'disconnect_requests'
  AND  column_name IN ('sla_breached', 'sla_breach_at');
-- Expect: sla_breached BOOLEAN NOT NULL DEFAULT false, sla_breach_at TIMESTAMPTZ nullable
```

### 02_seed_reference.sql — Bundles and status codes

```sql
SELECT code, name, sla_hours FROM bundles ORDER BY sla_hours;
-- Expect: ENT(2h), SAVE360(4h), SAVE240(8h), BASIC(24h)

SELECT COUNT(*) FROM disconnect_status_codes;
-- Expect: 10+ rows covering 100..999

SELECT code, label, is_terminal FROM disconnect_status_codes WHERE is_terminal = TRUE;
-- Expect: 999 (DISCONNECTED), possibly others
```

### 03_seed_customers_supply.sql — Customers and supply points

```sql
SELECT COUNT(*) FROM customers;         -- Expect: 10+
SELECT COUNT(*) FROM supply_points;     -- Expect: 12+

SELECT c.name, sp.mpan, sp.postcode
FROM   customers c JOIN supply_points sp ON sp.customer_id = c.id
LIMIT 5;
```

### 04_seed_disconnect.sql — Disconnect requests

```sql
SELECT COUNT(*) FROM disconnect_requests;    -- Expect: 20+

SELECT status, COUNT(*) FROM disconnect_requests GROUP BY status ORDER BY status;
-- Expect statuses including 100, 200, 300, 700, 800, 999

SELECT COUNT(*) FROM disconnect_requests WHERE status = 700;
-- Expect: 10+ (RATSNI backlog)

SELECT COUNT(*) FROM disconnect_requests WHERE sla_breached = TRUE;
-- Expect: several (populated by seed — can also be 0 before check_sla_breaches() runs)
```

### 05_seed_logs.sql — Logs and external messages

```sql
SELECT COUNT(*) FROM disconnect_request_logs;
SELECT COUNT(*) FROM external_system_messages;
SELECT COUNT(*) FROM ofgem_compliance_checks;
SELECT COUNT(*) FROM field_engineers;
SELECT COUNT(*) FROM field_jobs;
```

### 06_meter_readings.sql — Meter readings

```sql
SELECT COUNT(*) FROM meter_readings;   -- Expect: 60+

SELECT supply_point_id, COUNT(*) AS reads, MIN(reading_date), MAX(reading_date)
FROM   meter_readings
GROUP BY supply_point_id
ORDER BY supply_point_id;

SELECT reading_type, COUNT(*) FROM meter_readings GROUP BY reading_type;
-- Expect: actual, estimated, customer
```

### 07_payment_history.sql — Payment attempts

```sql
SELECT COUNT(*) FROM payment_attempts;  -- Expect: 30+

SELECT payment_status, COUNT(*), SUM(amount_gbp)
FROM   payment_attempts
GROUP BY payment_status;
-- Expect: failed (most), cleared (some), pending (few)

SELECT disconnect_request_id, COUNT(*) AS attempts
FROM   payment_attempts
GROUP BY disconnect_request_id
ORDER BY attempts DESC
LIMIT 5;
-- Top offender should be ZAP-REQ-700004 (4 failed attempts)
```

### 08_alerts_notifications.sql — Alerts

```sql
SELECT COUNT(*) FROM alerts;   -- Expect: 15+

SELECT alert_type, severity, COUNT(*), COUNT(*) FILTER (WHERE acknowledged = FALSE)
FROM   alerts
GROUP BY alert_type, severity
ORDER BY alert_type, severity;

SELECT COUNT(*) FROM alerts WHERE acknowledged = FALSE AND severity = 'critical';
-- Expect: 3+ (ZAP-REQ-700001, 700004 sla_breach + ratsni_timeout, bulk_threshold)
```

### 09_functions.sql — Functions

```sql
-- Confirm functions exist
SELECT routine_name FROM information_schema.routines
WHERE  routine_schema = 'public'
  AND  routine_type   = 'FUNCTION'
ORDER BY routine_name;
-- Expect: check_sla_breaches, get_request_summary, get_sla_deadline,
--         get_status_report, get_usage_trend, transition_request_status

-- Test get_sla_deadline
SELECT get_sla_deadline('ZAP-REQ-700001');  -- Returns TIMESTAMPTZ

-- Test get_status_report
SELECT * FROM get_status_report() ORDER BY status_code;

-- Test check_sla_breaches (safe — only updates rows where SLA passed)
SELECT * FROM check_sla_breaches();

-- Test get_usage_trend
SELECT * FROM get_usage_trend('SP-00001', 6);

-- Test get_request_summary
SELECT * FROM get_request_summary('ZAP-REQ-700001');
```

### 10_views.sql — Views

```sql
-- Confirm views exist
SELECT table_name FROM information_schema.views
WHERE  table_schema = 'public'
ORDER BY table_name;
-- Expect: disconnect_summary, meter_reading_trends, open_critical_alerts,
--         payment_failure_summary, ratsni_backlog, sla_breach_overview, vulnerable_at_risk

-- Test each view
SELECT COUNT(*) FROM disconnect_summary;
SELECT COUNT(*) FROM ratsni_backlog;          -- Should show status=700 requests
SELECT COUNT(*) FROM sla_breach_overview;     -- sla_breached=TRUE requests
SELECT COUNT(*) FROM payment_failure_summary;
SELECT COUNT(*) FROM meter_reading_trends;
SELECT COUNT(*) FROM vulnerable_at_risk;
SELECT COUNT(*) FROM open_critical_alerts;    -- unacknowledged critical/warning alerts

-- Smoke test: RATSNI backlog with SLA info
SELECT request_id, customer_name, bundle_code, sla_hours, age_days, sla_breached
FROM   ratsni_backlog
ORDER BY age_days DESC
LIMIT 5;
```

---

## Cross-env comparison (ST vs PROD)

PROD is populated by deploying DMCR change cards — not by running SQL manually.
Once you've deployed to PROD via DMCR, use `compare_schemas` (pgsql_mcp) to verify parity.

```json
{
  "tool": "compare_schemas",
  "arguments": {
    "second_conn": "postgresql://zapper_prod:zapper_prod_2026!@localhost:5432/zapper_prod",
    "schema": "public",
    "object_types": ["table", "view", "function"]
  }
}
```

After a full deploy, `drifted` should be empty and all objects appear in `in_sync`.
To simulate drift: make a schema change in ST only, re-run `compare_schemas` — it will surface in `drifted` with side-by-side DDL.

---

## Known issues (fixed)

| Error | Root cause | Fix |
|-------|-----------|-----|
| `column dr.sla_breached does not exist` | Column was added via `ALTER TABLE` inside `check_sla_breaches()` — PostgreSQL validates STABLE functions and views at CREATE time | Declared in `01_schema.sql` `CREATE TABLE` |
| `syntax error at or near "dr"` | Same root cause — function body invalid at parse time | Same fix |
| `relation "zapper.meter_readings" does not exist` | Files 06-08 used `zapper.` schema prefix | All tables in public schema, `zapper.` prefix removed |
