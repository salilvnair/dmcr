DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '013_order_totals_with_trigger') THEN
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders' AND column_name = 'total') AND NOT EXISTS (SELECT 1 FROM shop.orders WHERE total = 0)) THEN RAISE EXCEPTION '013_order_totals_with_trigger: orders.total + triggers missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders' AND column_name = 'total')) THEN RAISE EXCEPTION '013_order_totals_with_trigger: orders.total + triggers still present after revert'; END IF;
  END IF;
END $$;
