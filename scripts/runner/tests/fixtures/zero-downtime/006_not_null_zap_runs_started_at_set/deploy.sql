-- NOT NULL without the long lock, step 2: VALIDATE scans without blocking writes; SET NOT NULL then uses the valid check (PostgreSQL 12+).
ALTER TABLE ${schema}.zap_runs VALIDATE CONSTRAINT zap_runs_started_at_not_null;
ALTER TABLE ${schema}.zap_runs ALTER COLUMN started_at SET NOT NULL;
ALTER TABLE ${schema}.zap_runs DROP CONSTRAINT zap_runs_started_at_not_null;
