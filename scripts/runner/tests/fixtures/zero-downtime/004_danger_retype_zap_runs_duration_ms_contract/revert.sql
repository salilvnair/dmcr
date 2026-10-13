ALTER TABLE ${schema}.zap_runs ADD COLUMN IF NOT EXISTS duration_ms integer;
UPDATE ${schema}.zap_runs SET duration_ms = duration_ms_big::integer;
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
