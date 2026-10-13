#!/usr/bin/env bash
# Zero-downtime changes written with ${schema} (fixtures/zero-downtime, made by DMCR's own templates)
# through dmcr.sh on two environments with different schemas: test = zp_st (database dmcrtest),
# prod = zp (database dmcrzp). Every object must land in the environment's schema, the sync trigger
# must work there, verify must pass, the danger_ contracts run as manual scripts, and revert undoes it all.
set -u
R=/runner/dmcr.sh
TEST="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
PROD="postgresql://postgres:dmcrtest@localhost:5432/dmcrzp"
unset DMCR_CONN
export DMCR_BASE_DIR=/zwork DMCR_DANGER_RULES=/zcfg/dmcr_danger.json DMCR_ACTOR=tester
PASS=0; FAIL=0
q() { psql "$1" -X -t -A -c "$2" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); fi; }
run() { bash $R -c /zcfg/dmcr.cfg "$@" >/tmp/zout.txt 2>&1; echo $?; }
has() { sed 's/\x1b\[[0-9;]*m//g' /tmp/zout.txt | grep -cF -- "$1"; }
base() {   # $1 conn, $2 schema
  q "$1" "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS $2 CASCADE;
    CREATE SCHEMA $2;
    CREATE TABLE $2.zaps (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner varchar(100) NOT NULL);
    CREATE TABLE $2.zap_runs (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, zap_id bigint, started_at timestamptz DEFAULT now(), duration_ms integer);
    INSERT INTO $2.zaps (owner) VALUES ('lena'), ('priya'), ('marco');
    INSERT INTO $2.zap_runs (zap_id, duration_ms) SELECT 1 + g % 3, g * 100 FROM generate_series(1, 5) g;" >/dev/null
}
check_env() {   # $1 conn, $2 schema, $3 env
  local c="$1" s="$2" e="$3"
  ok "$(q "$c" "SELECT count(*) FROM $s.zaps WHERE owner_name = owner;")" 3 "$e: owner_name backfilled in $s"
  q "$c" "INSERT INTO $s.zaps (owner) VALUES ('tom');" >/dev/null
  ok "$(q "$c" "SELECT owner_name FROM $s.zaps WHERE owner = 'tom';")" tom "$e: the sync trigger in $s copies owner to owner_name"
  q "$c" "INSERT INTO $s.zaps (owner, owner_name) VALUES ('x', 'x'); UPDATE $s.zaps SET owner_name = 'ana' WHERE owner = 'x';" >/dev/null
  ok "$(q "$c" "SELECT count(*) FROM $s.zaps WHERE owner = 'ana';")" 1 "$e: and owner_name back to owner"
  ok "$(q "$c" "SELECT count(*) FROM $s.zap_runs WHERE duration_ms_big = duration_ms;")" 5 "$e: duration_ms_big backfilled in $s"
  ok "$(q "$c" "SELECT is_nullable FROM information_schema.columns WHERE table_schema = '$s' AND table_name = 'zap_runs' AND column_name = 'started_at';")" NO "$e: $s.zap_runs.started_at is NOT NULL"
  ok "$(q "$c" "SELECT convalidated::text || ' ' || confrelid::regclass::text FROM pg_constraint WHERE conrelid = '$s.zap_runs'::regclass AND contype = 'f';")" "true $s.zaps" "$e: FK validated, references $s.zaps"
  ok "$(q "$c" "SELECT count(*) FROM pg_indexes WHERE schemaname = '$s' AND indexdef ILIKE '%(zap_id, started_at)%';")" 1 "$e: index on $s.zap_runs (zap_id, started_at)"
  ok "$(q "$c" "SELECT (SELECT count(*) FROM pg_namespace WHERE nspname LIKE '%{%') + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('zaps', 'zap_runs')) + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'dmcr_sync%');")" 0 "$e: nothing landed in public or in a schema named \${schema}"
}

q "$TEST" "DROP DATABASE IF EXISTS dmcrzp;" >/dev/null
q "$TEST" "CREATE DATABASE dmcrzp;" >/dev/null
base "$TEST" zp_st; base "$PROD" zp
rm -rf /zwork /zcfg; mkdir -p /zwork/changes /zcfg
cp -r /tests/fixtures/zero-downtime/. /zwork/changes/
printf '[dmcr]\nenv = test\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n\n[envs]\nnames = prod, test\n\n[test]\nconn = %s\nschema = zp_st\n\n[prod]\nconn = %s\nschema = zp\n' "$TEST" "$PROD" > /zcfg/dmcr.cfg
echo '{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' > /zcfg/dmcr_danger.json
run init --env test >/dev/null; run init --env prod >/dev/null

echo "== test (zp_st): deploy, verify"
ok "$(run deploy --env test)" 0 "deploy --env test succeeds"
ok "$(q "$TEST" "SELECT count(*) FROM dmcr.change_log;")" 7 "the 7 expand / single changes are applied on test"
ok "$(has 'manual-only (danger_)')" 2 "the 2 danger_ contracts are left to the DBA"
check_env "$TEST" zp_st test
ok "$(run verify all --env test)" 0 "verify all --env test passes"

echo "== prod (zp): the same files"
ok "$(run deploy --env prod)" 0 "deploy --env prod succeeds"
ok "$(q "$PROD" "SELECT count(*) FROM dmcr.change_log;")" 7 "the 7 changes are applied on prod"
check_env "$PROD" zp prod
ok "$(run verify all --env prod)" 0 "verify all --env prod passes"
ok "$(q "$TEST" "SELECT count(*) FROM pg_namespace WHERE nspname = 'zp';")" 0 "test database has no zp schema"

echo "== the contracts as manual scripts (test)"
for id in 002_danger_rename_zaps_owner_contract 004_danger_retype_zap_runs_duration_ms_contract; do
  bash $R -c /zcfg/dmcr.cfg manual-script "$id" --env test > "/tmp/$id.sql" 2>/tmp/zerr.txt
  ok "$(grep -c '\${' "/tmp/$id.sql")" 0 "$id: the script has no \${...} left"
  ok "$(grep -c 'zp_st\.' "/tmp/$id.sql" | awk '{print ($1 > 0)}')" 1 "$id: the script names zp_st"
  psql "$TEST" -X -q -v ON_ERROR_STOP=1 -f "/tmp/$id.sql" >/tmp/zman.txt 2>&1; ok "$?" 0 "$id: the script runs"
done
ok "$(q "$TEST" "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'zp_st' AND table_name = 'zaps';")" "id,owner_name" "zp_st.zaps keeps only id, owner_name"
ok "$(q "$TEST" "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'zp_st' AND table_name = 'zap_runs' AND column_name = 'duration_ms';")" 0 "zp_st.zap_runs.duration_ms dropped"
ok "$(q "$TEST" "SELECT count(*) FROM dmcr.change_log;")" 9 "registry: all 9 changes on test"
ok "$(run verify all --env test)" 0 "verify all --env test passes after the contracts"
ok "$(q "$PROD" "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'zp' AND table_name = 'zaps' AND column_name = 'owner';")" 1 "prod still has zp.zaps.owner (contract not run there)"

echo "== revert on prod down to the start"
ok "$(run revert to 001_rename_zaps_owner_expand --env prod)" 0 "revert to 001 on prod succeeds"
ok "$(q "$PROD" "SELECT count(*) FROM dmcr.change_log;")" 0 "prod registry empty"
ok "$(q "$PROD" "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'zp' AND table_name IN ('zaps', 'zap_runs');")" "duration_ms,id,id,owner,started_at,zap_id" "zp tables back to their original columns"
ok "$(q "$PROD" "SELECT count(*) FROM pg_proc WHERE pronamespace = 'zp'::regnamespace;")" 0 "sync trigger functions removed from zp"
ok "$(q "$PROD" "SELECT count(*) FROM pg_constraint WHERE conrelid = 'zp.zap_runs'::regclass AND contype IN ('f', 'c');")" 0 "FK and NOT NULL check removed"

echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
