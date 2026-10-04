#!/usr/bin/env bash
# Tests for the deploy plan guards in dmcr.sh: promote_from (promotion gate) and out_of_order.
# Two databases in the test container stand in for the test and prod environments.
set -u
R=/runner/dmcr.sh
TEST="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
PROD="postgresql://postgres:dmcrtest@localhost:5432/dmcrprod"
unset DMCR_CONN
export DMCR_BASE_DIR=/pwork DMCR_DANGER_RULES=/pcfg/dmcr_danger.json DMCR_ACTOR=tester
PASS=0; FAIL=0
q() { psql "$1" -X -t -A -c "$2" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); fi; }
run() { bash $R -c /pcfg/dmcr.cfg "$@" >/tmp/pout.txt 2>&1; echo $?; }
has() { sed 's/\x1b\[[0-9;]*m//g' /tmp/pout.txt | grep -cF -- "$1"; }
mk() { mkdir -p "/pwork/changes/$1"; printf '%s\n' "CREATE TABLE app.$2 (id int);" > "/pwork/changes/$1/deploy.sql"; printf 'SELECT 1;\n' > "/pwork/changes/$1/verify.sql"; printf '%s\n' "DROP TABLE app.$2;" > "/pwork/changes/$1/revert.sql"; }
applied() { q "$1" "SELECT coalesce(string_agg(change_id, ',' ORDER BY change_id), '') FROM dmcr.change_log;"; }

q "$TEST" "DROP DATABASE IF EXISTS dmcrprod;" >/dev/null
q "$TEST" "CREATE DATABASE dmcrprod;" >/dev/null
q "$TEST" "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;" >/dev/null
q "$PROD" "CREATE SCHEMA app;" >/dev/null
rm -rf /pwork /pcfg; mkdir -p /pwork/changes /pcfg
printf '[dmcr]\nenv = test\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n\n[test]\nconn = %s\n\n[prod]\nconn = %s\npromote_from = test\nout_of_order = block\n' "$TEST" "$PROD" > /pcfg/dmcr.cfg
echo '{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' > /pcfg/dmcr_danger.json
run init >/dev/null; run init --env prod >/dev/null

echo "== prod refuses what test has not run"
mk 001_t1 t1
ok "$(run deploy --env prod)" 1 "deploy to prod is blocked"
ok "$(has '001_t1 is not applied in test')" 1 "names the change test has not run"
ok "$(applied "$PROD")" "" "nothing applied in prod"

echo "== test first, then prod"
ok "$(run deploy)" 0 "deploy to test"
ok "$(run deploy --env prod)" 0 "deploy to prod"
ok "$(has 'Promotion gate OK')" 1 "gate reports OK"
ok "$(applied "$PROD")" "001_t1" "prod has 001"

echo "== files edited after test ran them are refused"
mk 002_danger_t2 t2   # manual-only: skipped by deploy in both environments
mk 003_t3 t3
ok "$(run deploy)" 0 "deploy 003 to test"
echo "-- edited" >> /pwork/changes/003_t3/deploy.sql
ok "$(run deploy --env prod)" 1 "edited change is blocked"
ok "$(has '003_t3/deploy.sql differs from the one applied in test')" 1 "names the edited file"
ok "$(applied "$PROD")" "001_t1" "prod unchanged"
mk 003_t3 t3
ok "$(run deploy --env prod)" 0 "restored file promotes"

echo "== the source registry must be readable; --to limits the plan"
mk 004_t4 t4
ok "$(run deploy)" 0 "deploy 004 to test"
ok "$(DMCR_PROMOTE_FROM_CONN=postgresql://postgres:dmcrtest@localhost:5432/no_such_db run deploy --env prod)" 1 "unreadable source blocks"
ok "$(has "cannot read the DMCR registry of 'test'")" 1 "says the source could not be read"
mk 005_t5 t5
ok "$(run deploy --env prod --to 004_t4)" 0 "--to stops before a change test has not run"
ok "$(applied "$PROD")" "001_t1,003_t3,004_t4" "prod has 001,003,004"
ok "$(run deploy --env prod)" 1 "005 is still blocked"
rm -rf /pwork/changes/005_t5

echo "== out_of_order = block"
mv /pwork/changes/002_danger_t2 /pwork/changes/002_t2   # later cleared for normal deploys
ok "$(run deploy)" 0 "test allows out of order (default)"
ok "$(run deploy --env prod)" 1 "prod blocks out of order"
ok "$(has '002_t2 is out of order: 004_t4 is already applied')" 1 "names the out-of-order change"
ok "$(applied "$PROD")" "001_t1,003_t3,004_t4" "prod unchanged"

q "$TEST" "DROP DATABASE IF EXISTS dmcrprod WITH (FORCE);" >/dev/null
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
