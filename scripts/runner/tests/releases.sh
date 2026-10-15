#!/usr/bin/env bash
# Tests for releases, projects and change kinds in dmcr.sh (releases.json, meta.json project/kind/
# requested_by/created_by/status, deploy --release/--project, revert --project/--release/--kind,
# release list/show). Same scenarios as releases.ps1.
#
# The scenario: zp_lookup_data has 100 rows. Project A adds 20 rows and fills custom1/custom2 on 10 rows;
# project B adds 20 rows and fills custom7/custom8 on 10 rows. All of it runs in ST (dmcrtest).
# Project A is then not going, so prod (dmcrprod, promote_from = test, out_of_order = block) gets only
# project B; A follows in a later release. In ST each kind of project change is rolled back on its own.
set -u
R=/runner/dmcr.sh
ST="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
PROD="postgresql://postgres:dmcrtest@localhost:5432/dmcrprod"
unset DMCR_CONN DMCR_PROMOTE_FROM_CONN
export DMCR_BASE_DIR=/rwork DMCR_DANGER_RULES=/rcfg/dmcr_danger.json DMCR_ACTOR=tester
C=/rwork/changes
PASS=0; FAIL=0
q() { psql "$1" -X -t -A -c "$2" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); fi; }
run() { bash $R -c /rcfg/dmcr.cfg "$@" >/tmp/rout.txt 2>/tmp/rerr.txt; echo $?; }
has() { cat /tmp/rout.txt /tmp/rerr.txt | sed 's/\x1b\[[0-9;]*m//g' | grep -cF -- "$1"; }
# jq-free JSON reads: perl over the last stdout
jp() { perl -MJSON::PP -0777 -e 'my $j = decode_json(<STDIN>); my $code = shift; local $_ = $j; print eval($code) // ""; print STDERR $@ if $@;' "$1" < /tmp/rout.txt; }
applied() { q "$1" "SELECT coalesce(string_agg(change_id, ',' ORDER BY change_id), '') FROM dmcr.change_log;"; }
rows() { q "$1" "SELECT count(*) FROM app.zp_lookup_data;"; }
# verify.sql: the rows/values must exist exactly when the change is recorded as applied
guard() { printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='%s') <> (%s) THEN RAISE EXCEPTION '%s does not match the registry'; END IF; END \$\$;" "$1" "$2" "$1"; }
mk() {  # id deploy verify revert [meta]
    mkdir -p "$C/$1"
    printf '%s\n' "$2" > "$C/$1/deploy.sql"; printf '%s\n' "$3" > "$C/$1/verify.sql"; printf '%s\n' "$4" > "$C/$1/revert.sql"
    [[ -n "${5:-}" ]] && printf '%s\n' "$5" > "$C/$1/meta.json"
    return 0
}
catalog() {  # A's release, A's status
cat > "$C/releases.json" <<EOF
{
  "releases": [
    { "id": "2026-06-01", "name": "Baseline", "date": "2026-06-01", "status": "deployed" },
    { "id": "2026-07-10", "name": "July", "date": "2026-07-10", "status": "planned" },
    { "id": "2026-08-11", "name": "August", "date": "2026-08-11", "status": "planned" }
  ],
  "projects": [
    { "id": "BASE", "name": "Lookup table", "type": "new", "release": "2026-06-01", "status": "active" },
    { "id": "PRJ-A", "name": "Zapier A", "type": "new", "release": "$1", "status": "$2", "dropped_reason": "not going in July" },
    { "id": "PRJ-B", "name": "Zapier B", "type": "cr", "release": "2026-07-10", "status": "active" }
  ]
}
EOF
}
COLS6="('project_id','project_type','release_id','change_kind','requested_by','created_by')"

q "$ST" "DROP DATABASE IF EXISTS dmcrprod;" >/dev/null
q "$ST" "CREATE DATABASE dmcrprod;" >/dev/null
q "$ST" "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;" >/dev/null
q "$PROD" "CREATE SCHEMA app;" >/dev/null
rm -rf /rwork /rcfg; mkdir -p "$C" /rcfg
printf '[dmcr]\nenv = test\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n\n[test]\nconn = %s\n\n[prod]\nconn = %s\npromote_from = test\nout_of_order = block\n' "$ST" "$PROD" > /rcfg/dmcr.cfg
echo '{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' > /rcfg/dmcr_danger.json
run init >/dev/null; run init --env prod >/dev/null
ok "$(q "$ST" "SELECT count(*) FROM information_schema.columns WHERE table_schema='dmcr' AND table_name='change_log' AND column_name IN $COLS6;")" 6 "init creates the project/release/people columns"

echo "== registry upgrade: an old registry gets the new columns"
q "$ST" "ALTER TABLE dmcr.change_log DROP COLUMN project_id, DROP COLUMN project_type, DROP COLUMN release_id, DROP COLUMN change_kind, DROP COLUMN requested_by, DROP COLUMN created_by;" >/dev/null
ok "$(run status)" 0 "status on an old registry"
ok "$(has 'Registry upgraded to v1.2.0')" 1 "reports the upgrade"
ok "$(q "$ST" "SELECT count(*) FROM information_schema.columns WHERE table_schema='dmcr' AND table_name='change_log' AND column_name IN $COLS6;")" 6 "columns added"

echo "== ST: baseline 100 rows, then project A and B (inserts and custom column updates)"
catalog 2026-07-10 active
mk 001_zp_lookup_data "CREATE TABLE app.zp_lookup_data (id int PRIMARY KEY, code text NOT NULL, custom1 text, custom2 text, custom3 text, custom4 text, custom5 text, custom6 text, custom7 text, custom8 text);
INSERT INTO app.zp_lookup_data(id, code) SELECT g, 'C' || g FROM generate_series(1, 100) g;" "$(guard 001_zp_lookup_data "to_regclass('app.zp_lookup_data') IS NOT NULL")" 'DROP TABLE app.zp_lookup_data;' '{"project":"BASE","requested_by":"dev.base","created_by":"dba.one"}'
mk 002_a_insert_20 "INSERT INTO app.zp_lookup_data(id, code) SELECT g, 'A' || g FROM generate_series(101, 120) g;" "$(guard 002_a_insert_20 "(SELECT count(*) FROM app.zp_lookup_data WHERE id BETWEEN 101 AND 120) = 20")" 'DELETE FROM app.zp_lookup_data WHERE id BETWEEN 101 AND 120;' '{"project":"PRJ-A","requested_by":"dev.alice","created_by":"dba.one","created_at":"2026-06-20"}'
mk 003_b_insert_20 "INSERT INTO app.zp_lookup_data(id, code) SELECT g, 'B' || g FROM generate_series(121, 140) g;" "$(guard 003_b_insert_20 "(SELECT count(*) FROM app.zp_lookup_data WHERE id BETWEEN 121 AND 140) = 20")" 'DELETE FROM app.zp_lookup_data WHERE id BETWEEN 121 AND 140;' '{"project":"PRJ-B","requested_by":"dev.bob","created_by":"dba.two"}'
mk 004_a_update_custom "UPDATE app.zp_lookup_data SET custom1 = 'a1', custom2 = 'a2' WHERE id BETWEEN 1 AND 10;" "$(guard 004_a_update_custom "(SELECT count(*) FROM app.zp_lookup_data WHERE custom1 = 'a1') = 10")" 'UPDATE app.zp_lookup_data SET custom1 = NULL, custom2 = NULL WHERE id BETWEEN 1 AND 10;' '{"project":"PRJ-A","requested_by":"dev.alice","created_by":"dba.one"}'
mk 005_b_update_custom78 "UPDATE app.zp_lookup_data SET custom7 = 'b7', custom8 = 'b8' WHERE id BETWEEN 11 AND 20;" "$(guard 005_b_update_custom78 "(SELECT count(*) FROM app.zp_lookup_data WHERE custom7 = 'b7') = 10")" 'UPDATE app.zp_lookup_data SET custom7 = NULL, custom8 = NULL WHERE id BETWEEN 11 AND 20;' '{"project":"PRJ-B","requested_by":"dev.bob","created_by":"dba.two"}'
ok "$(run check)" 0 "check passes"
ok "$(has 'All preflight checks passed')" 1 "no preflight issues"
run status --json >/dev/null
k() { jp "join '', map { \$_->{$2} // '' } grep { \$_->{change_id} eq '$1' } @\$_"; }
ok "$(k 002_a_insert_20 kind)" insert "kind inferred: insert"
ok "$(k 004_a_update_custom kind)" update "kind inferred: update"
ok "$(k 001_zp_lookup_data kind)" ddl "kind inferred: ddl (CREATE TABLE + seed)"
ok "$(k 003_b_insert_20 release)" 2026-07-10 "release comes from the project"
ok "$(k 003_b_insert_20 project_type)" cr "project type"
ok "$(run deploy)" 0 "deploy everything to ST"
ok "$(applied "$ST")" "001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom,005_b_update_custom78" "ST has 001-005"
ok "$(rows "$ST")" 140 "ST has 140 rows"
ok "$(q "$ST" "SELECT project_id || '|' || release_id || '|' || change_kind || '|' || requested_by || '|' || created_by || '|' || project_type FROM dmcr.change_log WHERE change_id = '005_b_update_custom78';")" "PRJ-B|2026-07-10|update|dev.bob|dba.two|cr" "registry records project, release, kind, requested_by, created_by"
run history --json >/dev/null
ok "$(k 002_a_insert_20 requested_by)" dev.alice "history --json carries requested_by"

echo "== prod: project A is not going, only project B is deployed"
catalog 2026-07-10 dropped
ok "$(run deploy --env prod --release 2026-06-01 --dry-run --json)" 0 "dry run of the baseline release"
ok "$(jp 'scalar @{ $_->{dropped} }')" 0 "the baseline dry run lists no dropped changes (project A is in July)"
ok "$(run deploy --env prod --release 2026-06-01)" 0 "deploy the baseline release to prod"
ok "$(has 'project PRJ-A dropped')" 0 "the baseline deploy does not report July changes as dropped"
ok "$(run deploy --env prod --release 2026-07-10 --dry-run --json)" 0 "dry run of the July release"
ok "$(jp 'join ",", map { $_->{change_id} } @{ $_->{changes} }')" "003_b_insert_20,005_b_update_custom78" "July plan holds only project B"
ok "$(jp 'join ",", map { $_->{change_id} } @{ $_->{dropped} }')" "002_a_insert_20,004_a_update_custom" "dry run lists the dropped project A changes"
ok "$(run deploy --env prod --release 2026-07-10)" 0 "deploy the July release to prod"
ok "$(has '002_a_insert_20 — project PRJ-A not going: not going in July')" 1 "A is skipped as not going, with the reason"
ok "$(applied "$PROD")" "001_zp_lookup_data,003_b_insert_20,005_b_update_custom78" "prod has 001, 003, 005"
ok "$(rows "$PROD")" 120 "prod has 100 + 20 B rows"
ok "$(q "$PROD" "SELECT count(*) FILTER (WHERE custom7 = 'b7') || '/' || count(*) FILTER (WHERE custom1 IS NOT NULL) FROM app.zp_lookup_data;")" "10/0" "custom7/8 set on 10 rows, custom1 untouched"
ok "$(run deploy --env prod)" 0 "an unscoped prod deploy also skips the dropped project"
ok "$(applied "$PROD")" "001_zp_lookup_data,003_b_insert_20,005_b_update_custom78" "prod unchanged"
ok "$(run status --env prod)" 0 "status on prod"
ok "$(grep 'NOT GOING' /tmp/rout.txt | grep -c 002_a_insert_20)" 1 "status shows the dropped project A change as NOT GOING, not PENDING"

echo "== project A comes back in the August release"
catalog 2026-08-11 active
ok "$(run deploy --env prod)" 1 "an unscoped prod deploy refuses A out of order"
ok "$(has '002_a_insert_20 is out of order')" 1 "names the out-of-order change"
ok "$(run release list --env prod --json)" 0 "release list on prod"
ok "$(jp 'join "", map { "$_->{applied}/$_->{total}/$_->{pending}" } grep { $_->{release} eq "2026-07-10" } @{ $_->{releases} }')" "2/2/0" "July: 2 of 2 applied in prod"
ok "$(jp 'join "", map { "$_->{applied}/$_->{total}/$_->{pending}" } grep { $_->{release} eq "2026-08-11" } @{ $_->{releases} }')" "0/2/2" "August: 2 pending in prod"
ok "$(run deploy --env prod --release 2026-08-11)" 0 "deploy the August release: A goes out after B"
ok "$(applied "$PROD")" "001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom,005_b_update_custom78" "prod has everything"
ok "$(rows "$PROD")" 140 "prod has 140 rows"
ok "$(q "$PROD" "SELECT release_id FROM dmcr.change_log WHERE change_id = '002_a_insert_20';")" 2026-08-11 "prod records the release A went out in"
ok "$(run release show 2026-08-11 --env prod --json)" 0 "release show"
ok "$(jp 'join ",", map { "$_->{change_id}:$_->{status}:$_->{requested_by}" } @{ $_->{changes} }')" "002_a_insert_20:applied:dev.alice,004_a_update_custom:applied:dev.alice" "release show lists status and requester"

echo "== ST rollbacks after a Sev1 (each kind of project change on its own)"
ok "$(run revert --project PRJ-B --kind update)" 0 "2. project B updates only"
ok "$(applied "$ST")" "001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom" "005 reverted"
ok "$(q "$ST" "SELECT count(*) FROM app.zp_lookup_data WHERE custom7 IS NOT NULL OR custom8 IS NOT NULL;")" 0 "custom7/8 cleared"
ok "$(q "$ST" "SELECT count(*) FROM app.zp_lookup_data WHERE custom1 = 'a1';")" 10 "project A updates kept"
ok "$(run deploy)" 0 "redeploy"
ok "$(run revert --project PRJ-B --kind insert)" 0 "3. project B inserts only (not the latest change)"
ok "$(has '004_a_update_custom (applied later, outside the scope) also writes app.zp_lookup_data')" 1 "warns that a later A change writes the same table"
ok "$(applied "$ST")" "001_zp_lookup_data,002_a_insert_20,004_a_update_custom,005_b_update_custom78" "003 reverted, the rest kept"
ok "$(rows "$ST")" 120 "B rows gone"
ok "$(run deploy)" 0 "redeploy"
ok "$(run revert --project PRJ-A --kind insert)" 0 "4. project A inserts only"
ok "$(q "$ST" "SELECT count(*) FROM app.zp_lookup_data WHERE id BETWEEN 101 AND 120;")" 0 "A rows gone"
ok "$(rows "$ST")" 120 "B rows kept"
ok "$(run deploy)" 0 "redeploy"
ok "$(run revert --project PRJ-A --kind update)" 0 "5. project A updates only"
ok "$(q "$ST" "SELECT count(*) FILTER (WHERE custom1 IS NOT NULL) || '/' || count(*) FILTER (WHERE custom7 = 'b7') FROM app.zp_lookup_data;")" "0/10" "custom1/2 cleared, custom7/8 kept"
ok "$(run deploy)" 0 "redeploy"
ok "$(run revert --project PRJ-B --dry-run --json)" 0 "1. project B completely: dry run"
ok "$(jp '$_->{status} . ":" . join ",", map { $_->{change_id} } @{ $_->{changes} }')" "dry_run:003_b_insert_20,005_b_update_custom78" "dry run lists B newest first"
ok "$(applied "$ST")" "001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom,005_b_update_custom78" "dry run reverted nothing"
ok "$(run revert --project PRJ-B)" 0 "1. project B completely"
ok "$(applied "$ST")" "001_zp_lookup_data,002_a_insert_20,004_a_update_custom" "only A and the baseline remain"
ok "$(q "$ST" "SELECT count(*) || '/' || count(*) FILTER (WHERE custom1 = 'a1') || '/' || count(*) FILTER (WHERE custom7 IS NOT NULL) FROM app.zp_lookup_data;")" "120/10/0" "120 rows, A updates kept, no B values"
ok "$(run deploy)" 0 "redeploy B"

echo "== scoped revert refuses what later changes build on"
mk 006_b_add_custom9 'ALTER TABLE app.zp_lookup_data ADD COLUMN custom9 text;' "$(guard 006_b_add_custom9 "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'zp_lookup_data' AND column_name = 'custom9')")" 'ALTER TABLE app.zp_lookup_data DROP COLUMN custom9;' '{"project":"PRJ-B"}'
mk 007_a_fill_custom9 "UPDATE app.zp_lookup_data SET custom9 = 'a9' WHERE id <= 5;" "$(guard 007_a_fill_custom9 "(SELECT count(*) FROM app.zp_lookup_data WHERE custom9 = 'a9') = 5")" 'UPDATE app.zp_lookup_data SET custom9 = NULL WHERE id <= 5;' '{"project":"PRJ-A","requires":["006_b_add_custom9"]}'
ok "$(run deploy --env prod --project PRJ-A)" 1 "prod refuses A while the B change it requires is not there"
ok "$(has '007_a_fill_custom9 requires 006_b_add_custom9, which is not applied and is not in this deploy (project PRJ-B')" 1 "names the missing requirement"
ok "$(run deploy)" 0 "deploy 006, 007 to ST"
ok "$(run revert --project PRJ-B --kind ddl)" 1 "B DDL revert refused"
ok "$(has '007_a_fill_custom9 (applied later, outside the scope) requires 006_b_add_custom9')" 1 "names the requiring change"
printf '%s\n' '{"project":"PRJ-A"}' > "$C/007_a_fill_custom9/meta.json"
ok "$(run revert --project PRJ-B --kind ddl)" 1 "still refused without requires"
ok "$(has 'uses app.zp_lookup_data, whose structure 006_b_add_custom9 changed')" 1 "structural dependency found from the SQL"
ok "$(q "$ST" "SELECT count(*) FROM dmcr.change_log WHERE change_id = '006_b_add_custom9';")" 1 "006 still applied"
ok "$(run revert --project PRJ-A,PRJ-B --kind ddl,update)" 0 "reverting both together is allowed"
ok "$(applied "$ST")" "001_zp_lookup_data,002_a_insert_20,003_b_insert_20" "updates and DDL of A and B reverted, newest first"

echo "== a single dropped change, unknown projects and kinds"
mk 008_b_extra "INSERT INTO app.zp_lookup_data(id, code) VALUES (999, 'X');" "$(guard 008_b_extra "EXISTS (SELECT 1 FROM app.zp_lookup_data WHERE id = 999)")" 'DELETE FROM app.zp_lookup_data WHERE id = 999;' '{"project":"PRJ-B","status":"dropped","dropped_reason":"not needed"}'
ok "$(run deploy)" 0 "deploy skips the dropped change"
ok "$(has '008_b_extra — change not going: not needed')" 1 "with its reason"
ok "$(q "$ST" "SELECT count(*) FROM dmcr.change_log WHERE change_id = '008_b_extra';")" 0 "008 not applied"
mk 009_bad 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"project":"PRJ-Z","kind":"weird"}'
ok "$(run deploy)" 1 "unknown project / kind block the deploy"
ok "$(has "009_bad: project 'PRJ-Z' is not in releases.json")" 1 "unknown project named"
ok "$(has "009_bad: kind 'weird'")" 1 "unknown kind named"
rm -rf "$C/009_bad"
ok "$(run deploy --release 2099-01-01)" 1 "unknown release refused"
ok "$(has "Unknown release '2099-01-01'")" 1 "names the release"
ok "$(run revert 005_b_update_custom78)" 1 "plain revert still needs the latest change"
ok "$(has 'dmcr revert --project')" 1 "and points to the scoped revert"

echo "== kind inference ignores function bodies"
mk 010_fn 'CREATE OR REPLACE FUNCTION app.touch() RETURNS void LANGUAGE sql AS $$ UPDATE app.zp_lookup_data SET code = code $$;' 'SELECT 1;' 'DROP FUNCTION app.touch();' '{"project":"PRJ-B"}'
mk 011_type "CREATE TYPE app.lookup_pair AS (k text, v text);
CREATE DOMAIN app.code_t AS text CHECK (VALUE <> '');" 'SELECT 1;' 'DROP DOMAIN app.code_t; DROP TYPE app.lookup_pair;' '{"project":"PRJ-B"}'
run status --json --project PRJ-B >/dev/null
ok "$(k 010_fn kind)" function "CREATE FUNCTION with an UPDATE body is a function change"
ok "$(k 011_type kind)" type "CREATE TYPE + DOMAIN is a type change"
ok "$(jp 'scalar grep { $_->{change_id} =~ /^00[12]/ } @$_')" 0 "status --project lists only that project"

echo "== kind inference ignores DMCR's own backup tables (dmcr.bak_*)"
mk 012_bak_update "CREATE TABLE IF NOT EXISTS dmcr.bak_012 AS SELECT code, custom7 FROM app.zp_lookup_data WHERE code = 'L001';
UPDATE app.zp_lookup_data SET custom7 = 'x' WHERE code = 'L001';" 'SELECT 1;' "UPDATE app.zp_lookup_data t SET custom7 = b.custom7 FROM dmcr.bak_012 b WHERE t.code = b.code; DROP TABLE dmcr.bak_012;" '{"project":"PRJ-B"}'
mk 013_bak_insert "CREATE TABLE IF NOT EXISTS dmcr.bak_013 (code text PRIMARY KEY);
INSERT INTO dmcr.bak_013 VALUES ('Z001');
INSERT INTO app.zp_lookup_data (code, name) VALUES ('Z001', 'z');" 'SELECT 1;' "DELETE FROM app.zp_lookup_data WHERE code = 'Z001'; DROP TABLE dmcr.bak_013;" '{"project":"PRJ-B"}'
run status --json --project PRJ-B >/dev/null
ok "$(k 012_bak_update kind)" update "an UPDATE with a dmcr.bak_* backup is an update change"
ok "$(k 013_bak_insert kind)" insert "an INSERT with a dmcr.bak_* record table is an insert change"

echo "== a scoped deploy re-applies only the repeatables in its scope"
mkdir -p $C/R__base_view
printf 'CREATE OR REPLACE VIEW app.v_base AS SELECT 1 AS x;\n' > $C/R__base_view/deploy.sql
printf 'SELECT 1;\n' > $C/R__base_view/verify.sql
printf '{"project":"BASE"}\n' > $C/R__base_view/meta.json
mk 009_noop 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"project":"BASE"}'   # no prefix gap, so real deploys pass pre-flight
rm -rf $C/012_bak_update $C/013_bak_insert   # kind-inference fixtures, not deployable
run deploy --project PRJ-B --dry-run --json >/dev/null
ok "$(jp 'scalar @{$_->{repeatable} // []}')" 0 "dry run --project PRJ-B lists no BASE repeatable"
ok "$(run deploy --project PRJ-B)" 0 "deploy --project PRJ-B succeeds"
ok "$(q "$ST" "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__base_view';")" 0 "deploy --project PRJ-B leaves the BASE repeatable alone"
run deploy --project BASE --dry-run --json >/dev/null
ok "$(jp 'join ",", @{$_->{repeatable} // []}')" R__base_view "dry run --project BASE lists the repeatable it would re-apply"
ok "$(run deploy --project BASE)" 0 "deploy --project BASE succeeds"
ok "$(q "$ST" "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__base_view';")" 1 "deploy --project BASE applies it"

q "$ST" "DROP DATABASE IF EXISTS dmcrprod;" >/dev/null
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
