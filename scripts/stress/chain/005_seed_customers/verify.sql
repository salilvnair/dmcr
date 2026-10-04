DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '005_seed_customers') THEN
    IF NOT ((SELECT count(*) FROM shop.customers WHERE email LIKE 'c%@shop.test') = 50000) THEN RAISE EXCEPTION '005_seed_customers: 50k seeded customers missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM shop.customers WHERE email LIKE 'c%@shop.test')) THEN RAISE EXCEPTION '005_seed_customers: 50k seeded customers still present after revert'; END IF;
  END IF;
END $$;
