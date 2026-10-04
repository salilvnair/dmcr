DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '016_rename_product_name_to_title') THEN
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'products' AND column_name = 'title')) THEN RAISE EXCEPTION '016_rename_product_name_to_title: products.title missing after deploy'; END IF;
  ELSE
    IF NOT (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'products' AND column_name = 'name')) THEN RAISE EXCEPTION '016_rename_product_name_to_title: products.title still present after revert'; END IF;
  END IF;
END $$;
