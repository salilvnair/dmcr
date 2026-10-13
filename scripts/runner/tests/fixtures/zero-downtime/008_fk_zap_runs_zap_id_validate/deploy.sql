-- Foreign key without the long lock, step 2: VALIDATE scans existing rows without blocking writes.
ALTER TABLE ${schema}.zap_runs VALIDATE CONSTRAINT zap_runs_zap_id_fkey;
