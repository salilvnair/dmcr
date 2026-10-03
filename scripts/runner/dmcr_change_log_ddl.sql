-- =========================================================
-- DMCR v1.0.0 – Registry DDL
-- Idempotent: safe to re-run on existing databases.
-- =========================================================

CREATE SCHEMA IF NOT EXISTS dmcr;

-- ---------------------------------------------------------
-- change_log – one row per applied change
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS dmcr.change_log (
    change_id         text        PRIMARY KEY,               -- folder id (001_*)
    applied_at        timestamptz NOT NULL DEFAULT now(),
    applied_by        text        NOT NULL DEFAULT current_user,
    description       text        NULL,
    deploy_checksum   text        NULL,                      -- sha256 of deploy.sql
    verify_checksum   text        NULL,                      -- sha256 of verify.sql
    revert_checksum   text        NULL,                      -- sha256 of revert.sql
    ticket_id         text        NULL,                      -- e.g. JIRA-1234
    git_commit        text        NULL,                      -- short or full SHA
    app_name          text        NULL,                      -- logical application name
    environment       text        NULL,                      -- dev | staging | prod
    actor             text        NULL                       -- deploying principal (person or CI)
);

CREATE INDEX IF NOT EXISTS ix_dmcr_change_log_applied_at ON dmcr.change_log (applied_at DESC);

-- ---------------------------------------------------------
-- event_log – append-only audit trail
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS dmcr.event_log (
    id             bigserial    PRIMARY KEY,
    event_ts       timestamptz  NOT NULL DEFAULT now(),
    action         text         NOT NULL,                    -- deploy | revert | lock | unlock | repair | baseline
    change_id      text         NOT NULL,
    status         text         NOT NULL,                    -- success | failure | warning
    message        text         NULL,
    environment    text         NULL,
    actor          text         NULL,
    duration_ms    integer      NULL                         -- elapsed wall-clock time
);

CREATE INDEX IF NOT EXISTS ix_dmcr_event_log_event_ts  ON dmcr.event_log (event_ts DESC);
CREATE INDEX IF NOT EXISTS ix_dmcr_event_log_change_id ON dmcr.event_log (change_id);

-- ---------------------------------------------------------
-- tags – named deployment snapshots (like Sqitch @v1.0)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS dmcr.tags (
    tag_name      text        PRIMARY KEY,                   -- e.g. v1.0, sprint-42
    change_id     text        NOT NULL,                      -- last change_id in this tag
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text        NOT NULL DEFAULT current_user,
    description   text        NULL
);

CREATE INDEX IF NOT EXISTS ix_dmcr_tags_change_id ON dmcr.tags (change_id);

-- ---------------------------------------------------------
-- repeatable_log – tracks repeatable migrations by checksum
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS dmcr.repeatable_log (
    change_id     text        PRIMARY KEY,                   -- folder id (R__*)
    last_checksum text        NOT NULL,                      -- sha256 of deploy.sql
    applied_at    timestamptz NOT NULL DEFAULT now(),
    applied_by    text        NOT NULL DEFAULT current_user,
    environment   text        NULL,
    actor         text        NULL
);

CREATE INDEX IF NOT EXISTS ix_dmcr_repeatable_log_applied ON dmcr.repeatable_log (applied_at DESC);

-- Deploy lock (v1.1.1): a single row held for the duration of deploy / revert / repeatable.
-- Cleared on release; `dmcr repair --unlock` clears it after a crashed run.
CREATE TABLE IF NOT EXISTS dmcr.deploy_lock (
    lock_id      integer     PRIMARY KEY DEFAULT 1 CHECK (lock_id = 1),
    holder       text        NOT NULL,
    environment  text,
    acquired_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- v1.0.0 migration helpers – add columns that may not exist
-- on databases originally created with v0.x DDL.
-- ALTER TABLE … ADD COLUMN IF NOT EXISTS requires PG 9.6+.
-- ---------------------------------------------------------
DO $$ BEGIN
    -- change_log new columns
    ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS verify_checksum text NULL;
    ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS revert_checksum text NULL;
    ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS ticket_id       text NULL;
    ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS git_commit      text NULL;
    ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS app_name        text NULL;
    ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS environment     text NULL;
    ALTER TABLE dmcr.change_log ADD COLUMN IF NOT EXISTS actor           text NULL;

    -- event_log new columns
    ALTER TABLE dmcr.event_log ADD COLUMN IF NOT EXISTS environment  text    NULL;
    ALTER TABLE dmcr.event_log ADD COLUMN IF NOT EXISTS actor        text    NULL;
    ALTER TABLE dmcr.event_log ADD COLUMN IF NOT EXISTS duration_ms  integer NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'DMCR v1.0.0 migration: %', SQLERRM;
END $$;

-- ---------------------------------------------------------
-- v1.1.0 migration – create tags and repeatable_log if missing
-- (safe to re-run: CREATE TABLE IF NOT EXISTS above handles it)
-- ---------------------------------------------------------
DO $$ BEGIN
    -- Ensure tags table exists (for upgrades from v1.0.0)
    CREATE TABLE IF NOT EXISTS dmcr.tags (
        tag_name      text        PRIMARY KEY,
        change_id     text        NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        created_by    text        NOT NULL DEFAULT current_user,
        description   text        NULL
    );
    CREATE TABLE IF NOT EXISTS dmcr.repeatable_log (
        change_id     text        PRIMARY KEY,
        last_checksum text        NOT NULL,
        applied_at    timestamptz NOT NULL DEFAULT now(),
        applied_by    text        NOT NULL DEFAULT current_user,
        environment   text        NULL,
        actor         text        NULL
    );
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'DMCR v1.1.0 migration: %', SQLERRM;
END $$;