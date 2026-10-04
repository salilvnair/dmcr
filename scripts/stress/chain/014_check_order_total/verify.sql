DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '014_check_order_total') THEN
    IF NOT (EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_orders_total_nonneg' AND convalidated)) THEN RAISE EXCEPTION '014_check_order_total: validated check constraint missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_orders_total_nonneg')) THEN RAISE EXCEPTION '014_check_order_total: validated check constraint still present after revert'; END IF;
  END IF;
END $$;
