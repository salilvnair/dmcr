-- Expand (zero downtime): rename ${schema}.zaps.owner to owner_name. Old and new application versions both work after this.
-- Copy what owner has to owner_name here if it needs it: NOT NULL (see the not-null template), default, indexes, constraints.
ALTER TABLE ${schema}.zaps ADD COLUMN IF NOT EXISTS owner_name varchar(100);
-- backfill before the sync trigger, with the table's own triggers off (an updated_at trigger must not
-- see a schema migration as an edit). This transaction holds the table lock, so no write slips in between.
-- On a large table backfill in batches (WHERE id BETWEEN ...) in changes before this one.
ALTER TABLE ${schema}.zaps DISABLE TRIGGER USER;
UPDATE ${schema}.zaps SET owner_name = owner WHERE owner_name IS NULL AND owner IS NOT NULL;
ALTER TABLE ${schema}.zaps ENABLE TRIGGER USER;
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
