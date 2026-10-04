DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '003_create_orders') THEN
    IF NOT (to_regclass('shop.orders') IS NOT NULL) THEN RAISE EXCEPTION '003_create_orders: shop.orders missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.orders') IS NULL) THEN RAISE EXCEPTION '003_create_orders: shop.orders still present after revert'; END IF;
  END IF;
END $$;
