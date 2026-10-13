-- Contract (zero downtime): rename ${schema}.zaps.owner to owner_name. Only after every running application version uses owner_name.
-- Views on owner would block the drop: name them, so they are moved to owner_name first (in their own change).
DO $$ DECLARE v text; BEGIN
  SELECT string_agg(DISTINCT r.ev_class::regclass::text, ', ') INTO v
    FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refobjid = '${schema}.zaps'::regclass AND a.attname = 'owner' AND r.ev_class <> d.refobjid;
  IF v IS NOT NULL THEN RAISE EXCEPTION 'DMCR: views still use ${schema}.zaps.owner: %. Recreate them on owner_name first.', v; END IF;
END $$;
DROP TRIGGER IF EXISTS dmcr_sync_owner_name ON ${schema}.zaps;
DROP FUNCTION IF EXISTS ${schema}.dmcr_sync_zaps_owner_name();
ALTER TABLE ${schema}.zaps DROP COLUMN IF EXISTS owner;
