DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '019_reprice_order_items') THEN
    IF NOT (to_regclass('shop._bak_019_unit_prices') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shop.order_items WHERE unit_price = 9.99 AND product_id IN (SELECT id FROM shop.products WHERE price <> 9.99))) THEN RAISE EXCEPTION '019_reprice_order_items: repriced items missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop._bak_019_unit_prices') IS NULL) THEN RAISE EXCEPTION '019_reprice_order_items: repriced items still present after revert'; END IF;
  END IF;
END $$;
