-- Contract (zero downtime): change ${schema}.zap_runs.duration_ms to bigint as duration_ms_big. Only after every running application version uses duration_ms_big.
-- Views on duration_ms would block the drop: name them, so they are moved to duration_ms_big first (in their own change).
DO $$ DECLARE v text; BEGIN
  SELECT string_agg(DISTINCT r.ev_class::regclass::text, ', ') INTO v
    FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refobjid = '${schema}.zap_runs'::regclass AND a.attname = 'duration_ms' AND r.ev_class <> d.refobjid;
  IF v IS NOT NULL THEN RAISE EXCEPTION 'DMCR: views still use ${schema}.zap_runs.duration_ms: %. Recreate them on duration_ms_big first.', v; END IF;
END $$;
DROP TRIGGER IF EXISTS dmcr_sync_duration_ms_big ON ${schema}.zap_runs;
DROP FUNCTION IF EXISTS ${schema}.dmcr_sync_zap_runs_duration_ms_big();
ALTER TABLE ${schema}.zap_runs DROP COLUMN IF EXISTS duration_ms;
