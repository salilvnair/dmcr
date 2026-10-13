-- Foreign key without the long lock, step 1: NOT VALID is instant; new and updated rows are checked from now on.
ALTER TABLE ${schema}.zap_runs ADD CONSTRAINT zap_runs_zap_id_fkey FOREIGN KEY (zap_id) REFERENCES ${schema}.zaps (id) NOT VALID;
