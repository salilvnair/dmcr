ALTER TABLE ${schema}.zap_runs ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE ${schema}.zap_runs ADD CONSTRAINT zap_runs_started_at_not_null CHECK (started_at IS NOT NULL) NOT VALID;
