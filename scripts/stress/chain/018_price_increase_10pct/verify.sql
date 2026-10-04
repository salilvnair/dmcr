DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '018_price_increase_10pct') THEN
    IF NOT (to_regclass('shop._bak_018_prices') IS NOT NULL) THEN RAISE EXCEPTION '018_price_increase_10pct: price backup missing after deploy'; END IF;
  ELSE
    IF NOT (to_regclass('shop._bak_018_prices') IS NULL) THEN RAISE EXCEPTION '018_price_increase_10pct: price backup still present after revert'; END IF;
  END IF;
END $$;
