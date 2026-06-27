-- ============================================================
-- Zapper — Views  (FIXED — public schema, no zapper. prefix)
-- All views use public schema tables and functions.
-- sla_breached is a real column (NOT NULL DEFAULT FALSE) —
-- no COALESCE needed.
-- ============================================================

-- ── Active disconnect requests with SLA status ────────────────────────────
CREATE OR REPLACE VIEW disconnect_summary AS
SELECT
    dr.id                                                  AS request_id,
    dr.account_number,
    c.name                                                 AS customer_name,
    dr.bundle_code,
    b.sla_hours,
    sp.mpan,
    sp.postcode,
    sp.is_vulnerable,
    dsc.label                                              AS status_label,
    dr.status,
    dr.arrears_amount_gbp,
    dr.sla_breached,
    dr.sla_breach_at,
    get_sla_deadline(dr.id)                               AS sla_deadline,
    EXTRACT(EPOCH FROM (now() - dr.created_at)) / 3600.0  AS age_hours,
    dr.created_at,
    dr.updated_at
FROM   disconnect_requests dr
JOIN   customers             c   ON c.id  = dr.customer_id
JOIN   disconnect_status_codes dsc ON dsc.code = dr.status
JOIN   supply_points         sp  ON sp.id = dr.supply_point_id
LEFT JOIN bundles             b   ON b.code = dr.bundle_code
ORDER BY dr.sla_breached DESC, dr.created_at ASC;


-- ── SLA breach overview ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW sla_breach_overview AS
SELECT
    dr.id                                                  AS request_id,
    c.name                                                 AS customer_name,
    dr.bundle_code,
    b.sla_hours,
    dr.status,
    dsc.label                                              AS status_label,
    dr.arrears_amount_gbp,
    dr.sla_breach_at,
    get_sla_deadline(dr.id)                               AS sla_deadline,
    EXTRACT(EPOCH FROM (now() - dr.sla_breach_at)) / 3600.0
                                                           AS hours_since_breach,
    dr.created_at
FROM   disconnect_requests dr
JOIN   customers             c   ON c.id  = dr.customer_id
JOIN   disconnect_status_codes dsc ON dsc.code = dr.status
LEFT JOIN bundles             b   ON b.code = dr.bundle_code
WHERE  dr.sla_breached = TRUE
ORDER BY dr.sla_breach_at ASC;


-- ── RATSNI backlog (status 700) ───────────────────────────────────────────
CREATE OR REPLACE VIEW ratsni_backlog AS
SELECT
    dr.id                                                  AS request_id,
    c.name                                                 AS customer_name,
    dr.bundle_code,
    b.sla_hours,
    dr.arrears_amount_gbp,
    dr.sla_breached,
    sp.dno_region,
    sp.is_vulnerable,
    get_sla_deadline(dr.id)                               AS sla_deadline,
    EXTRACT(EPOCH FROM (now() - dr.created_at)) / 86400.0 AS age_days,
    COUNT(pa.id)                                           AS payment_attempts,
    dr.created_at
FROM   disconnect_requests dr
JOIN   customers             c   ON c.id  = dr.customer_id
JOIN   supply_points         sp  ON sp.id = dr.supply_point_id
LEFT JOIN bundles             b   ON b.code = dr.bundle_code
LEFT JOIN payment_attempts   pa  ON pa.disconnect_request_id = dr.id
WHERE  dr.status = 700
GROUP BY dr.id, c.name, dr.bundle_code, b.sla_hours, dr.arrears_amount_gbp,
         dr.sla_breached, sp.dno_region, sp.is_vulnerable, dr.created_at
ORDER BY dr.sla_breached DESC, dr.created_at ASC;


-- ── Payment failure summary ────────────────────────────────────────────────
CREATE OR REPLACE VIEW payment_failure_summary AS
SELECT
    dr.id                                                  AS request_id,
    c.name                                                 AS customer_name,
    dr.bundle_code,
    dr.arrears_amount_gbp,
    COUNT(pa.id)                                           AS total_attempts,
    COUNT(pa.id) FILTER (WHERE pa.payment_status = 'failed')
                                                           AS failed_attempts,
    COUNT(pa.id) FILTER (WHERE pa.payment_status = 'cleared')
                                                           AS cleared_attempts,
    SUM(pa.amount_gbp) FILTER (WHERE pa.payment_status = 'failed')
                                                           AS total_failed_gbp,
    MAX(pa.attempt_date)                                   AS last_attempt_date,
    dr.status,
    dsc.label                                              AS status_label,
    dr.sla_breached
FROM   disconnect_requests dr
JOIN   customers             c   ON c.id = dr.customer_id
JOIN   disconnect_status_codes dsc ON dsc.code = dr.status
LEFT JOIN payment_attempts   pa  ON pa.disconnect_request_id = dr.id
GROUP BY dr.id, c.name, dr.bundle_code, dr.arrears_amount_gbp, dr.status, dsc.label, dr.sla_breached
ORDER BY failed_attempts DESC, dr.arrears_amount_gbp DESC;


-- ── Meter reading trends (last 6 months) ──────────────────────────────────
CREATE OR REPLACE VIEW meter_reading_trends AS
SELECT
    sp.id                                                  AS supply_point_id,
    sp.mpan,
    c.name                                                 AS customer_name,
    sp.dno_region,
    date_trunc('month', mr.reading_date)::DATE             AS reading_month,
    AVG(mr.reading_kwh)::NUMERIC(12,3)                    AS avg_kwh,
    COUNT(mr.id)                                           AS reading_count,
    string_agg(DISTINCT mr.reading_type, ', ')             AS reading_types
FROM   meter_readings mr
JOIN   supply_points  sp ON sp.id = mr.supply_point_id
JOIN   customers       c  ON c.id  = sp.customer_id
WHERE  mr.reading_date >= (CURRENT_DATE - INTERVAL '6 months')
GROUP BY sp.id, sp.mpan, c.name, sp.dno_region, date_trunc('month', mr.reading_date)
ORDER BY sp.id, reading_month;


-- ── Vulnerable customers at risk ──────────────────────────────────────────
CREATE OR REPLACE VIEW vulnerable_at_risk AS
SELECT
    dr.id                                                  AS request_id,
    c.name                                                 AS customer_name,
    sp.mpan,
    sp.postcode,
    sp.dno_region,
    sp.psr_flag,
    dr.bundle_code,
    dr.arrears_amount_gbp,
    dr.status,
    dsc.label                                              AS status_label,
    dr.sla_breached,
    get_sla_deadline(dr.id)                               AS sla_deadline,
    dr.created_at
FROM   disconnect_requests dr
JOIN   customers             c   ON c.id  = dr.customer_id
JOIN   supply_points         sp  ON sp.id = dr.supply_point_id
JOIN   disconnect_status_codes dsc ON dsc.code = dr.status
WHERE  (sp.is_vulnerable = TRUE OR sp.psr_flag = TRUE OR dr.is_vulnerable = TRUE)
  AND  NOT EXISTS (
           SELECT 1 FROM disconnect_status_codes t
           WHERE  t.code = dr.status AND t.is_terminal = TRUE
       )
ORDER BY dr.sla_breached DESC, dr.created_at ASC;


-- ── Open critical alerts ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW open_critical_alerts AS
SELECT
    al.id                                                  AS alert_id,
    al.alert_type,
    al.severity,
    al.disconnect_request_id,
    c.name                                                 AS customer_name,
    al.message,
    al.details,
    al.created_at,
    EXTRACT(EPOCH FROM (now() - al.created_at)) / 3600.0  AS age_hours
FROM   alerts al
LEFT JOIN disconnect_requests dr ON dr.id = al.disconnect_request_id
LEFT JOIN customers            c  ON c.id = dr.customer_id
WHERE  al.acknowledged = FALSE
  AND  al.severity IN ('critical', 'warning')
ORDER BY
    CASE al.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
    al.created_at ASC;
