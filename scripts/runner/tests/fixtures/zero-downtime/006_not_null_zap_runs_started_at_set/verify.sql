DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '006_not_null_zap_runs_started_at_set') THEN
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zap_runs' AND column_name = 'started_at' AND is_nullable = 'NO') AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND c.conname = 'zap_runs_started_at_not_null')) THEN RAISE EXCEPTION 'started_at is not NOT NULL'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zap_runs' AND column_name = 'started_at' AND is_nullable = 'NO') AND EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND c.conname = 'zap_runs_started_at_not_null')) THEN RAISE EXCEPTION 'started_at is still NOT NULL after the revert'; END IF;
  END IF;
END $$;
