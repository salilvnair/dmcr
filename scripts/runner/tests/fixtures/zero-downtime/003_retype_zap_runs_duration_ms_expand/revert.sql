DROP TRIGGER IF EXISTS dmcr_sync_duration_ms_big ON ${schema}.zap_runs;
DROP FUNCTION IF EXISTS ${schema}.dmcr_sync_zap_runs_duration_ms_big();
ALTER TABLE ${schema}.zap_runs DROP COLUMN IF EXISTS duration_ms_big;
