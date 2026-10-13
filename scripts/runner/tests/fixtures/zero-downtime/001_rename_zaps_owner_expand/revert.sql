DROP TRIGGER IF EXISTS dmcr_sync_owner_name ON ${schema}.zaps;
DROP FUNCTION IF EXISTS ${schema}.dmcr_sync_zaps_owner_name();
ALTER TABLE ${schema}.zaps DROP COLUMN IF EXISTS owner_name;
