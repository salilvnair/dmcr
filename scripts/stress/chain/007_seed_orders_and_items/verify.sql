DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '007_seed_orders_and_items') THEN
    IF NOT ((SELECT count(*) FROM shop.order_items) = 600000 AND (SELECT count(*) FROM shop.orders) = 200000) THEN RAISE EXCEPTION '007_seed_orders_and_items: 200k orders / 600k items missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM shop.orders)) THEN RAISE EXCEPTION '007_seed_orders_and_items: 200k orders / 600k items still present after revert'; END IF;
  END IF;
END $$;
