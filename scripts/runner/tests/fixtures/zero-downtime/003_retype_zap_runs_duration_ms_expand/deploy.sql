-- Expand (zero downtime): change ${schema}.zap_runs.duration_ms to bigint as duration_ms_big. Old and new application versions both work after this.
-- Copy what duration_ms has to duration_ms_big here if it needs it: NOT NULL (see the not-null template), default, indexes, constraints.
ALTER TABLE ${schema}.zap_runs ADD COLUMN IF NOT EXISTS duration_ms_big bigint;
-- backfill before the sync trigger, with the table's own triggers off (an updated_at trigger must not
-- see a schema migration as an edit). This transaction holds the table lock, so no write slips in between.
-- On a large table backfill in batches (WHERE id BETWEEN ...) in changes before this one.
ALTER TABLE ${schema}.zap_runs DISABLE TRIGGER USER;
UPDATE ${schema}.zap_runs SET duration_ms_big = duration_ms::bigint WHERE duration_ms_big IS NULL AND duration_ms IS NOT NULL;
ALTER TABLE ${schema}.zap_runs ENABLE TRIGGER USER;
CREATE OR REPLACE FUNCTION ${schema}.dmcr_sync_zap_runs_duration_ms_big() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- both columns stay in sync while old and new application versions run side by side
  IF TG_OP = 'INSERT' THEN
    IF NEW.duration_ms_big IS NULL AND NEW.duration_ms IS NOT NULL THEN NEW.duration_ms_big := NEW.duration_ms::bigint;
    ELSIF NEW.duration_ms IS NULL AND NEW.duration_ms_big IS NOT NULL THEN NEW.duration_ms := NEW.duration_ms_big::integer;
    END IF;
  ELSIF NEW.duration_ms_big IS DISTINCT FROM OLD.duration_ms_big THEN
    NEW.duration_ms := NEW.duration_ms_big::integer;
  ELSIF NEW.duration_ms IS DISTINCT FROM OLD.duration_ms THEN
    NEW.duration_ms_big := NEW.duration_ms::bigint;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER dmcr_sync_duration_ms_big BEFORE INSERT OR UPDATE ON ${schema}.zap_runs FOR EACH ROW EXECUTE FUNCTION ${schema}.dmcr_sync_zap_runs_duration_ms_big();
