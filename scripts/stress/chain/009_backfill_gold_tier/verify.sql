DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '009_backfill_gold_tier') THEN
    IF NOT (EXISTS (SELECT 1 FROM shop.customers WHERE tier = 'gold')) THEN RAISE EXCEPTION '009_backfill_gold_tier: gold customers missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customers' AND column_name = 'tier') OR NOT EXISTS (SELECT 1 FROM shop.customers WHERE tier = 'gold')) THEN RAISE EXCEPTION '009_backfill_gold_tier: gold customers still present after revert'; END IF;
  END IF;
END $$;
