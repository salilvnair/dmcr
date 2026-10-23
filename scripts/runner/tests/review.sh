#!/usr/bin/env bash
# Regression tests for the defects found in the 2026-10 review of dmcr.sh — runs inside the postgres:16 test
# container, like roundtrip.sh. Same scenarios as review.ps1.
set -u
R=/runner/dmcr.sh
CONN="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
export DMCR_CONN="$CONN" DMCR_BASE_DIR=/twork DMCR_DANGER_RULES=/tcfg/dmcr_danger.json DMCR_ACTOR=tester
PASS=0; FAIL=0
q() { psql "$CONN" -X -t -A -c "$1" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); out | tail -12 | sed 's/^/        | /'; fi; }
run() { bash $R -c /tcfg/dmcr.cfg "$@" >/tmp/tout.txt 2>/tmp/terr.txt; echo $?; }
out() { cat /tmp/tout.txt /tmp/terr.txt | sed "s/$(printf '\033')\[[0-9;]*m//g"; }
has() { out | grep -qF -- "$1" && echo yes || echo no; }
json_ok() { perl -MJSON::PP -0777 -ne 'decode_json($_)' /tmp/tout.txt >/dev/null 2>&1 && echo yes || echo no; }
mk() { mkdir -p "/twork/changes/$1"; printf '%s\n' "$2" > "/twork/changes/$1/deploy.sql"; printf '%s\n' "$3" > "/twork/changes/$1/verify.sql"; printf '%s\n' "$4" > "/twork/changes/$1/revert.sql"; [[ -n "${5:-}" ]] && printf '%s\n' "$5" > "/twork/changes/$1/meta.json"; true; }
cfg() { printf '[dmcr]\nenv = staging\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\nchecksum_policy = %s\n\n[staging]\nconn =\n\n[placeholders]\nschema = app\n' "${1:-warn}" > /tcfg/dmcr.cfg; }

q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;" >/dev/null
rm -rf /twork /tcfg; mkdir -p /twork/changes /tcfg
cfg warn
echo '{"deployOnlyPatterns":[{"label":"DROP TABLE","regex":"(?i)\\bDROP\\s+TABLE\\b","scope":"deployOnly"}],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":true}' > /tcfg/dmcr_danger.json
bash $R -c /tcfg/dmcr.cfg init >/dev/null 2>&1

echo "== a placeholder without a value never deploys an empty change"
mk 001_t1 'CREATE TABLE ${scheam}.t1 (id int, note text);' 'SELECT 1;' 'DROP TABLE ${schema}.t1;'
ok "$(run deploy)" 1 "deploy refuses"
ok "$(has 'placeholder without a value')" yes "says why"
ok "$(q "SELECT count(*) FROM dmcr.change_log;")" 0 "nothing recorded"
printf 'CREATE TABLE ${schema}.t1 (id int, note text);\n' > /twork/changes/001_t1/deploy.sql
ok "$(run deploy)" 0 "deploys once the placeholder resolves"
ok "$(q "SELECT count(*) FROM app.t1;")" 0 "the table is there"

echo "== plan with requires is not a circular dependency"
mk 002_t2 'CREATE TABLE app.t2 (id int);' 'SELECT 1;' 'DROP TABLE app.t2;' '{"requires": ["001_t1"]}'
ok "$(run plan)" 0 "plan exits 0"
ok "$(has 'Circular')" no "no false circular dependency"
ok "$(run plan --json)" 0 "plan --json exits 0"
ok "$(json_ok)" yes "plan --json is JSON"
ok "$(run deploy)" 0 "deploys"

echo "== parse never commits the user's SQL"
q "INSERT INTO app.t1 (id) VALUES (1);" >/dev/null
ok "$(run parse "DELETE FROM app.t1; COMMIT;")" 0 "parse exits 0"
ok "$(has '"ok":false')" yes "refused"
ok "$(has 'COMMIT')" yes "names COMMIT"
ok "$(q "SELECT count(*) FROM app.t1;")" 1 "the row is still there"
ok "$(run parse "INSERT INTO app.t1 (id) VALUES (2) WHERE;")" 0 "a syntax error parses"
ok "$(has '"ok":false')" yes "reported"
ok "$(has '"line":1')" yes "on line 1 of the user's SQL"

echo "== the danger scan reads strings and comments in one pass"
mk 003_lit "INSERT INTO app.t1 (id, note) VALUES (3, '--'); DROP TABLE app.t2;" 'SELECT 1;' "DELETE FROM app.t1 WHERE id = 3;"
ok "$(run deploy)" 1 "DROP TABLE after a '--' string is still blocked"
ok "$(q "SELECT count(*) FROM app.t2;")" 0 "app.t2 still exists"
rm -rf /twork/changes/003_lit
mk 003_semi "UPDATE app.t1 SET note = 'a;b' WHERE id = 1;" 'SELECT 1;' "UPDATE app.t1 SET note = NULL WHERE id = 1;"
ok "$(run deploy)" 0 "a ';' inside a string does not split the statement"
ok "$(q "SELECT note FROM app.t1 WHERE id = 1;")" 'a;b' "the update ran"

echo "== a failed repeatable is a failed deploy"
mkdir -p /twork/changes/R__bad; printf 'CREATE OR REPLACE VIEW app.v_bad AS SELECT * FROM app.nope;\n' > /twork/changes/R__bad/deploy.sql
ok "$(run deploy --json)" 1 "deploy exits 1"
ok "$(has '"status":"failed"')" yes "JSON says failed"
ok "$(has 'R__bad')" yes "and names it"
ok "$(json_ok)" yes "deploy --json on failure is JSON"
ok "$(run repeatable --json)" 1 "dmcr repeatable exits 1 too"
rm -rf /twork/changes/R__bad

echo "== deploy --json always prints a document"
ok "$(run deploy --json)" 0 "nothing to deploy"
ok "$(has '"changes":[]')" yes "an empty changes list"
ok "$(json_ok)" yes "valid JSON (no log lines on stdout)"

echo "== verify all reports the error and fails the run"
mk 004_t4 'CREATE TABLE app.t4 (id int);' "DO \$\$ BEGIN IF to_regclass('app.t4') IS NULL THEN RAISE EXCEPTION 'missing t4'; END IF; END \$\$;" 'DROP TABLE app.t4;'
ok "$(run deploy)" 0 "deploys"
q "DROP TABLE app.t4;" >/dev/null
ok "$(run verify all --json)" 1 "verify all exits 1 on a failure"
ok "$(has 'missing t4')" yes "the error is in the JSON"
ok "$(has '"error":')" yes "as the error field"
q "CREATE TABLE app.t4 (id int);" >/dev/null
ok "$(run verify all --json)" 0 "and 0 once it verifies"

echo "== a deploy failure records the real error"
mk 005_boom 'SELECT 1/0;' 'SELECT 1;' 'SELECT 1;'
ok "$(run deploy --json)" 1 "deploy exits 1"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE change_id = '005_boom' AND status = 'failure' AND message LIKE '%division by zero%';")" 1 "event_log has psql's error"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE change_id = '005_boom' AND status = 'failure' AND duration_ms < 60000;")" 1 "duration is in milliseconds"
ok "$(has '"error":')" yes "the JSON row has the error"
rm -rf /twork/changes/005_boom

echo "== baseline skips dropped and danger_ changes"
mk 005_danger_x 'DROP TABLE app.t1;' 'SELECT 1;' 'SELECT 1;'
mk 006_gone 'CREATE TABLE app.t6 (id int);' 'SELECT 1;' 'DROP TABLE app.t6;' '{"status": "dropped", "dropped_reason": "no"}'
ok "$(run baseline 006_gone)" 0 "baseline exits 0"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('005_danger_x', '006_gone');")" 0 "neither is recorded"
rm -rf /twork/changes/005_danger_x /twork/changes/006_gone

echo "== revertLast has a deployment id; revert.sql edits are caught"
mk 005_t7 'CREATE TABLE app.t7 (id int);' 'SELECT 1;' 'DROP TABLE app.t7;'
ok "$(run deploy)" 0 "deploys"
printf 'DROP TABLE app.t7; -- edited\n' > /twork/changes/005_t7/revert.sql
cfg block
ok "$(run revertLast)" 1 "an edited revert.sql is refused (checksum_policy=block)"
ok "$(has 'revert.sql')" yes "names revert.sql"
cfg warn
ok "$(run revertLast)" 0 "reverts with policy=warn"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE action = 'revert' AND change_id = '005_t7' AND deploy_id IS NOT NULL;")" 1 "the revert event has a deployment id"

echo "== JSON output is escaped; a string \"false\" is not a no-transaction change"
DMCR_ACTOR="o'brien \"x\"\\y" bash $R -c /tcfg/dmcr.cfg deploy >/dev/null 2>&1
ok "$(run history --json)" 0 "history --json"
ok "$(json_ok)" yes "is valid JSON with quotes and a backslash in the actor"
ok "$(run show config --json)" 0 "show config --json"
ok "$(json_ok)" yes "is valid JSON"
mk 006_t8 'CREATE TABLE app.t8 (id int);' 'SELECT 1;' 'DROP TABLE app.t8;' '{"transaction": "false"}'
ok "$(run deploy)" 0 "deploys"
ok "$(has 'OUTSIDE a transaction')" no "inside a transaction (the string is not false)"

echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
