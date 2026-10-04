DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '015_partitioned_events') THEN
    IF NOT ((SELECT count(*) FROM shop.events) = 90000) THEN RAISE EXCEPTION '015_partitioned_events: 90k partitioned events missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.events') IS NULL) THEN RAISE EXCEPTION '015_partitioned_events: 90k partitioned events still present after revert'; END IF;
  END IF;
END $$;
