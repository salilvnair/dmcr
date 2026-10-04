DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '001_create_shop_customers') THEN
    IF NOT (to_regclass('shop.customers') IS NOT NULL) THEN RAISE EXCEPTION '001_create_shop_customers: shop.customers missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.customers') IS NULL) THEN RAISE EXCEPTION '001_create_shop_customers: shop.customers still present after revert'; END IF;
  END IF;
END $$;
