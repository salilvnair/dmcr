DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '005_not_null_zap_runs_started_at_check') THEN
    IF NOT (EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND c.conname = 'zap_runs_started_at_not_null')) THEN RAISE EXCEPTION 'zap_runs_started_at_not_null is missing'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND c.conname = 'zap_runs_started_at_not_null')) THEN RAISE EXCEPTION 'zap_runs_started_at_not_null is still there after the revert'; END IF;
  END IF;
END $$;
