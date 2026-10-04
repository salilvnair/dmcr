DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '010_idx_orders_customer') THEN
    IF NOT (to_regclass('shop.idx_orders_customer') IS NOT NULL) THEN RAISE EXCEPTION '010_idx_orders_customer: idx_orders_customer missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.idx_orders_customer') IS NULL) THEN RAISE EXCEPTION '010_idx_orders_customer: idx_orders_customer still present after revert'; END IF;
  END IF;
END $$;
