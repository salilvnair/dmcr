DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '012_view_top_customers') THEN
    IF NOT (to_regclass('shop.top_customers') IS NOT NULL) THEN RAISE EXCEPTION '012_view_top_customers: top_customers view missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.top_customers') IS NULL) THEN RAISE EXCEPTION '012_view_top_customers: top_customers view still present after revert'; END IF;
  END IF;
END $$;
