DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '022_add_order_note') THEN
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders' AND column_name = 'note')) THEN RAISE EXCEPTION '022_add_order_note: orders.note missing after deploy'; END IF;
  ELSE
    IF NOT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders' AND column_name = 'note')) THEN RAISE EXCEPTION '022_add_order_note: orders.note still present after revert'; END IF;
  END IF;
END $$;
