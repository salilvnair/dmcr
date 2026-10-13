-- A validated constraint cannot be marked NOT VALID again: drop it and add it back NOT VALID
ALTER TABLE ${schema}.zap_runs DROP CONSTRAINT IF EXISTS zap_runs_zap_id_fkey;
ALTER TABLE ${schema}.zap_runs ADD CONSTRAINT zap_runs_zap_id_fkey FOREIGN KEY (zap_id) REFERENCES ${schema}.zaps (id) NOT VALID;
