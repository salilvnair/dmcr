-- DMCR round-trip test helpers (used by `dmcr test`).
--
-- Loaded at the start of the test transaction. Everything here is temporary
-- (pg_temp) and the whole test ends in ROLLBACK, so nothing is left in the database.
--
-- For each pending change the runner does, inside one transaction:
--   dmcr_rt_start(id)
--   SAVEPOINT probe; deploy.sql; revert.sql; ROLLBACK TO probe  -- find the tables both touch
--   dmcr_rt_before(id)                                       -- schema + data of those tables
--   deploy.sql; registry row; verify.sql                     -- must pass (applied state)
--   revert.sql; delete registry row; verify.sql              -- must pass (reverted state)
--   dmcr_rt_after(id)                                        -- schema + data must match before
--   deploy.sql; registry row                                 -- leave applied for the next change
-- Results are reported as NOTICEs: DMCR_RT|<id>|start|pass|fail|note|<detail>

-- Tables bigger than this (estimated rows) are compared by schema only.
CREATE TEMP TABLE dmcr_rt_conf (max_rows real) ON COMMIT DROP;
INSERT INTO dmcr_rt_conf VALUES (2000000);

CREATE TEMP TABLE dmcr_rt_base (relid oid PRIMARY KEY, n bigint) ON COMMIT DROP;
CREATE TEMP TABLE dmcr_rt_schema_before (item text) ON COMMIT DROP;
CREATE TEMP TABLE dmcr_rt_data_before (tbl text PRIMARY KEY, hash text, skipped_rows real) ON COMMIT DROP;

-- Everything about the user's schema that a revert must restore (not the dmcr registry).
CREATE FUNCTION pg_temp.dmcr_rt_schema() RETURNS SETOF text LANGUAGE sql AS $fn$
  WITH ns AS (
    SELECT oid, nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'dmcr')
      AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
  )
  SELECT 'schema ' || nspname FROM ns
  UNION ALL
  SELECT 'relation ' || ns.nspname || '.' || c.relname || ' kind=' || c.relkind::text
         || ' acl=' || coalesce(c.relacl::text, '') || ' rls=' || c.relrowsecurity
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT 'column ' || ns.nspname || '.' || c.relname || '.' || a.attname
         || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid JOIN ns ON ns.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  UNION ALL
  SELECT 'constraint ' || ns.nspname || '.' || c.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN ns ON ns.oid = c.relnamespace
  UNION ALL
  SELECT 'index ' || ns.nspname || '.' || ic.relname || ' ' || pg_get_indexdef(i.indexrelid)
  FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN ns ON ns.oid = ic.relnamespace
  UNION ALL
  SELECT 'view ' || ns.nspname || '.' || c.relname || ' ' || md5(pg_get_viewdef(c.oid))
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace WHERE c.relkind IN ('v', 'm')
  UNION ALL
  SELECT 'function ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid))
         || ' acl=' || coalesce(p.proacl::text, '')
  FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace WHERE p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'trigger ' || ns.nspname || '.' || c.relname || '.' || t.tgname || ' ' || pg_get_triggerdef(t.oid)
         || ' enabled=' || t.tgenabled::text
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN ns ON ns.oid = c.relnamespace
  WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'type ' || ns.nspname || '.' || t.typname || ' ' || t.typtype::text
         || coalesce(' ' || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '')
  FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
  WHERE t.typtype IN ('e', 'd', 'c') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c')
  UNION ALL
  SELECT 'policy ' || ns.nspname || '.' || c.relname || '.' || pol.polname || ' ' || pol.polcmd::text
         || ' ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN ns ON ns.oid = c.relnamespace
  UNION ALL
  SELECT 'extension ' || extname || ' ' || extversion FROM pg_extension
$fn$;

-- Order-independent content hash of a table (rows as jsonb, so column order doesn't matter).
CREATE FUNCTION pg_temp.dmcr_rt_hash(tbl text) RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE h text;
BEGIN
  EXECUTE format('SELECT md5(coalesce(string_agg(x, '''' ORDER BY x), '''')) FROM (SELECT md5(to_jsonb(t)::text) AS x FROM %s t) s', tbl) INTO h;
  RETURN h;
END $fn$;

CREATE FUNCTION pg_temp.dmcr_rt_start(p_id text) RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE NOTICE 'DMCR_RT|%|start|', p_id;
  DELETE FROM pg_temp.dmcr_rt_base;
  INSERT INTO pg_temp.dmcr_rt_base
    SELECT relid, n_tup_ins + n_tup_upd + n_tup_del FROM pg_stat_xact_user_tables;
END $fn$;

CREATE FUNCTION pg_temp.dmcr_rt_before(p_id text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE r record; est real; lim real := (SELECT max_rows FROM pg_temp.dmcr_rt_conf);
BEGIN
  DELETE FROM pg_temp.dmcr_rt_schema_before;
  INSERT INTO pg_temp.dmcr_rt_schema_before SELECT * FROM pg_temp.dmcr_rt_schema();
  DELETE FROM pg_temp.dmcr_rt_data_before;
  -- Tables whose rows deploy.sql or revert.sql changed during the probe
  FOR r IN
    SELECT format('%I.%I', s.schemaname, s.relname) AS tbl, s.relid
    FROM pg_stat_xact_user_tables s
    LEFT JOIN pg_temp.dmcr_rt_base b ON b.relid = s.relid
    WHERE s.schemaname <> 'dmcr' AND s.schemaname NOT LIKE 'pg_temp%'
      AND s.n_tup_ins + s.n_tup_upd + s.n_tup_del > coalesce(b.n, 0)
  LOOP
    SELECT reltuples INTO est FROM pg_class WHERE oid = r.relid;
    IF est > lim THEN
      INSERT INTO pg_temp.dmcr_rt_data_before VALUES (r.tbl, NULL, est);
    ELSE
      INSERT INTO pg_temp.dmcr_rt_data_before VALUES (r.tbl, pg_temp.dmcr_rt_hash(r.tbl), NULL);
    END IF;
  END LOOP;
END $fn$;

CREATE FUNCTION pg_temp.dmcr_rt_after(p_id text) RETURNS boolean LANGUAGE plpgsql AS $fn$
DECLARE r record; ok boolean := true; n int := 0; diff text;
BEGIN
  FOR r IN
    (SELECT 'missing after revert: ' || item AS d FROM pg_temp.dmcr_rt_schema_before
     EXCEPT ALL SELECT 'missing after revert: ' || x FROM pg_temp.dmcr_rt_schema() x)
    UNION ALL
    (SELECT 'left behind by revert: ' || x FROM pg_temp.dmcr_rt_schema() x
     EXCEPT ALL SELECT 'left behind by revert: ' || item FROM pg_temp.dmcr_rt_schema_before)
    ORDER BY 1 LIMIT 10
  LOOP
    ok := false;
    RAISE NOTICE 'DMCR_RT|%|fail|%', p_id, r.d;
  END LOOP;
  FOR r IN SELECT * FROM pg_temp.dmcr_rt_data_before ORDER BY tbl LOOP
    IF r.hash IS NULL THEN
      RAISE NOTICE 'DMCR_RT|%|note|data in % not compared (about % rows; schema still checked)', p_id, r.tbl, r.skipped_rows::bigint;
      CONTINUE;
    END IF;
    IF to_regclass(r.tbl) IS NULL THEN
      CONTINUE;  -- reported as a schema difference above
    END IF;
    n := n + 1;
    IF pg_temp.dmcr_rt_hash(r.tbl) IS DISTINCT FROM r.hash THEN
      ok := false;
      RAISE NOTICE 'DMCR_RT|%|fail|data in % is not the same after revert', p_id, r.tbl;
    END IF;
  END LOOP;
  IF ok THEN
    RAISE NOTICE 'DMCR_RT|%|pass|deploy, verify, revert and verify passed; schema and data of % table(s) restored exactly', p_id, n;
  END IF;
  RETURN ok;
END $fn$;
