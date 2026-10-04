DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '021_danger_drop_legacy_events') THEN
    IF NOT (to_regclass('shop.events_2026_01') IS NULL) THEN RAISE EXCEPTION '021_danger_drop_legacy_events: legacy partition drop missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.events_2026_01') IS NOT NULL) THEN RAISE EXCEPTION '021_danger_drop_legacy_events: legacy partition drop still present after revert'; END IF;
  END IF;
END $$;
