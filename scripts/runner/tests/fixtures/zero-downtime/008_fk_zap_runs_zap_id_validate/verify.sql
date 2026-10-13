DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '008_fk_zap_runs_zap_id_validate') THEN
    IF NOT (EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND c.conname = 'zap_runs_zap_id_fkey' AND c.convalidated = true)) THEN RAISE EXCEPTION 'zap_runs_zap_id_fkey is not validated'; END IF;
  ELSE
    IF NOT (EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zap_runs' AND c.conname = 'zap_runs_zap_id_fkey' AND c.convalidated = false)) THEN RAISE EXCEPTION 'zap_runs_zap_id_fkey should be NOT VALID again after the revert'; END IF;
  END IF;
END $$;
