DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '004_create_order_items') THEN
    IF NOT (to_regclass('shop.order_items') IS NOT NULL) THEN RAISE EXCEPTION '004_create_order_items: shop.order_items missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.order_items') IS NULL) THEN RAISE EXCEPTION '004_create_order_items: shop.order_items still present after revert'; END IF;
  END IF;
END $$;
