DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '004_danger_retype_zap_runs_duration_ms_contract') THEN
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zap_runs' AND column_name = 'duration_ms') AND NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND g.tgname = 'dmcr_sync_duration_ms_big' AND NOT g.tgisinternal)) THEN RAISE EXCEPTION 'duration_ms or the sync trigger is still there'; END IF;
  ELSE
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zap_runs' AND column_name = 'duration_ms') AND EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND g.tgname = 'dmcr_sync_duration_ms_big' AND NOT g.tgisinternal)) THEN RAISE EXCEPTION 'duration_ms or its sync trigger is missing after the revert'; END IF;
  END IF;
END $$;
