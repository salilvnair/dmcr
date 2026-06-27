-- ============================================================
-- Zapper — PostgreSQL Schema  (FIXED — public schema only)
-- UK Electricity Disconnect Management Platform
-- Run: psql -U zapper_st -d zapper_st -f 01_schema.sql
--      psql -U zapper_prod -d zapper_prod -f 01_schema.sql
-- All tables in public schema. No zapper. prefix.
-- sla_breached / sla_breach_at added here (not dynamically).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Bundles (service tiers) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bundles (
    id                  SERIAL PRIMARY KEY,
    code                VARCHAR(30) UNIQUE NOT NULL,
    name                VARCHAR(100) NOT NULL,
    description         TEXT,
    max_disconnect_days INTEGER NOT NULL DEFAULT 7,
    min_disconnect_days INTEGER NOT NULL DEFAULT 0,
    sla_hours           INTEGER NOT NULL DEFAULT 24,
    created_at          TIMESTAMPTZ DEFAULT now()
);

-- ── Customers (electricity suppliers / Zapper clients) ───────────────────
CREATE TABLE IF NOT EXISTS customers (
    id             SERIAL PRIMARY KEY,
    account_number VARCHAR(20)  UNIQUE NOT NULL,
    name           VARCHAR(200) NOT NULL,
    email          VARCHAR(200),
    phone          VARCHAR(30),
    bundle_id      INTEGER REFERENCES bundles(id),
    bundle_code    VARCHAR(30),
    company_reg    VARCHAR(30),
    ofgem_licence  VARCHAR(50),
    status         VARCHAR(30) DEFAULT 'active',
    created_at     TIMESTAMPTZ DEFAULT now(),
    updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ── Supply points (MPANs managed for customers) ───────────────────────────
CREATE TABLE IF NOT EXISTS supply_points (
    id              VARCHAR(20) PRIMARY KEY,
    mpan            VARCHAR(13) UNIQUE NOT NULL,
    customer_id     INTEGER REFERENCES customers(id),
    address_line1   VARCHAR(200),
    address_line2   VARCHAR(200),
    town            VARCHAR(100),
    county          VARCHAR(100),
    postcode        VARCHAR(10),
    property_type   VARCHAR(30) DEFAULT 'residential',
    meter_type      VARCHAR(30) DEFAULT 'smart',
    supplier_code   VARCHAR(10),
    dno_region      VARCHAR(50),
    is_vulnerable   BOOLEAN DEFAULT FALSE,
    psr_flag        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Disconnect status codes ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disconnect_status_codes (
    code             INTEGER PRIMARY KEY,
    label            VARCHAR(50) NOT NULL,
    description      TEXT,
    system_owner     VARCHAR(50),
    is_terminal      BOOLEAN DEFAULT FALSE,
    next_statuses    INTEGER[],
    sla_hours        INTEGER,
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── Disconnect requests ───────────────────────────────────────────────────
-- sla_breached and sla_breach_at are defined here (not added dynamically).
-- check_sla_breaches() in 09_functions.sql updates these columns.
CREATE TABLE IF NOT EXISTS disconnect_requests (
    id                  VARCHAR(25) PRIMARY KEY,
    customer_id         INTEGER REFERENCES customers(id),
    account_number      VARCHAR(20),
    supply_point_id     VARCHAR(20) REFERENCES supply_points(id),
    bundle_id           INTEGER REFERENCES bundles(id),
    bundle_code         VARCHAR(30),
    status              INTEGER REFERENCES disconnect_status_codes(code),
    disconnect_date     DATE,
    reference_code      VARCHAR(30),
    prsu_ref            VARCHAR(50),
    moig_order_number   VARCHAR(50),
    fde_job_id          VARCHAR(50),
    arrears_amount_gbp  NUMERIC(10,2),
    reason_code         VARCHAR(30) DEFAULT 'non_payment',
    is_vulnerable       BOOLEAN DEFAULT FALSE,
    sla_breached        BOOLEAN NOT NULL DEFAULT FALSE,
    sla_breach_at       TIMESTAMPTZ,
    notes               TEXT,
    retry_count         INTEGER DEFAULT 0,
    error_code          VARCHAR(30),
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- ── Disconnect request logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disconnect_request_logs (
    id              SERIAL PRIMARY KEY,
    request_id      VARCHAR(25) REFERENCES disconnect_requests(id),
    from_status     INTEGER,
    to_status       INTEGER NOT NULL,
    changed_by      VARCHAR(100) DEFAULT 'system',
    system_source   VARCHAR(50),
    reason          TEXT,
    metadata        JSONB,
    changed_at      TIMESTAMPTZ DEFAULT now()
);

-- ── External system messages ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_system_messages (
    id              SERIAL PRIMARY KEY,
    request_id      VARCHAR(25) REFERENCES disconnect_requests(id),
    system_name     VARCHAR(30) NOT NULL,
    direction       VARCHAR(10) NOT NULL,
    message_type    VARCHAR(50),
    payload         JSONB,
    response_code   VARCHAR(20),
    response_body   JSONB,
    sent_at         TIMESTAMPTZ DEFAULT now(),
    received_at     TIMESTAMPTZ,
    timeout_at      TIMESTAMPTZ,
    is_timeout      BOOLEAN DEFAULT FALSE,
    retry_number    INTEGER DEFAULT 0
);

-- ── Field engineers ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_engineers (
    id              VARCHAR(20) PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    employee_number VARCHAR(20),
    dno_region      VARCHAR(50),
    status          VARCHAR(20) DEFAULT 'available',
    skills          TEXT[],
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Field jobs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_jobs (
    id              VARCHAR(20) PRIMARY KEY,
    request_id      VARCHAR(25) REFERENCES disconnect_requests(id),
    engineer_id     VARCHAR(20) REFERENCES field_engineers(id),
    job_type        VARCHAR(30),
    scheduled_date  DATE,
    time_slot       VARCHAR(20),
    completed_at    TIMESTAMPTZ,
    outcome         VARCHAR(50),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Validation failures ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS validation_failures (
    id              SERIAL PRIMARY KEY,
    request_id      VARCHAR(25) REFERENCES disconnect_requests(id),
    rule_code       VARCHAR(50),
    rule_description TEXT,
    field_name      VARCHAR(100),
    field_value     TEXT,
    failed_at       TIMESTAMPTZ DEFAULT now()
);

-- ── Ofgem compliance checks ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ofgem_compliance_checks (
    id              SERIAL PRIMARY KEY,
    request_id      VARCHAR(25) REFERENCES disconnect_requests(id),
    check_type      VARCHAR(50),
    passed          BOOLEAN,
    reason          TEXT,
    checked_at      TIMESTAMPTZ DEFAULT now(),
    checked_by      VARCHAR(50) DEFAULT 'auto'
);

-- ── API request logs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_request_logs (
    id              SERIAL PRIMARY KEY,
    endpoint        VARCHAR(200) NOT NULL,
    method          VARCHAR(10)  NOT NULL,
    request_id      VARCHAR(50),
    correlation_id  VARCHAR(50),
    customer_id     INTEGER,
    disconnect_req_id VARCHAR(25),
    status_code     INTEGER,
    response_time_ms INTEGER,
    request_body    JSONB,
    response_body   JSONB,
    error_code      VARCHAR(50),
    error_message   TEXT,
    user_agent      VARCHAR(200),
    ip_address      VARCHAR(45),
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Meter readings (public schema — no zapper. prefix) ───────────────────
CREATE TABLE IF NOT EXISTS meter_readings (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    supply_point_id VARCHAR(20)   NOT NULL REFERENCES supply_points(id),
    reading_date    DATE          NOT NULL,
    reading_kwh     NUMERIC(12,3) NOT NULL,
    reading_type    TEXT          NOT NULL CHECK (reading_type IN ('actual', 'estimated', 'customer')),
    submitted_by    TEXT,
    created_at      TIMESTAMPTZ   DEFAULT now()
);

-- ── Payment attempts (public schema) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_attempts (
    id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    disconnect_request_id VARCHAR(25)   NOT NULL REFERENCES disconnect_requests(id),
    attempt_date          TIMESTAMPTZ   NOT NULL,
    amount_gbp            NUMERIC(10,2) NOT NULL,
    payment_method        TEXT          NOT NULL CHECK (payment_method IN ('direct_debit','bank_transfer','card','cash','cheque')),
    payment_status        TEXT          NOT NULL CHECK (payment_status IN ('pending','cleared','failed','refunded')),
    reference             TEXT,
    failure_reason        TEXT,
    created_at            TIMESTAMPTZ   DEFAULT now()
);

-- ── Alerts (public schema) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type            TEXT        NOT NULL CHECK (alert_type IN (
                              'sla_breach','validation_failed','ratsni_timeout',
                              'dno_rejected','engineer_unavailable','bulk_threshold')),
    severity              TEXT        NOT NULL CHECK (severity IN ('info','warning','critical')),
    disconnect_request_id VARCHAR(25) REFERENCES disconnect_requests(id),
    message               TEXT        NOT NULL,
    details               JSONB,
    acknowledged          BOOLEAN     NOT NULL DEFAULT FALSE,
    acknowledged_by       TEXT,
    acknowledged_at       TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_disc_req_status       ON disconnect_requests(status);
CREATE INDEX IF NOT EXISTS idx_disc_req_customer     ON disconnect_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_disc_req_date         ON disconnect_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_disc_req_sla_breached ON disconnect_requests(sla_breached) WHERE sla_breached = TRUE;
CREATE INDEX IF NOT EXISTS idx_disc_logs_request     ON disconnect_request_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_disc_logs_status      ON disconnect_request_logs(to_status);
CREATE INDEX IF NOT EXISTS idx_api_logs_status       ON api_request_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_api_logs_endpoint     ON api_request_logs(endpoint);
CREATE INDEX IF NOT EXISTS idx_api_logs_created      ON api_request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_logs_disc_req     ON api_request_logs(disconnect_req_id);
CREATE INDEX IF NOT EXISTS idx_supply_points_mpan    ON supply_points(mpan);
CREATE INDEX IF NOT EXISTS idx_supply_points_cust    ON supply_points(customer_id);
CREATE INDEX IF NOT EXISTS idx_mr_supply_point       ON meter_readings(supply_point_id);
CREATE INDEX IF NOT EXISTS idx_mr_reading_date       ON meter_readings(reading_date);
CREATE INDEX IF NOT EXISTS idx_pa_disconnect_req     ON payment_attempts(disconnect_request_id);
CREATE INDEX IF NOT EXISTS idx_pa_attempt_date       ON payment_attempts(attempt_date);
CREATE INDEX IF NOT EXISTS idx_pa_status             ON payment_attempts(payment_status);
CREATE INDEX IF NOT EXISTS idx_alerts_type           ON alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_severity       ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_acked          ON alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_alerts_disc_req       ON alerts(disconnect_request_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created        ON alerts(created_at);
