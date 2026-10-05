#!/usr/bin/env bash
# High-severity fix tests for dmcr.sh (run inside postgres:16 container; no jq installed).
set -u
R=/runner/dmcr.sh
CONN="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
export DMCR_CONN="$CONN" DMCR_BASE_DIR=/work DMCR_DANGER_RULES=/cfg/dmcr_danger.json DMCR_ACTOR=tester
PASS=0; FAIL=0
q() { psql "$CONN" -X -t -A -c "$1" 2>&1; }
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); else echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1)); fi; }
run() { bash $R -c /cfg/dmcr.cfg "$@" >/tmp/out.txt 2>&1; echo $?; }
show() { sed 's/\x1b\[[0-9;]*m//g' /tmp/out.txt | grep -E "✗|BLOCKED|requires|rolled back|does not match" | head -3 | sed 's/^/        /'; }

q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP TABLE IF EXISTS public.fk_items, public.widgets, public.gadgets, public.verify_side_effect, public.r_items CASCADE; DROP VIEW IF EXISTS public.v_items;" >/dev/null
rm -rf /work /cfg; mkdir -p /work/changes /cfg
printf '[dmcr]\nenv = dev\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n\n[dev]\nconn =\n' > /cfg/dmcr.cfg
cat > /cfg/dmcr_danger.json <<'EOF'
{ "deployOnlyPatterns": [ { "label": "DROP TABLE", "regex": "(?i)\\bDROP\\s+TABLE\\b", "scope": "deployOnly" },
                          { "label": "GRANT ALL", "regex": "(?i)\\bGRANT\\s+ALL\\b", "scope": "deployOnly" } ],
  "alwaysPatterns": [ { "label": "TRUNCATE", "regex": "(?i)\\bTRUNCATE\\b", "scope": "always" } ],
  "deleteWithoutWhereEnabled": true, "updateWithoutWhereEnabled": false }
EOF

guard() { # id table  -> DMCR-guard verify (applied => exists, reverted => gone)
cat <<EOF
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '$1') THEN
    IF to_regclass('$2') IS NULL THEN RAISE EXCEPTION 'applied but $2 missing'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '$1') THEN
    IF to_regclass('$2') IS NOT NULL THEN RAISE EXCEPTION 'reverted but $2 still exists'; END IF;
  END IF;
END \$\$;
EOF
}
mk() { mkdir -p "/work/changes/$1"; printf '%s\n' "$2" > "/work/changes/$1/deploy.sql"; printf '%s\n' "$3" > "/work/changes/$1/verify.sql"; printf '%s\n' "$4" > "/work/changes/$1/revert.sql"; [[ -n "${5:-}" ]] && printf '%s\n' "$5" > "/work/changes/$1/meta.json"; true; }

bash $R -c /cfg/dmcr.cfg init >/dev/null 2>&1
echo "== verify inside the deploy transaction"
mk 001_create_widgets "CREATE TABLE public.widgets (id int);" "$(guard 001_create_widgets public.widgets)
CREATE TABLE public.verify_side_effect (x int);" "DROP TABLE public.widgets;"
ok "$(run deploy)" 0 "deploy 001 (guard verify) succeeds"
ok "$(q "SELECT to_regclass('public.verify_side_effect') IS NULL;")" t "verify side effects are rolled back (savepoint)"
mk 002_bad_verify "CREATE TABLE public.gadgets (id int);" "DO \$\$ BEGIN RAISE EXCEPTION 'verify says no'; END \$\$;" "DROP TABLE public.gadgets;"
ok "$(run deploy)" 1 "deploy with failing verify exits 1"; show
ok "$(q "SELECT to_regclass('public.gadgets') IS NULL;")" t "failing verify rolled back deploy.sql (gadgets not created)"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id='002_bad_verify';")" 0 "no registry row for 002"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "lock released after failure"
rm -rf /work/changes/002_bad_verify

echo "== transaction-control guard"
mk 002_commit_inside "CREATE TABLE public.gadgets (id int); COMMIT;" "SELECT 1;" "DROP TABLE public.gadgets;"
ok "$(run deploy)" 1 "COMMIT inside deploy.sql is blocked"; show
mv /work/changes/002_commit_inside /tmp/x1
mk 002_psql_meta "\\c otherdb
CREATE TABLE public.gadgets (id int);" "SELECT 1;" "DROP TABLE public.gadgets;"
ok "$(run deploy)" 1 "psql \\c meta-command is blocked"; show
rm -rf /work/changes/002_psql_meta /tmp/x1
mk 002_create_gadgets "-- don't worry: plpgsql BEGIN/END and ROLLBACK TO are fine
CREATE TABLE public.gadgets (id int);
DO \$fn\$ BEGIN PERFORM 1; END \$fn\$;
SAVEPOINT s1; INSERT INTO public.gadgets VALUES (1); ROLLBACK TO SAVEPOINT s1;" "$(guard 002_create_gadgets public.gadgets)" "DROP TABLE public.gadgets;"
ok "$(run deploy)" 0 "DO \$fn\$ BEGIN…END and ROLLBACK TO SAVEPOINT are allowed"

echo "== requires enforcement"
mk 003_needs_missing "SELECT 1;" "SELECT 1;" "SELECT 1;" '{"requires":["004_later"]}'
mk 004_later "SELECT 1;" "SELECT 1;" "SELECT 1;"
ok "$(run deploy)" 1 "change requiring a not-yet-applied change fails"; show
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('003_needs_missing','004_later');")" 0 "nothing applied out of order"
rm -rf /work/changes/003_needs_missing /work/changes/004_later

echo "== --to validation"
ok "$(run deploy --to 999_nope)" 1 "unknown --to target is rejected"; show

echo "== danger rules (custom regex from JSON, per-statement DELETE check, no jq)"
command -v jq >/dev/null && echo "  (note: jq IS installed)" || echo "  (jq not installed)"
mk 003_grant_all "GRANT ALL ON public.widgets TO PUBLIC;" "SELECT 1;" "SELECT 1;"
ok "$(run deploy)" 1 "custom rule 'GRANT ALL' from dmcr_danger.json blocks"; show
rm -rf /work/changes/003_grant_all
mk 003_delete_mixed "DELETE FROM public.widgets WHERE id = 1; DELETE FROM public.widgets;" "SELECT 1;" "SELECT 1;"
ok "$(run deploy)" 1 "second DELETE without WHERE is caught per statement"; show
rm -rf /work/changes/003_delete_mixed
mk 003_fk_cascade "CREATE TABLE public.fk_items (id int PRIMARY KEY, w int REFERENCES public.fk_items(id) ON DELETE CASCADE); GRANT DELETE ON public.fk_items TO PUBLIC; REVOKE DELETE ON public.fk_items FROM PUBLIC; INSERT INTO public.fk_items VALUES (1, NULL) ON CONFLICT (id) DO UPDATE SET w = NULL;" "$(guard 003_fk_cascade public.fk_items)" "REVOKE ALL ON public.fk_items FROM PUBLIC; DROP TABLE public.fk_items;"
ok "$(run deploy)" 0 "ON DELETE CASCADE, GRANT/REVOKE DELETE and DO UPDATE SET are not deletes"; show
ok "$(run revert 003_fk_cascade)" 0 "its revert (REVOKE … FROM) runs too"; show
rm -rf /work/changes/003_fk_cascade
mk 003_add_col "ALTER TABLE public.widgets ADD COLUMN name text;" "SELECT 1;" "ALTER TABLE public.widgets DROP COLUMN name;" '{"requires":["001_create_widgets"],"ticket":"ZAP-1"}'
ok "$(run deploy)" 0 "valid change with satisfied requires deploys"
ok "$(q "SELECT ticket_id FROM dmcr.change_log WHERE change_id='003_add_col';")" ZAP-1 "ticket read from meta.json without jq"

echo "== revert inside one transaction"
ok "$(run tag create v2)" 0 "tag v2 at 003"
mk 004_create_r "CREATE TABLE public.r_items (id int);" "$(guard 004_create_r public.r_items)" "DROP TABLE public.r_items;"
mk 005_bad_revert "CREATE VIEW public.v_items AS SELECT 1 AS x;" "$(guard 005_bad_revert public.v_items)" "SELECT 1; -- forgets to drop the view"
ok "$(run deploy)" 0 "deploy 004, 005"
ok "$(run revertLast)" 1 "revert whose verify fails exits 1"; show
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id='005_bad_revert';")" 1 "failed revert rolled back: 005 still applied"
printf 'DROP VIEW public.v_items;\n' > /work/changes/005_bad_revert/revert.sql
ok "$(run repair --checksums)" 0 "human-mode repair exits 0"
ok "$(run revertLast)" 0 "fixed revert succeeds (verify passes inside tx)"
ok "$(q "SELECT to_regclass('public.v_items') IS NULL;")" t "view dropped"

echo "== revert to @tag keeps the tagged change"
ok "$(run revert to @v2)" 0 "revert to @v2"
ok "$(q "SELECT string_agg(change_id, ',' ORDER BY change_id) FROM dmcr.change_log;")" "001_create_widgets,002_create_gadgets,003_add_col" "state is exactly the tag (003 kept)"
ok "$(run revert to 003_add_col)" 0 "revert to <id> still includes the target"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id='003_add_col';")" 0 "003 reverted"

echo "== repeatable: failed verify does not record checksum"
mkdir -p /work/changes/R__items_view
printf 'CREATE OR REPLACE VIEW public.v_items AS SELECT 2 AS x;\n' > /work/changes/R__items_view/deploy.sql
printf "DO \$\$ BEGIN RAISE EXCEPTION 'nope'; END \$\$;\n" > /work/changes/R__items_view/verify.sql
run repeatable >/dev/null
ok "$(q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__items_view';")" 0 "checksum not recorded"
ok "$(q "SELECT to_regclass('public.v_items') IS NULL;")" t "repeatable deploy.sql rolled back"
printf 'SELECT 1;\n' > /work/changes/R__items_view/verify.sql
ok "$(run repeatable)" 0 "repeatable with passing verify (human mode exits 0)"
ok "$(q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__items_view';")" 1 "checksum recorded"

echo "== human-mode exit codes"
ok "$(run verify)" 0 "verify exits 0"
ok "$(run verify all)" 0 "verify all exits 0"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "no lock left behind"
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
