DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '011_view_customer_totals') THEN
    IF NOT (to_regclass('shop.customer_totals') IS NOT NULL) THEN RAISE EXCEPTION '011_view_customer_totals: customer_totals view missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop.customer_totals') IS NULL) THEN RAISE EXCEPTION '011_view_customer_totals: customer_totals view still present after revert'; END IF;
  END IF;
END $$;
