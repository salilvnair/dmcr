DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '020_idx_items_product_concurrently') THEN
    IF NOT (to_regclass('shop.idx_items_product') IS NOT NULL) THEN RAISE EXCEPTION '020_idx_items_product_concurrently: idx_items_product missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.idx_items_product') IS NULL) THEN RAISE EXCEPTION '020_idx_items_product_concurrently: idx_items_product still present after revert'; END IF;
  END IF;
END $$;
