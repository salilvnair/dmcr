DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '003_retype_zap_runs_duration_ms_expand') THEN
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zap_runs' AND column_name = 'duration_ms_big') AND EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND g.tgname = 'dmcr_sync_duration_ms_big' AND NOT g.tgisinternal)) THEN RAISE EXCEPTION 'duration_ms_big or its sync trigger is missing'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zap_runs' AND column_name = 'duration_ms_big')) THEN RAISE EXCEPTION 'duration_ms_big is still there after the revert'; END IF;
  END IF;
END $$;
