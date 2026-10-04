#!/usr/bin/env bash
# Production-style rehearsal for dmcr.sh (runs inside the postgres:16 test container).
# Real data volumes, a dependency chain, a failing change in the middle of a batch, a lock
# held by "the application", two deploys racing, tags and revert, drift, repeatables and
# CREATE INDEX CONCURRENTLY.
set -u
R=/runner/dmcr.sh
CONN="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
export DMCR_CONN="$CONN" DMCR_BASE_DIR=/rwork DMCR_DANGER_RULES=/rcfg/dmcr_danger.json DMCR_ACTOR=rehearsal
PASS=0; FAIL=0
q() { psql "$CONN" -X -t -A -c "$1" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); fi; }
run() { bash $R -c /rcfg/dmcr.cfg "$@" >/tmp/rout.txt 2>&1; echo $?; }
out_has() { sed 's/\x1b\[[0-9;]*m//g' /tmp/rout.txt | grep -q "$1" && echo yes || echo no; }
show() { sed 's/\x1b\[[0-9;]*m//g' /tmp/rout.txt | grep -E "✗|BLOCKED|ERROR|lock|mismatch|changed" | head -3 | sed 's/^/        /'; }
mk() { # id deploy verify revert [meta]
  mkdir -p "/rwork/changes/$1"
  printf '%s\n' "$2" > "/rwork/changes/$1/deploy.sql"; printf '%s\n' "$3" > "/rwork/changes/$1/verify.sql"
  printf '%s\n' "$4" > "/rwork/changes/$1/revert.sql"; [[ -n "${5:-}" ]] && printf '%s\n' "$5" > "/rwork/changes/$1/meta.json"; true
}
applied() { q "SELECT count(*) FROM dmcr.change_log WHERE change_id='$1';"; }
# verify guard: when applied the object must exist, when reverted it must not
guard_col() { cat <<EOF
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='$1') <> EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='$2' AND table_name='$3' AND column_name='$4')
  THEN RAISE EXCEPTION 'column $2.$3.$4 does not match registry state'; END IF;
END \$\$;
EOF
}
guard_rel() { cat <<EOF
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='$1') <> (to_regclass('$2') IS NOT NULL)
  THEN RAISE EXCEPTION '$2 does not match registry state'; END IF;
END \$\$;
EOF
}

echo "== setup: app schema with 200k customers and 500k orders"
q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE;" >/dev/null
q "CREATE SCHEMA app;
   CREATE TABLE app.customers (id bigserial PRIMARY KEY, email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
   INSERT INTO app.customers(email) SELECT 'user'||g||'@example.com' FROM generate_series(1,200000) g;
   CREATE TABLE app.orders (id bigserial PRIMARY KEY, customer_id bigint NOT NULL REFERENCES app.customers(id), amount numeric(10,2) NOT NULL, status text);
   INSERT INTO app.orders(customer_id, amount) SELECT 1 + (g % 200000), (g % 997) / 10.0 FROM generate_series(1,500000) g;
   ANALYZE app.customers; ANALYZE app.orders;" >/dev/null
ok "$(q "SELECT count(*) FROM app.orders;")" 500000 "seeded 500k orders"
rm -rf /rwork /rcfg; mkdir -p /rwork/changes /rcfg
printf '[dmcr]\nenv = staging\nchanges_dir = changes\nlock_timeout = 3s\nstatement_timeout = 2min\nchecksum_policy = block\n\n[staging]\nconn =\n' > /rcfg/dmcr.cfg
cat > /rcfg/dmcr_danger.json <<'EOF'
{ "deployOnlyPatterns": [ { "label": "DROP TABLE", "regex": "(?i)\\bDROP\\s+TABLE\\b", "scope": "deployOnly" } ],
  "alwaysPatterns": [ { "label": "TRUNCATE", "regex": "(?i)\\bTRUNCATE\\b", "scope": "always" } ],
  "deleteWithoutWhereEnabled": true, "updateWithoutWhereEnabled": true }
EOF
ok "$(run init)" 0 "init registry"

echo "== a release of five changes with a dependency chain"
mk 001_orders_note "ALTER TABLE app.orders ADD COLUMN note text;" "$(guard_col 001_orders_note app orders note)" "ALTER TABLE app.orders DROP COLUMN note;"
mk 002_idx_orders_customer "CREATE INDEX idx_orders_customer ON app.orders(customer_id);" "$(guard_rel 002_idx_orders_customer app.idx_orders_customer)" "DROP INDEX app.idx_orders_customer;"
mk 003_view_customer_totals "CREATE VIEW app.customer_totals AS SELECT customer_id, sum(amount) AS total FROM app.orders GROUP BY customer_id;" "$(guard_rel 003_view_customer_totals app.customer_totals)" "DROP VIEW app.customer_totals;" '{"requires":["002_idx_orders_customer"]}'
mk 004_backfill_status "UPDATE app.orders SET status = 'new' WHERE status IS NULL;" "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='004_backfill_status') AND EXISTS (SELECT 1 FROM app.orders WHERE status IS NULL) THEN RAISE EXCEPTION 'unbackfilled rows'; END IF; END \$\$;" "UPDATE app.orders SET status = NULL WHERE status = 'new';"
mk 005_customer_tier "ALTER TABLE app.customers ADD COLUMN tier text NOT NULL DEFAULT 'basic';" "$(guard_col 005_customer_tier app customers tier)" "ALTER TABLE app.customers DROP COLUMN tier;"
mk 006_broken "ALTER TABLE app.customers ADD COLUMN half_done int;
UPDATE app.customers SET half_done = 1 WHERE id < 10;
SELECT * FROM app.table_that_does_not_exist;" "SELECT 1;" "ALTER TABLE app.customers DROP COLUMN half_done;"
ok "$(run test --to 005_customer_tier)" 0 "dmcr test: 001-005 round-trip on 500k rows before release"
ok "$(out_has '004_backfill_status — deploy, verify, revert and verify passed')" yes "the 500k-row backfill is proven reversible"
ok "$(q "SELECT count(*) FROM app.orders WHERE status IS NOT NULL;")" 0 "nothing kept after the test"
ok "$(run test)" 1 "dmcr test catches the broken 006 before anyone deploys it"
ok "$(out_has 'table_that_does_not_exist')" yes "with the real error"
ok "$(run deploy --to 004_backfill_status)" 0 "deploy up to 004"
ok "$(run tag create v1)" 0 "tag v1 at 004"
ok "$(run deploy)" 1 "rest of the batch, with a failing 6th change, exits 1"; show
ok "$(q "SELECT count(*) FROM dmcr.change_log;")" 5 "the five good changes stay applied"
ok "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='customers' AND column_name='half_done';")" 0 "nothing of the failed change is left (column rolled back)"
ok "$(q "SELECT count(*) FROM app.orders WHERE status IS NULL;")" 0 "backfill applied to all 500k rows"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "deploy lock released after the failure"
mk 006_broken "ALTER TABLE app.customers ADD COLUMN half_done int;" "$(guard_col 006_broken app customers half_done)" "ALTER TABLE app.customers DROP COLUMN half_done;"
ok "$(run deploy)" 0 "fixed change deploys on the next run"
ok "$(applied 006_broken)" 1 "006 applied"

echo "== the application holds a lock: deploy must give up after lock_timeout, not hang"
mk 007_customer_flag "ALTER TABLE app.customers ADD COLUMN flagged boolean;" "$(guard_col 007_customer_flag app customers flagged)" "ALTER TABLE app.customers DROP COLUMN flagged;"
( psql "$CONN" -X -q -c "BEGIN; LOCK TABLE app.customers IN ACCESS SHARE MODE; SELECT pg_sleep(15); COMMIT;" >/dev/null 2>&1 & )
sleep 1
t0=$SECONDS; rc="$(run deploy)"; dt=$(( SECONDS - t0 ))
ok "$rc" 1 "deploy fails while the table is locked"; show
ok "$([[ $dt -lt 12 ]] && echo fast || echo "slow ${dt}s")" fast "it failed after lock_timeout (${dt}s), not after the 15s lock"
ok "$(applied 007_customer_flag)" 0 "nothing recorded for 007"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "deploy lock released"
sleep 15
ok "$(run deploy)" 0 "deploy succeeds once the application lock is gone"

echo "== two deploys racing"
mk 008_slow "SELECT pg_sleep(4); CREATE TABLE app.audit_marker (id int);" "$(guard_rel 008_slow app.audit_marker)" "DROP TABLE app.audit_marker;"
( bash $R -c /rcfg/dmcr.cfg deploy >/tmp/race1.txt 2>&1; echo $? > /tmp/race1.rc ) &
sleep 1
( bash $R -c /rcfg/dmcr.cfg deploy >/tmp/race2.txt 2>&1; echo $? > /tmp/race2.rc ) &
wait
ok "$(( $(cat /tmp/race1.rc) + $(cat /tmp/race2.rc) ))" 1 "exactly one of the two deploys fails"
ok "$(grep -ci 'lock' /tmp/race2.txt | awk '{print ($1>0)?"yes":"no"}')" yes "the loser reports the deploy lock"
ok "$(applied 008_slow)" 1 "008 applied exactly once"

echo "== editing an applied change is caught (checksum_policy = block)"
printf -- '-- edited after release\nALTER TABLE app.orders ADD COLUMN note text;\n' > /rwork/changes/001_orders_note/deploy.sql
ok "$(run deploy)" 1 "deploy refuses while an applied deploy.sql was edited"; show
ok "$(run check --json | tail -1 >/dev/null; bash $R -c /rcfg/dmcr.cfg check --json 2>/dev/null | grep -c '001_orders_note')" 1 "check reports the edited change"
printf '%s\n' "ALTER TABLE app.orders ADD COLUMN note text;" > /rwork/changes/001_orders_note/deploy.sql
ok "$(run deploy)" 0 "restoring the file clears it"
printf '%s\n' "-- edited" "ALTER TABLE app.orders DROP COLUMN note;" > /rwork/changes/001_orders_note/revert.sql
ok "$(run deploy)" 1 "an edited revert.sql is caught too"
ok "$(out_has 'revert.sql')" yes "the message names revert.sql"
sed -i 's/^checksum_policy = block/checksum_policy = repair/' /rcfg/dmcr.cfg
ok "$(run deploy)" 0 "checksum_policy = repair accepts the edit"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE action = 'repair' AND message LIKE '%revert.sql%';")" 1 "and records it in dmcr.event_log"
ok "$(bash $R -c /rcfg/dmcr.cfg check --json 2>/dev/null | grep -c 'CHECKSUM')" 0 "check is clean afterwards"
sed -i 's/^checksum_policy = repair/checksum_policy = block/' /rcfg/dmcr.cfg

echo "== revert to the v1 tag, then roll forward again"
ok "$(run revert to @v1)" 0 "revert to @v1"
ok "$(q "SELECT string_agg(change_id, ',' ORDER BY change_id) FROM dmcr.change_log;")" "001_orders_note,002_idx_orders_customer,003_view_customer_totals,004_backfill_status" "only 001-004 remain applied"
ok "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='customers' AND column_name IN ('tier','half_done','flagged');")" 0 "005-007 columns removed"
ok "$(q "SELECT to_regclass('app.audit_marker') IS NULL;")" t "008 table removed"
ok "$(q "SELECT count(*) FROM app.orders WHERE status = 'new';")" 500000 "v1 data kept"
ok "$(run deploy)" 0 "roll forward"
ok "$(q "SELECT count(*) FROM dmcr.change_log;")" 8 "all eight applied again"
ok "$(run verify all)" 0 "verify all"

echo "== repeatable view"
mkdir -p /rwork/changes/R__order_summary
printf 'CREATE OR REPLACE VIEW app.order_summary AS SELECT status, count(*) AS n FROM app.orders GROUP BY status;\n' > /rwork/changes/R__order_summary/deploy.sql
printf 'SELECT 1 FROM app.order_summary LIMIT 1;\n' > /rwork/changes/R__order_summary/verify.sql
ok "$(run repeatable)" 0 "repeatable applied"
ok "$(q "SELECT count(*) FROM dmcr.repeatable_log;")" 1 "checksum recorded"
c1="$(q "SELECT last_checksum FROM dmcr.repeatable_log;")"
run repeatable >/dev/null
ok "$(q "SELECT last_checksum FROM dmcr.repeatable_log;")" "$c1" "unchanged repeatable is left alone"

echo "== CREATE INDEX CONCURRENTLY on a big table (needs a change that runs outside a transaction)"
mk 009_idx_orders_status_concurrently "CREATE INDEX CONCURRENTLY idx_orders_status ON app.orders(status);" "SELECT 1;" "DROP INDEX CONCURRENTLY app.idx_orders_status;" '{"transaction": false}'
ok "$(run deploy)" 1 "a non-transactional change must be re-runnable (IF NOT EXISTS / IF EXISTS)"
ok "$(out_has 'without IF NOT EXISTS')" yes "names the missing IF NOT EXISTS"
mk 009_idx_orders_status_concurrently "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status ON app.orders(status);" "$(guard_rel 009_idx_orders_status_concurrently app.idx_orders_status)" "DROP INDEX CONCURRENTLY IF EXISTS app.idx_orders_status;" '{"transaction": false}'
ok "$(run deploy)" 0 "concurrent index change deploys"; show
ok "$(q "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('app.idx_orders_status');")" t "index exists and is valid"
ok "$(applied 009_idx_orders_status_concurrently)" 1 "009 recorded"
ok "$(run revertLast)" 0 "revert the concurrent index"
ok "$(q "SELECT to_regclass('app.idx_orders_status') IS NULL;")" t "index dropped"
ok "$(applied 009_idx_orders_status_concurrently)" 0 "009 no longer recorded"

echo "== a non-transactional change that fails is reported, not recorded, and leaves no lock"
mk 010_unique_customer_on_orders "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_unique ON app.orders(customer_id);" "SELECT 1;" "DROP INDEX CONCURRENTLY IF EXISTS app.idx_orders_customer_unique;" '{"transaction": false}'
ok "$(run deploy)" 1 "duplicate values make the concurrent unique index fail"; show
ok "$(applied 010_unique_customer_on_orders)" 0 "010 not recorded"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "deploy lock released"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE change_id='010_unique_customer_on_orders' AND status='failure';")" 1 "failure logged"
ok "$(out_has 'cleaned up with revert.sql')" yes "reports the automatic clean-up"
ok "$(q "SELECT to_regclass('app.idx_orders_customer_unique') IS NULL;")" t "the INVALID index PostgreSQL left behind was dropped by revert.sql"
rm -rf /rwork/changes/010_unique_customer_on_orders

echo "== status --json is machine-readable"
folders=$(ls -d /rwork/changes/[0-9][0-9][0-9]_* | wc -l)
ok "$(bash $R -c /rcfg/dmcr.cfg status --json 2>/dev/null | perl -MJSON::PP -0777 -ne 'my $d = decode_json($_); my @a = ref $d eq "ARRAY" ? @$d : @{$d->{changes} // []}; print scalar(@a), "/", scalar(grep { $_->{status} eq "applied" } @a)')" "$folders/$(q "SELECT count(*) FROM dmcr.change_log;")" "status --json lists every folder and matches the registry"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "no lock left behind"

echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
