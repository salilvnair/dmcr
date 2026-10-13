DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '001_rename_zaps_owner_expand') THEN
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zaps' AND column_name = 'owner_name') AND EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class r ON r.oid = g.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = '${schema}' AND r.relname = 'zaps' AND g.tgname = 'dmcr_sync_owner_name' AND NOT g.tgisinternal)) THEN RAISE EXCEPTION 'owner_name or its sync trigger is missing'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'zaps' AND column_name = 'owner_name')) THEN RAISE EXCEPTION 'owner_name is still there after the revert'; END IF;
  END IF;
END $$;
