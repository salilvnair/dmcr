ALTER TABLE ${schema}.zaps ADD COLUMN IF NOT EXISTS owner varchar(100);
UPDATE ${schema}.zaps SET owner = owner_name;
ALTER TABLE ${schema}.zaps ALTER COLUMN owner SET NOT NULL;
CREATE OR REPLACE FUNCTION ${schema}.dmcr_sync_zaps_owner_name() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- both columns stay in sync while old and new application versions run side by side
  IF TG_OP = 'INSERT' THEN
    IF NEW.owner_name IS NULL AND NEW.owner IS NOT NULL THEN NEW.owner_name := NEW.owner;
    ELSIF NEW.owner IS NULL AND NEW.owner_name IS NOT NULL THEN NEW.owner := NEW.owner_name;
    END IF;
  ELSIF NEW.owner_name IS DISTINCT FROM OLD.owner_name THEN
    NEW.owner := NEW.owner_name;
  ELSIF NEW.owner IS DISTINCT FROM OLD.owner THEN
    NEW.owner_name := NEW.owner;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER dmcr_sync_owner_name BEFORE INSERT OR UPDATE ON ${schema}.zaps FOR EACH ROW EXECUTE FUNCTION ${schema}.dmcr_sync_zaps_owner_name();
