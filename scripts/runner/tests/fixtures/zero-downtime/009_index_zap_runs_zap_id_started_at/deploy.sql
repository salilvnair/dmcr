-- Built CONCURRENTLY: reads and writes go on while it builds. Runs outside a transaction ("transaction": false).
CREATE INDEX CONCURRENTLY IF NOT EXISTS zap_runs_zap_id_started_at_idx ON ${schema}.zap_runs (zap_id, started_at);
