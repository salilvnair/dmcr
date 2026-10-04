DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '008_add_customer_tier') THEN
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customers' AND column_name = 'tier')) THEN RAISE EXCEPTION '008_add_customer_tier: customers.tier missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customers' AND column_name = 'tier') AND to_regtype('shop.tier') IS NULL) THEN RAISE EXCEPTION '008_add_customer_tier: customers.tier still present after revert'; END IF;
  END IF;
END $$;
