-- NOT NULL without the long lock, step 1: a NOT VALID check is instant and holds for every new or updated row.
ALTER TABLE ${schema}.zap_runs ADD CONSTRAINT zap_runs_started_at_not_null CHECK (started_at IS NOT NULL) NOT VALID;
