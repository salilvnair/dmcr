DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '017_move_address_to_table') THEN
    IF NOT (to_regclass('shop.addresses') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customers' AND column_name = 'address')) THEN RAISE EXCEPTION '017_move_address_to_table: addresses table missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.addresses') IS NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customers' AND column_name = 'address')) THEN RAISE EXCEPTION '017_move_address_to_table: addresses table still present after revert'; END IF;
  END IF;
END $$;
