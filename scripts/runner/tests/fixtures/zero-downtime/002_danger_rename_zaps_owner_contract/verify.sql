DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '002_danger_rename_zaps_owner_contract') THEN
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zaps' AND column_name = 'owner') AND NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zaps' AND g.tgname = 'dmcr_sync_owner_name' AND NOT g.tgisinternal)) THEN RAISE EXCEPTION 'owner or the sync trigger is still there'; END IF;
  ELSE
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zaps' AND column_name = 'owner') AND EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zaps' AND g.tgname = 'dmcr_sync_owner_name' AND NOT g.tgisinternal)) THEN RAISE EXCEPTION 'owner or its sync trigger is missing after the revert'; END IF;
  END IF;
END $$;
