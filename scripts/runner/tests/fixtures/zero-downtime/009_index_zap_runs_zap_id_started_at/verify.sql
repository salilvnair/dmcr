DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '009_index_zap_runs_zap_id_started_at') THEN
    IF NOT (EXISTS (SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_namespace n ON n.oid = x.relnamespace WHERE n.nspname = '${schema}' AND x.relname = 'zap_runs_zap_id_started_at_idx' AND i.indisvalid)) THEN RAISE EXCEPTION 'zap_runs_zap_id_started_at_idx is missing or INVALID (a failed CONCURRENTLY build: drop it and deploy again)'; END IF;
  ELSE
    IF NOT (to_regclass('${schema}.zap_runs_zap_id_started_at_idx') IS NULL) THEN RAISE EXCEPTION 'zap_runs_zap_id_started_at_idx is still there after the revert'; END IF;
  END IF;
END $$;
