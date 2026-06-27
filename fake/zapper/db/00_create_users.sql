-- ============================================================
-- Zapper — Create Postgres Users & Databases
-- Run as superuser: psql -U postgres -f 00_create_users.sql
-- Creates: zapper_st (ST / staging) and zapper_prod (PROD)
--
-- After running this, connect to each database and run
-- all schema/seed files (01-10) in order.
--
-- DMCR Config (dmcr.cfg):
--   [st]
--   conn = postgresql://zapper_st:zapper_st_2026!@localhost:5432/zapper_st
--   [prod]
--   conn = postgresql://zapper_prod:zapper_prod_2026!@localhost:5432/zapper_prod
-- ============================================================

-- ── Users ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zapper_st') THEN
        CREATE USER zapper_st WITH PASSWORD 'zapper_st_2026!' LOGIN;
        RAISE NOTICE 'Created user: zapper_st';
    ELSE
        RAISE NOTICE 'User zapper_st already exists — skipping';
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zapper_prod') THEN
        CREATE USER zapper_prod WITH PASSWORD 'zapper_prod_2026!' LOGIN;
        RAISE NOTICE 'Created user: zapper_prod';
    ELSE
        RAISE NOTICE 'User zapper_prod already exists — skipping';
    END IF;
END;
$$;

-- ── Databases ─────────────────────────────────────────────────────────────
-- NOTE: CREATE DATABASE cannot run inside a transaction block.
-- Run these two lines manually in psql if you get an error:
--
--   CREATE DATABASE zapper_st   OWNER zapper_st;
--   CREATE DATABASE zapper_prod OWNER zapper_prod;

SELECT 'Run manually: CREATE DATABASE zapper_st OWNER zapper_st;' AS action
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zapper_st')
UNION ALL
SELECT 'Run manually: CREATE DATABASE zapper_prod OWNER zapper_prod;' AS action
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zapper_prod');

-- ── Quick-copy commands for terminal ──────────────────────────────────────
-- psql -U postgres -c "CREATE DATABASE zapper_st   OWNER zapper_st;"
-- psql -U postgres -c "CREATE DATABASE zapper_prod OWNER zapper_prod;"

-- ── Grant schema access (run after connecting to each database) ───────────
-- Connect to zapper_st:
--   GRANT ALL PRIVILEGES ON SCHEMA public TO zapper_st;
--   GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO zapper_st;
--   GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO zapper_st;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO zapper_st;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO zapper_st;

-- Connect to zapper_prod:
--   GRANT ALL PRIVILEGES ON SCHEMA public TO zapper_prod;
--   GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO zapper_prod;
--   GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO zapper_prod;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO zapper_prod;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO zapper_prod;
