#!/usr/bin/env bash
# Tests for ${app_role} per environment and the deploy check for SQL that names one environment's schema or role, in dmcr.sh.
# Two databases in the test container stand in for test and prod. Same scenarios as envnames.ps1.
set -u
R=/runner/dmcr.sh
ADMIN="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
TEST="postgresql://postgres:dmcrtest@localhost:5432/dmcrenvt"
PROD="postgresql://postgres:dmcrtest@localhost:5432/dmcrenvp"
unset DMCR_CONN
export DMCR_BASE_DIR=/ework DMCR_DANGER_RULES=/ecfg/dmcr_danger.json DMCR_ACTOR=tester
PASS=0; FAIL=0
q() { psql "$1" -X -t -A -c "$2" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); fi; }
run() { bash $R -c /ecfg/dmcr.cfg "$@" >/tmp/eout.txt 2>&1; echo $?; }
has() { sed 's/\x1b\[[0-9;]*m//g' /tmp/eout.txt | grep -cF -- "$1" | sed 's/^[1-9][0-9]*$/1/'; }
mk() { mkdir -p "/ework/changes/$1"; printf '%s\n' "$2" > "/ework/changes/$1/deploy.sql"; printf '%s\n' "${4:-SELECT 1;}" > "/ework/changes/$1/verify.sql"; printf '%s\n' "$3" > "/ework/changes/$1/revert.sql"; }
applied() { q "$1" "SELECT coalesce(string_agg(change_id, ',' ORDER BY change_id), '') FROM dmcr.change_log;"; }
grants() { q "$1" "SELECT coalesce(string_agg(table_schema || '.' || table_name || ':' || grantee, ',' ORDER BY 1), '') FROM (SELECT DISTINCT table_schema, table_name, grantee FROM information_schema.role_table_grants WHERE grantee IN ('rt', 'rp')) g;"; }
cfg() { printf '[dmcr]\nenv = test\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n\n[test]\nconn = %s\nschema = zt\n%s\n\n[prod]\nconn = %s\nschema = zr\n%s\npromote_from = test\n' "$TEST" "$1" "$PROD" "$2" > /ecfg/dmcr.cfg; }

for db in dmcrenvt dmcrenvp; do q "$ADMIN" "DROP DATABASE IF EXISTS $db WITH (FORCE);" >/dev/null; q "$ADMIN" "CREATE DATABASE $db;" >/dev/null; done
q "$ADMIN" "DROP ROLE IF EXISTS rt;" >/dev/null; q "$ADMIN" "DROP ROLE IF EXISTS rp;" >/dev/null
q "$ADMIN" "CREATE ROLE rt;" >/dev/null; q "$ADMIN" "CREATE ROLE rp;" >/dev/null
rm -rf /ework /ecfg; mkdir -p /ework/changes /ecfg
echo '{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' > /ecfg/dmcr_danger.json
cfg 'app_role = rt' 'app_role = rp'

echo "== a schema made by hand before DMCR sets the database up"
q "$TEST" "CREATE SCHEMA zt;" >/dev/null
ok "$(run init)" 0 "init keeps a schema that exists"
ok "$(run init --env prod)" 0 "init creates the one that does not"
ok "$(q "$PROD" "SELECT to_regnamespace('zr') IS NOT NULL;")" t "prod has its schema"

echo "== one file, each environment's schema and role"
mk 001_xx $'CREATE TABLE xx (id int);\nGRANT SELECT, UPDATE, DELETE ON xx TO ${app_role};' $'REVOKE ALL ON xx FROM ${app_role};\nDROP TABLE xx;'
ok "$(run deploy)" 0 "deploy to test"
ok "$(grants "$TEST")" "zt.xx:rt" "test: the table in its schema, granted to its role"
ok "$(run deploy --env prod)" 0 "deploy to prod, the same files"
ok "$(has 'Promotion gate OK')" 1 "the gate sees identical files"
ok "$(grants "$PROD")" "zr.xx:rp" "prod: the table in its schema, granted to its role"

echo "== a role named in the SQL"
mk 002_role $'CREATE TABLE r2 (id int);\nGRANT SELECT ON r2 TO rt;' 'DROP TABLE r2;'
ok "$(run deploy)" 1 "deploy is refused on test"
ok "$(has 'BLOCKED by environment names (test)')" 1 "says why"
ok "$(has '002_role/deploy.sql names role rt')" 1 "names the file and the role"
ok "$(applied "$TEST")" "001_xx" "nothing applied"
ok "$(run deploy --env prod)" 1 "deploy is refused on prod"
ok "$(run deploy --env prod --dry-run --json)" 0 "the preview on prod runs"
ok "$(has '002_role/deploy.sql names role rt')" 1 "and reports it, whichever environment the role is from"
ok "$(run deploy --dry-run --json)" 0 "the preview runs"
ok "$(has '002_role/deploy.sql names role rt')" 1 "the preview reports it"
rm -rf /ework/changes/002_role
mk 002_role 'CREATE TABLE r2 (id int);' 'DROP TABLE r2;' "SELECT has_table_privilege('rt', 'zt.r2', 'SELECT');"
ok "$(run deploy)" 1 "a role in a privilege check is refused"
ok "$(has '002_role/verify.sql names role rt')" 1 "names verify.sql"
ok "$(has '002_role/verify.sql names schema zt')" 0 "zt.r2 in another string is not read as a name here"
rm -rf /ework/changes/002_role

echo "== a schema named in the SQL"
mk 002_sch 'CREATE TABLE zt.s2 (id int);' 'DROP TABLE zt.s2;'
ok "$(run deploy)" 1 "deploy is refused"
ok "$(has '002_sch/deploy.sql names schema zt')" 1 "names the file and the schema"
ok "$(has '002_sch/revert.sql names schema zt')" 1 "and revert.sql"
rm -rf /ework/changes/002_sch
mk 002_sch 'CREATE TABLE s2 (id int);' 'DROP TABLE s2;' "SELECT to_regclass('zr.s2');"
ok "$(run deploy)" 1 "a schema in to_regclass is refused"
rm -rf /ework/changes/002_sch

echo "== what is not a name of an environment"
mk 002_ok $'-- moved from zt.old_s2, granted to rt before\nCREATE TABLE s2 (id int);\nINSERT INTO s2 SELECT zr.id FROM xx zr;\nCOMMENT ON TABLE s2 IS \'copy of zt.old_s2 for rt\';' 'DROP TABLE s2;'
ok "$(run deploy)" 0 "a comment, a string and an alias called zr pass"

echo "== an environment without an App role"
cfg 'app_role = rt' ''
mk 003_g $'CREATE TABLE g3 (id int);\nGRANT SELECT ON g3 TO ${app_role};' 'DROP TABLE g3;'
ok "$(run deploy)" 0 "test has one"
ok "$(run deploy --env prod)" 1 "prod has none: refused"
ok "$(has '003_g/deploy.sql uses ${app_role}, and prod has no App role')" 1 "says what to set"

echo "== the same role everywhere"
cfg 'app_role = rt' 'app_role = rt'
mk 004_same $'CREATE TABLE s4 (id int);\nGRANT SELECT ON s4 TO rt;' 'DROP TABLE s4;'
ok "$(run deploy)" 0 "a name that is the same everywhere can stay"

echo "== app_role in dmcr.cfg"
cfg 'app_role = rt; drop' 'app_role = rp'
ok "$(run status)" 1 "not a plain role name: stops"
ok "$(has 'Invalid app_role')" 1 "and says so"

for db in dmcrenvt dmcrenvp; do q "$ADMIN" "DROP DATABASE IF EXISTS $db WITH (FORCE);" >/dev/null; done
q "$ADMIN" "DROP ROLE IF EXISTS rt;" >/dev/null; q "$ADMIN" "DROP ROLE IF EXISTS rp;" >/dev/null
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
