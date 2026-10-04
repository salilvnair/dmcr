DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '002_create_products') THEN
    IF NOT (to_regclass('shop.products') IS NOT NULL) THEN RAISE EXCEPTION '002_create_products: shop.products missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.products') IS NULL) THEN RAISE EXCEPTION '002_create_products: shop.products still present after revert'; END IF;
  END IF;
END $$;
