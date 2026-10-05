#!/usr/bin/env bash
# Tests for `dmcr test` (round-trip test) in dmcr.sh — runs inside the postgres:16 test container.
set -u
R=/runner/dmcr.sh
CONN="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
export DMCR_CONN="$CONN" DMCR_BASE_DIR=/twork DMCR_DANGER_RULES=/tcfg/dmcr_danger.json DMCR_ACTOR=tester
PASS=0; FAIL=0
q() { psql "$CONN" -X -t -A -c "$1" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); fi; }
run() { bash $R -c /tcfg/dmcr.cfg "$@" >/tmp/tout.txt 2>&1; echo $?; }
out() { sed 's/\x1b\[[0-9;]*m//g' /tmp/tout.txt; }
mk() { mkdir -p "/twork/changes/$1"; printf '%s\n' "$2" > "/twork/changes/$1/deploy.sql"; printf '%s\n' "$3" > "/twork/changes/$1/verify.sql"; printf '%s\n' "$4" > "/twork/changes/$1/revert.sql"; [[ -n "${5:-}" ]] && printf '%s\n' "$5" > "/twork/changes/$1/meta.json"; true; }
guard_col() { cat <<EOF
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='$1') <> EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='$2' AND table_name='$3' AND column_name='$4')
  THEN RAISE EXCEPTION 'column $2.$3.$4 does not match registry state'; END IF;
END \$\$;
EOF
}
fingerprint() { q "SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type, ',' ORDER BY 1)) FROM information_schema.columns WHERE table_schema='app';"; }

q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE;" >/dev/null
q "CREATE SCHEMA app; CREATE TABLE app.orders (id int PRIMARY KEY, status text); INSERT INTO app.orders SELECT g, CASE WHEN g <= 10 THEN 'old' END FROM generate_series(1, 5000) g;" >/dev/null
rm -rf /twork /tcfg; mkdir -p /twork/changes /tcfg
printf '[dmcr]\nenv = staging\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n\n[staging]\nconn =\n' > /tcfg/dmcr.cfg
echo '{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' > /tcfg/dmcr_danger.json
bash $R -c /tcfg/dmcr.cfg init >/dev/null 2>&1

echo "== a correct change round-trips"
mk 001_add_note "ALTER TABLE app.orders ADD COLUMN note text; UPDATE app.orders SET note = 'n' WHERE id < 100;" "$(guard_col 001_add_note app orders note)" "ALTER TABLE app.orders DROP COLUMN note;"
before="$(fingerprint)"
ok "$(run test)" 0 "dmcr test passes"
ok "$(out | grep -c 'restored exactly')" 1 "reports schema and data restored"
ok "$(fingerprint)" "$before" "database schema unchanged afterwards"
ok "$(q "SELECT count(*) FROM dmcr.change_log;")" 0 "registry unchanged afterwards"

echo "== a revert that loses data is caught"
mk 002_backfill "UPDATE app.orders SET status = 'new' WHERE status IS NULL;" "SELECT 1;" "UPDATE app.orders SET status = NULL WHERE status IN ('new', 'old');"
ok "$(run test)" 1 "dmcr test fails"
ok "$(out | grep -c 'data in app.orders is not the same after revert')" 1 "names the table whose data was not restored"
ok "$(q "SELECT count(*) FROM app.orders WHERE status = 'old';")" 10 "real data untouched"
printf '%s\n' "UPDATE app.orders SET status = NULL WHERE status = 'new';" > /twork/changes/002_backfill/revert.sql
ok "$(run test)" 0 "fixed revert passes"

echo "== a revert that leaves an object behind is caught"
mk 003_idx "CREATE INDEX ix_orders_status ON app.orders(status);" "SELECT 1;" "SELECT 1; -- forgot DROP INDEX"
ok "$(run test)" 1 "dmcr test fails"
ok "$(out | grep -c 'left behind by revert: index app.ix_orders_status')" 1 "names the index revert forgot"
ok "$(q "SELECT to_regclass('app.ix_orders_status') IS NULL;")" t "no index left in the database"
printf '%s\n' "DROP INDEX app.ix_orders_status;" > /twork/changes/003_idx/revert.sql

echo "== verify.sql must pass in both states"
mk 004_bad_verify "ALTER TABLE app.orders ADD COLUMN flag boolean;" "DO \$\$ BEGIN RAISE EXCEPTION 'verify always fails'; END \$\$;" "ALTER TABLE app.orders DROP COLUMN flag;"
ok "$(run test)" 1 "failing verify fails the test"
ok "$(out | grep -c 'verify always fails')" 1 "reports the verify error"
ok "$(out | grep -c '001_add_note — deploy, verify, revert and verify passed')" 1 "earlier changes still reported as passing"
rm -rf /twork/changes/004_bad_verify

echo "== a revert that fails outright is caught"
mk 004_broken_revert "ALTER TABLE app.orders ADD COLUMN flag boolean;" "SELECT 1;" "ALTER TABLE app.orders DROP COLUMN no_such_column;"
ok "$(run test)" 1 "failing revert fails the test"
ok "$(out | grep -c 'no_such_column')" 1 "reports the revert error"
rm -rf /twork/changes/004_broken_revert

echo "== --json; CONCURRENTLY index changes are tested in the transaction; stopping at changes that can't be rolled back"
mk 004_concurrent "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_id2 ON app.orders(id);" "SELECT 1;" "DROP INDEX CONCURRENTLY IF EXISTS app.ix_orders_id2;" '{"transaction": false}'
mk 005_vacuum "VACUUM app.orders;" "SELECT 1;" "SELECT 1;" '{"transaction": false}'
mk 006_after "ALTER TABLE app.orders ADD COLUMN later int;" "SELECT 1;" "ALTER TABLE app.orders DROP COLUMN later;"
bash $R -c /tcfg/dmcr.cfg test --json > /tmp/t.json 2>/dev/null; rc=$?
ok "$rc" 0 "everything testable passes"
ok "$(perl -MJSON::PP -0777 -ne 'my $j = decode_json($_); print join(",", map { "$_->{change_id}:$_->{status}" } @{$j->{changes}}), "|", $j->{stopped_at}{change_id}' /tmp/t.json)" "001_add_note:pass,002_backfill:pass,003_idx:pass,004_concurrent:pass|005_vacuum" "CONCURRENTLY index tested, stops at VACUUM"
ok "$(perl -MJSON::PP -0777 -ne 'my ($c) = grep { $_->{change_id} eq "004_concurrent" } @{decode_json($_)->{changes}}; print $c->{details} =~ /tested without CONCURRENTLY/ ? 1 : 0' /tmp/t.json)" 1 "says it was tested without CONCURRENTLY"
ok "$(perl -MJSON::PP -0777 -ne 'print decode_json($_)->{status}' /tmp/t.json)" passed "overall status"

echo "== --to limits the test"
rm -rf /twork/changes/004_concurrent /twork/changes/005_vacuum; mv /twork/changes/006_after /twork/changes/004_after   # keep numbering gap-free
ok "$(run test --to 002_backfill)" 0 "test --to"
ok "$(out | grep -c '003_idx')" 0 "stopped at the --to target"

echo "== safety: production needs --allow-prod; applied changes are skipped"
sed -i 's/^env = staging/env = prod/; s/^\[staging\]/[prod]/' /tcfg/dmcr.cfg
ok "$(run test)" 1 "refuses an environment named prod"
ok "$(out | grep -c 'allow-prod')" 1 "explains --allow-prod"
sed -i 's/^env = prod/env = staging/; s/^\[prod\]/[staging]/' /tcfg/dmcr.cfg
ok "$(run deploy --to 001_add_note)" 0 "deploy 001 for real"
ok "$(run test)" 0 "test skips applied changes"
ok "$(out | grep -c '001_add_note')" 0 "001 not tested again"
ok "$(q "SELECT count(*) FROM dmcr.change_log;")" 1 "only the real deploy is recorded"

echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
