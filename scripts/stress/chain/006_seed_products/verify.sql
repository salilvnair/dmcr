DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '006_seed_products') THEN
    IF NOT ((SELECT count(*) FROM shop.products) = 5000) THEN RAISE EXCEPTION '006_seed_products: 5k seeded products missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM shop.products WHERE sku LIKE 'SKU-%')) THEN RAISE EXCEPTION '006_seed_products: 5k seeded products still present after revert'; END IF;
  END IF;
END $$;
