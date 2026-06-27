-- ============================================================
-- Zapper — Functions  (FIXED — public schema, no dynamic ALTER)
-- sla_breached / sla_breach_at are declared in 01_schema.sql.
-- check_sla_breaches() only UPDATEs — no ALTER TABLE.
-- All table/function refs use public schema (no zapper. prefix).
-- ============================================================

-- ── Helper: SLA deadline calculation ─────────────────────────────────────
CREATE OR REPLACE FUNCTION get_sla_deadline(
    p_request_id  VARCHAR(25),
    p_bundle_code VARCHAR(30) DEFAULT NULL
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_bundle_code  VARCHAR(30);
    v_sla_hours    INTEGER;
    v_created_at   TIMESTAMPTZ;
BEGIN
    SELECT dr.created_at, COALESCE(p_bundle_code, dr.bundle_code)
    INTO   v_created_at, v_bundle_code
    FROM   disconnect_requests dr
    WHERE  dr.id = p_request_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT b.sla_hours INTO v_sla_hours
    FROM   bundles b
    WHERE  b.code = v_bundle_code;

    -- Default 24h if bundle not found or has no SLA
    v_sla_hours := COALESCE(v_sla_hours, 24);

    RETURN v_created_at + (v_sla_hours || ' hours')::INTERVAL;
END;
$$;


-- ── Helper: Request summary (used by views) ───────────────────────────────
CREATE OR REPLACE FUNCTION get_request_summary(p_request_id VARCHAR(25))
RETURNS TABLE (
    request_id         VARCHAR(25),
    customer_name      VARCHAR(200),
    bundle_code        VARCHAR(30),
    sla_deadline       TIMESTAMPTZ,
    is_sla_breached    BOOLEAN,
    payment_count      BIGINT,
    total_failed_gbp   NUMERIC(12,2),
    last_payment_date  TIMESTAMPTZ,
    alert_count        BIGINT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        dr.id                                                 AS request_id,
        c.name                                                AS customer_name,
        dr.bundle_code                                        AS bundle_code,
        get_sla_deadline(dr.id)                              AS sla_deadline,
        dr.sla_breached                                       AS is_sla_breached,
        COUNT(DISTINCT pa.id)                                 AS payment_count,
        COALESCE(SUM(CASE WHEN pa.payment_status = 'failed' THEN pa.amount_gbp ELSE 0 END), 0)
                                                              AS total_failed_gbp,
        MAX(pa.attempt_date)                                  AS last_payment_date,
        COUNT(DISTINCT al.id)                                 AS alert_count
    FROM   disconnect_requests dr
    JOIN   customers           c  ON c.id = dr.customer_id
    LEFT JOIN payment_attempts pa ON pa.disconnect_request_id = dr.id
    LEFT JOIN alerts           al ON al.disconnect_request_id = dr.id
    WHERE  dr.id = p_request_id
    GROUP BY dr.id, c.name, dr.bundle_code, dr.sla_breached;
END;
$$;


-- ── SLA breach check job (run by pg_cron or manually) ─────────────────────
-- Columns sla_breached and sla_breach_at always exist (declared in 01_schema.sql).
-- This function only updates rows that have newly breached SLA.
CREATE OR REPLACE FUNCTION check_sla_breaches()
RETURNS TABLE (
    request_id      VARCHAR(25),
    customer_name   VARCHAR(200),
    bundle_code     VARCHAR(30),
    sla_deadline    TIMESTAMPTZ,
    breached_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- Mark newly-breached requests
    UPDATE disconnect_requests dr
    SET    sla_breached  = TRUE,
           sla_breach_at = now(),
           updated_at    = now()
    WHERE  dr.sla_breached = FALSE
      AND  dr.status NOT IN (
               SELECT code FROM disconnect_status_codes WHERE is_terminal = TRUE
           )
      AND  get_sla_deadline(dr.id) < now();

    -- Insert alerts for newly-breached requests
    INSERT INTO alerts (alert_type, severity, disconnect_request_id, message, details)
    SELECT
        'sla_breach'::TEXT,
        CASE WHEN b.code = 'ENT' THEN 'critical' ELSE 'warning' END,
        dr.id,
        'SLA breached: ' || dr.id || ' (' || c.name || ') exceeded ' || b.code || ' bundle ' || b.sla_hours || 'h SLA',
        jsonb_build_object(
            'bundle',      b.code,
            'sla_hours',   b.sla_hours,
            'breached_at', now(),
            'status',      dr.status
        )
    FROM   disconnect_requests dr
    JOIN   customers            c ON c.id = dr.customer_id
    JOIN   bundles              b ON b.code = dr.bundle_code
    WHERE  dr.sla_breached = TRUE
      AND  dr.sla_breach_at >= now() - INTERVAL '1 minute'
      AND  NOT EXISTS (
               SELECT 1 FROM alerts al
               WHERE  al.disconnect_request_id = dr.id
                 AND  al.alert_type = 'sla_breach'
                 AND  al.created_at >= now() - INTERVAL '2 minutes'
           );

    -- Return newly-breached requests for caller inspection
    RETURN QUERY
    SELECT
        dr.id,
        c.name,
        dr.bundle_code,
        get_sla_deadline(dr.id),
        dr.sla_breach_at
    FROM   disconnect_requests dr
    JOIN   customers c ON c.id = dr.customer_id
    WHERE  dr.sla_breached = TRUE
      AND  dr.sla_breach_at >= now() - INTERVAL '5 minutes'
    ORDER BY dr.sla_breach_at DESC;
END;
$$;


-- ── Status transition ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION transition_request_status(
    p_request_id  VARCHAR(25),
    p_new_status  INTEGER,
    p_changed_by  VARCHAR(100) DEFAULT 'system',
    p_reason      TEXT         DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_current_status  INTEGER;
    v_is_terminal     BOOLEAN;
BEGIN
    SELECT status INTO v_current_status
    FROM   disconnect_requests
    WHERE  id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request % not found', p_request_id;
    END IF;

    SELECT is_terminal INTO v_is_terminal
    FROM   disconnect_status_codes
    WHERE  code = v_current_status;

    IF v_is_terminal THEN
        RAISE EXCEPTION 'Request % is already in terminal status %', p_request_id, v_current_status;
    END IF;

    UPDATE disconnect_requests
    SET    status     = p_new_status,
           updated_at = now()
    WHERE  id = p_request_id;

    INSERT INTO disconnect_request_logs (
        request_id, from_status, to_status, changed_by, reason
    ) VALUES (
        p_request_id, v_current_status, p_new_status, p_changed_by, p_reason
    );
END;
$$;


-- ── Bulk status report ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_status_report()
RETURNS TABLE (
    status_code      INTEGER,
    status_label     VARCHAR(50),
    request_count    BIGINT,
    breached_count   BIGINT,
    total_arrears    NUMERIC(12,2),
    oldest_request   TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        dsc.code,
        dsc.label,
        COUNT(dr.id)                                            AS request_count,
        COUNT(dr.id) FILTER (WHERE dr.sla_breached = TRUE)     AS breached_count,
        COALESCE(SUM(dr.arrears_amount_gbp), 0)                AS total_arrears,
        MIN(dr.created_at)                                      AS oldest_request
    FROM   disconnect_status_codes dsc
    LEFT JOIN disconnect_requests  dr  ON dr.status = dsc.code
    GROUP BY dsc.code, dsc.label
    ORDER BY dsc.code;
END;
$$;


-- ── Meter usage trend for a supply point ─────────────────────────────────
CREATE OR REPLACE FUNCTION get_usage_trend(
    p_supply_point_id VARCHAR(20),
    p_months          INTEGER DEFAULT 6
)
RETURNS TABLE (
    reading_month   DATE,
    avg_kwh         NUMERIC(12,3),
    reading_count   BIGINT,
    reading_types   TEXT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        date_trunc('month', reading_date)::DATE  AS reading_month,
        AVG(reading_kwh)::NUMERIC(12,3)          AS avg_kwh,
        COUNT(*)                                  AS reading_count,
        string_agg(DISTINCT reading_type, ', ')  AS reading_types
    FROM   meter_readings
    WHERE  supply_point_id = p_supply_point_id
      AND  reading_date >= (CURRENT_DATE - (p_months || ' months')::INTERVAL)::DATE
    GROUP BY date_trunc('month', reading_date)
    ORDER BY reading_month;
END;
$$;
