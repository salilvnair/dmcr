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

echo "== line endings alone are not an edit"
perl -pi -e 's/\r?\n/\r\n/' /twork/changes/006_t8/deploy.sql /twork/changes/006_t8/revert.sql
cfg block
ok "$(run check --json)" 0 "check exits 0"
ok "$(has 'CHECKSUM')" no "CRLF-only change is not reported as edited"
ok "$(run deploy)" 0 "deploy is not blocked by it (checksum_policy=block)"
printf 'CREATE TABLE app.t8 (id int, x int);\n' > /twork/changes/006_t8/deploy.sql
ok "$(run deploy)" 1 "a real edit is still blocked"
printf 'CREATE TABLE app.t8 (id int);\n' > /twork/changes/006_t8/deploy.sql
cfg warn

echo "== a later INSERT does not supersede an earlier table definition"
mk 007_t9 'CREATE TABLE app.t9 (id int, label text);' "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 't9' AND column_name = 'label') THEN RAISE EXCEPTION 'no label column'; END IF; END \$\$;" 'DROP TABLE app.t9;'
mk 008_t9rows 'INSERT INTO app.t9 (id) VALUES (1);' 'SELECT 1;' 'DELETE FROM app.t9 WHERE id = 1;'
ok "$(run deploy)" 0 "deploys"
q "ALTER TABLE app.t9 DROP COLUMN label;" >/dev/null
ok "$(run verify all --json)" 1 "verify all exits 1"
ok "$(has '"change_id":"007_t9","status":"failed"')" yes "the table's own drift is a failure, not superseded"
q "ALTER TABLE app.t9 ADD COLUMN label text;" >/dev/null

echo "== tags and ticket in JSON; tag create logged; repair usage; check graph"
mk 009_tagged 'CREATE TABLE app.t10 (id int);' 'SELECT 1;' 'DROP TABLE app.t10;' '{"tags": ["alpha", "beta"], "ticket": "T-1"}'
ok "$(run status --json)" 0 "status --json"
ok "$(has '"alpha"')" yes "status has the tags"
ok "$(run plan --json)" 0 "plan --json"
ok "$(has '"alpha"')" yes "plan has the tags"
ok "$(has '"T-1"')" yes "plan has the ticket"
ok "$(run deploy)" 0 "deploys"
ok "$(run tag create rel-1 first cut)" 0 "tag create"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE action = 'tag' AND message LIKE '%rel-1%';")" 1 "the tag is in event_log"
ok "$(run tag list --json)" 0 "tag list"
ok "$(has 'first cut')" yes "the whole description is kept"
ok "$(run repair)" 1 "repair without an action exits 1"
ok "$(has 'Usage: dmcr repair')" yes "and shows the usage"
ok "$(run check)" 0 "check exits 0"
ok "$(has 'Dependency graph OK')" yes "check validates the dependency graph"

echo "== a dependency cycle is refused before anything runs"
mk 010_ca 'CREATE TABLE app.ca (id int);' 'SELECT 1;' 'DROP TABLE app.ca;' '{"requires": ["011_cb"]}'
mk 011_cb 'CREATE TABLE app.cb (id int);' 'SELECT 1;' 'DROP TABLE app.cb;' '{"requires": ["010_ca"]}'
ok "$(run deploy)" 1 "deploy refuses"
ok "$(has 'Circular dependency')" yes "names the cycle"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('010_ca', '011_cb');")" 0 "nothing recorded"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "no lock left behind"
rm -rf /twork/changes/010_ca /twork/changes/011_cb

echo "== a change recorded as applied without running it verifies without its backup"
NB_V="DO \$\$ BEGIN IF to_regclass('dmcr.bak_010_nobak') IS NULL THEN RAISE EXCEPTION 'backup table dmcr.bak_010_nobak is missing'; END IF; IF NOT EXISTS (SELECT 1 FROM app.t1 WHERE id = 1 AND note = 'nb') THEN RAISE EXCEPTION 'note not set'; END IF; END \$\$;"
mk 010_nobak "CREATE TABLE dmcr.bak_010_nobak AS SELECT * FROM app.t1 WHERE id = 1; UPDATE app.t1 SET note = 'nb' WHERE id = 1;" "$NB_V" "UPDATE app.t1 SET note = b.note FROM dmcr.bak_010_nobak b WHERE app.t1.id = b.id; DROP TABLE dmcr.bak_010_nobak;"
q "UPDATE app.t1 SET note = 'nb' WHERE id = 1;" >/dev/null
ok "$(run repair --mark-applied 010_nobak)" 0 "recorded as applied (the SQL ran by hand)"
ok "$(run verify all --json)" 0 "verify all exits 0"
ok "$(has '"status":"no_backup"')" yes "it is no_backup, not failed"
ok "$(json_ok)" yes "verify all --json is JSON"
ok "$(run verify 010_nobak --json)" 0 "verify of that change exits 0"
ok "$(has '"status":"no_backup"')" yes "and says no_backup"
ok "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'dmcr' AND tablename = 'bak_010_nobak';")" 0 "the stand-in backup table is not left behind"
q "UPDATE app.t1 SET note = 'other' WHERE id = 1;" >/dev/null
ok "$(run verify all --json)" 1 "a real failure behind the missing backup still fails"
ok "$(has '"status":"failed"')" yes "reported as failed"
q "UPDATE app.t1 SET note = 'nb' WHERE id = 1;" >/dev/null
mk 011_bakdep "CREATE TABLE dmcr.bak_011_bakdep AS SELECT 1 AS x;" "DO \$\$ BEGIN IF to_regclass('dmcr.bak_011_bakdep') IS NULL THEN RAISE EXCEPTION 'backup table dmcr.bak_011_bakdep is missing'; END IF; END \$\$;" "DROP TABLE dmcr.bak_011_bakdep;"
ok "$(run deploy)" 0 "a change DMCR deploys"
q "DROP TABLE dmcr.bak_011_bakdep;" >/dev/null
ok "$(run verify all --json)" 1 "losing its backup is a failure"
ok "$(has '"status":"no_backup"')" yes "(the hand-run one is still no_backup)"
q "CREATE TABLE dmcr.bak_011_bakdep AS SELECT 1 AS x;" >/dev/null

echo "== a change kept to some environments is skipped everywhere else"
mk 012_envonly 'CREATE TABLE app.only_test (id int);' 'SELECT 1;' 'DROP TABLE app.only_test;' '{"environments": ["test"]}'
ok "$(run deploy --json)" 0 "deploy on staging exits 0"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id = '012_envonly';")" 0 "not applied on staging"
ok "$(q "SELECT to_regclass('app.only_test') IS NULL;")" t "its table is not there"
ok "$(run status --json)" 0 "status"
ok "$(has '"elsewhere":true')" yes "status marks it elsewhere"
ok "$(run status)" 0 "status (text)"
ok "$(has 'NOT FOR STAGING')" yes "and says not for staging"
mk 013_needsenv 'CREATE TABLE app.needs_test (id int);' 'SELECT 1;' 'DROP TABLE app.needs_test;' '{"requires": ["012_envonly"]}'
ok "$(run deploy)" 1 "a change that needs it is refused here"
ok "$(has 'never goes to staging')" yes "and says why"
rm -rf /twork/changes/013_needsenv
printf '{"environments": ["test", "Staging"]}\n' > /twork/changes/012_envonly/meta.json
ok "$(run deploy)" 0 "once staging is listed (any case) it deploys"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id = '012_envonly';")" 1 "applied on staging"

echo "== a hand-run change whose verify reads its backup's columns"
mk 013_nobakcols "CREATE TABLE dmcr.bak_013_nobakcols AS SELECT id, note FROM app.t1 WHERE id = 1; UPDATE app.t1 SET note = 'cols' WHERE id = 1;" "DO \$\$ BEGIN IF to_regclass('dmcr.bak_013_nobakcols') IS NULL THEN RAISE EXCEPTION 'backup table dmcr.bak_013_nobakcols is missing'; END IF; IF EXISTS (SELECT 1 FROM dmcr.bak_013_nobakcols b WHERE NOT EXISTS (SELECT 1 FROM app.t1 t WHERE t.id = b.id AND t.note = 'cols')) THEN RAISE EXCEPTION 'not updated'; END IF; END \$\$;" "UPDATE app.t1 SET note = b.note FROM dmcr.bak_013_nobakcols b WHERE app.t1.id = b.id; DROP TABLE dmcr.bak_013_nobakcols;"
q "UPDATE app.t1 SET note = 'cols' WHERE id = 1;" >/dev/null
ok "$(run repair --mark-applied 013_nobakcols)" 0 "recorded as applied"
ok "$(run verify 013_nobakcols --json)" 0 "verifies with the backup deploy.sql would make"
ok "$(has '"status":"no_backup"')" yes "no_backup"
ok "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'dmcr' AND tablename = 'bak_013_nobakcols';")" 0 "the stand-in is rolled back"

echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
