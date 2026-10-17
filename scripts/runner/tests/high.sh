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
reg_before="$(q "SELECT string_agg(change_id, ',' ORDER BY change_id) FROM dmcr.change_log;")"
ok "$(run revert to @v2 --dry-run)" 0 "revert to @v2 --dry-run"
ok "$(q "SELECT string_agg(change_id, ',' ORDER BY change_id) FROM dmcr.change_log;")" "$reg_before" "the dry run reverts nothing"
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
ok "$(run verify R__items_view)" 0 "verify <R__ id> finds the repeatable in repeatable_log"
ok "$(run verify R__never_applied)" 1 "verify <R__ id> never applied is refused"

echo "== repair --mark-applied records the ticket from meta.json"
mkdir -p /work/changes/095_danger_drop_legacy
printf 'ALTER TABLE public.no_such_table DROP COLUMN legacy;\n' > /work/changes/095_danger_drop_legacy/deploy.sql
printf '{ "change_id": "095_danger_drop_legacy", "ticket": "OPS-9" }\n' > /work/changes/095_danger_drop_legacy/meta.json
ok "$(run repair --mark-applied 095_danger_drop_legacy)" 0 "mark-applied a danger_ change"
ok "$(q "SELECT ticket_id FROM dmcr.change_log WHERE change_id='095_danger_drop_legacy';")" OPS-9 "ticket recorded"
q "DELETE FROM dmcr.change_log WHERE change_id='095_danger_drop_legacy';" >/dev/null
rm -rf /work/changes/095_danger_drop_legacy

echo "== manual-script: one transaction a DBA runs by hand (deploy + registry row + verify)"
q "DROP TABLE IF EXISTS public.ms_items; CREATE TABLE public.ms_items (id int, legacy text);" >/dev/null
MS=/work/changes/096_danger_drop_ms_legacy; mkdir -p $MS
printf 'ALTER TABLE public.ms_items DROP COLUMN legacy;\n' > $MS/deploy.sql
printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '096_danger_drop_ms_legacy') AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ms_items' AND column_name = 'legacy') THEN RAISE EXCEPTION 'legacy still there'; END IF; END \$\$;\n" > $MS/verify.sql
printf 'ALTER TABLE public.ms_items ADD COLUMN legacy text;\n' > $MS/revert.sql
printf '{ "change_id": "096_danger_drop_ms_legacy", "ticket": "OPS-10" }\n' > $MS/meta.json
ok "$(bash $R -c /cfg/dmcr.cfg check --json 2>/dev/null | grep -c 'MANUAL  096_danger_drop_ms_legacy')" 1 "check reports the manual change waiting"
bash $R -c /cfg/dmcr.cfg manual-script 096_danger_drop_ms_legacy > /tmp/ms.sql 2>/dev/null
ok "$?" 0 "manual-script prints the script"
psql "$CONN" -X -q -v ON_ERROR_STOP=1 -f /tmp/ms.sql >/dev/null 2>&1
ok "$?" 0 "the script runs in psql"
ok "$(q "SELECT actor || '|' || ticket_id FROM dmcr.change_log WHERE change_id='096_danger_drop_ms_legacy';")" "postgres (by hand)|OPS-10" "recorded as run by hand, with the ticket"
ok "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='ms_items' AND column_name='legacy';")" 0 "and the change itself is applied"
ok "$(bash $R -c /cfg/dmcr.cfg check --json 2>/dev/null | grep -c 'MANUAL  096')" 0 "check is clean afterwards"
ok "$(run manual-script 096_danger_drop_ms_legacy)" 1 "manual-script refuses an applied change"
q "DELETE FROM dmcr.change_log WHERE change_id='096_danger_drop_ms_legacy'; DROP TABLE public.ms_items;" >/dev/null
rm -rf $MS

echo "== human-mode exit codes"
ok "$(run verify)" 0 "verify exits 0"
ok "$(run verify all)" 0 "verify all exits 0"
ok "$(q "SELECT count(*) FROM dmcr.deploy_lock;")" 0 "no lock left behind"

echo "== verify all: superseded vs failed"
# fresh registry and folder: earlier sections leave pending changes behind
q "DROP SCHEMA dmcr CASCADE; DROP TABLE IF EXISTS public.sup_items, public.sup_other;" >/dev/null
rm -rf /work/changes/*; bash $R -c /cfg/dmcr.cfg init >/dev/null 2>&1
mk 001_sup_items_seed "CREATE TABLE public.sup_items (id int); INSERT INTO public.sup_items VALUES (1), (2);" \
   "DO \$\$ BEGIN IF (SELECT count(*) FROM public.sup_items) <> 2 THEN RAISE EXCEPTION 'expected 2 rows'; END IF; END \$\$;" \
   "DROP TABLE public.sup_items;"
mk 002_sup_items_more "INSERT INTO public.sup_items VALUES (3);" "SELECT 1;" "DELETE FROM public.sup_items WHERE id = 3;"
mk 003_sup_other "CREATE TABLE public.sup_other (id int);" "$(guard 003_sup_other public.sup_other)" "DROP TABLE IF EXISTS public.sup_other;"
ok "$(run deploy)" 0 "deploy 001-003"
echo "== verify (no change id): every change of the last deployment"
ok "$(run verify --json)" 0 "verify checks the last deployment and passes (001 superseded by 002 in the same deploy)"
ok "$(grep -o '"change_id":"[0-9a-z_]*","status":"[a-z]*"' /tmp/out.txt | paste -sd' ' -)" '"change_id":"001_sup_items_seed","status":"superseded" "change_id":"002_sup_items_more","status":"ok" "change_id":"003_sup_other","status":"ok"' "all three changes of that deploy are verified"
ok "$(run verify)" 0 "human mode exits 0"
ok "$(grep -c 'Verifying the last deployment' /tmp/out.txt)" 1 "says it verifies the last deployment"
q "DROP TABLE public.sup_other;" >/dev/null   # drift: a real failure, no later change wrote it
ok "$(run verify)" 1 "verify exits 1 when a change of the last deployment fails"
run verify all --json >/dev/null
ok "$(grep -o '"change_id":"001_sup_items_seed","status":"superseded","superseded_by":\["002_sup_items_more (public.sup_items)"\]' /tmp/out.txt | wc -l)" 1 "seed rewritten by a later change is superseded (names the change and object)"
ok "$(grep -o '"change_id":"003_sup_other","status":"failed"' /tmp/out.txt | wc -l)" 1 "verify broken by drift is still failed"
ok "$(grep -o '"status":"superseded"' /tmp/out.txt | wc -l)" 1 "only one superseded"

echo "== tag list marks a tag whose change was reverted"
ok "$(run tag create t_sup)" 0 "tag 003"
ok "$(run revert 003_sup_other)" 0 "revert 003"
run tag list --json >/dev/null
ok "$(grep -o '"tag_name":"t_sup","change_id":"003_sup_other","created_at":"[^"]*","applied":false' /tmp/out.txt | wc -l)" 1 "tag list: applied=false after revert"

echo "== approvals: [env] approval = required gates deploy and the manual script"
ok "$(run deploy)" 0 "redeploy 003 first (no approval needed yet)"
printf '[dmcr]\nenv = dev\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n\n[dev]\nconn =\napproval = required\napprovers = maria, tester\n' > /cfg/dmcr_appr.cfg
runa() { bash $R -c /cfg/dmcr_appr.cfg "$@" >/tmp/out.txt 2>&1; echo $?; }
q "DROP TABLE IF EXISTS public.ap_items, public.ap_legacy;" >/dev/null
mk 004_ap_items "CREATE TABLE public.ap_items (id int);" "$(guard 004_ap_items public.ap_items)" "DROP TABLE IF EXISTS public.ap_items;" '{ "change_id": "004_ap_items", "created_by": "tester" }'
ok "$(runa deploy)" 1 "deploy of an unapproved change is refused"
ok "$(grep -c 'approval gate' /tmp/out.txt)" 1 "refused by the approval gate"
runa deploy --dry-run --json >/dev/null
ok "$(grep -c 'is not approved for dev' /tmp/out.txt)" 1 "dry run reports the missing approval"
ok "$(runa approve 004_ap_items)" 1 "the DBA who created it cannot approve it (self_approval = block)"
ok "$(runa approve 004_ap_items --by bob)" 1 "a name outside approvers cannot approve"
ok "$(runa approve 004_ap_items --by maria --note 'CAB 12')" 0 "an approver approves it"
ok "$(q "SELECT approved_by || '|' || note FROM dmcr.approval WHERE change_id='004_ap_items' AND environment='dev';")" "maria|CAB 12" "approval recorded with the note"
printf "COMMENT ON TABLE public.ap_items IS 'edited';\n" >> /work/changes/004_ap_items/deploy.sql
ok "$(runa deploy)" 1 "files edited after the approval: refused again"
ok "$(grep -c 'changed since maria approved it' /tmp/out.txt)" 1 "names who approved the old files"
runa approvals --json >/dev/null
ok "$(grep -c '"state":"stale"' /tmp/out.txt)" 1 "approvals shows it stale"
ok "$(runa approve 004_ap_items --by maria)" 0 "re-approved"
ok "$(runa deploy)" 0 "approved change deploys"
ok "$(q "SELECT to_regclass('public.ap_items') IS NOT NULL;")" t "and is applied"
ok "$(runa approve 004_ap_items --by maria --revoke)" 1 "an applied change has no approval to revoke"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE action = 'approve' AND change_id = '004_ap_items';")" 2 "each approval is in the event log"
q "CREATE TABLE public.ap_legacy (id int, old text);" >/dev/null
mk 005_danger_ap_drop_old "ALTER TABLE public.ap_legacy DROP COLUMN old;" "SELECT 1;" "ALTER TABLE public.ap_legacy ADD COLUMN old text;" '{ "change_id": "005_danger_ap_drop_old", "created_by": "tester" }'
bash $R -c /cfg/dmcr_appr.cfg manual-script 005_danger_ap_drop_old > /tmp/ap.sql 2>/dev/null
ok "$(grep -c 'NOT APPROVED yet' /tmp/ap.sql)" 1 "the manual script says it is not approved"
psql "$CONN" -X -q -v ON_ERROR_STOP=1 -f /tmp/ap.sql >/dev/null 2>&1
ok "$([[ $? -ne 0 ]] && echo 1 || echo 0)" 1 "and refuses to run in psql"
ok "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='ap_legacy' AND column_name='old';")" 1 "nothing was dropped"
ok "$(runa approve 005_danger_ap_drop_old --by maria)" 0 "approve the danger change"
bash $R -c /cfg/dmcr_appr.cfg manual-script 005_danger_ap_drop_old > /tmp/ap.sql 2>/dev/null
psql "$CONN" -X -q -v ON_ERROR_STOP=1 -f /tmp/ap.sql >/dev/null 2>&1
ok "$?" 0 "the approved script runs"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id='005_danger_ap_drop_old';")" 1 "and is recorded"

echo "== requires: a change applied earlier in the same deploy run counts"
q "DROP TABLE IF EXISTS public.rq_items;" >/dev/null
# a repeatable in the registry: its record is the last line the run's registry cache starts with
mk R__rq_view "CREATE OR REPLACE VIEW public.rq_view AS SELECT 1 AS one;" "SELECT 1;" "DROP VIEW IF EXISTS public.rq_view;"
ok "$(run deploy)" 0 "repeatable applied first"
mk 006_rq_items "CREATE TABLE public.rq_items (id int);" "$(guard 006_rq_items public.rq_items)" "DROP TABLE IF EXISTS public.rq_items;"
mk 007_rq_items_note "ALTER TABLE public.rq_items ADD COLUMN note text;" "SELECT 1;" "ALTER TABLE public.rq_items DROP COLUMN IF EXISTS note;" '{ "change_id": "007_rq_items_note", "requires": ["006_rq_items"] }'
mk 008_rq_items_more "ALTER TABLE public.rq_items ADD COLUMN more text;" "SELECT 1;" "ALTER TABLE public.rq_items DROP COLUMN IF EXISTS more;" '{ "change_id": "008_rq_items_more", "requires": ["007_rq_items_note", "006_rq_items"] }'
ok "$(run deploy)" 0 "one deploy applies 006, then 007 and 008 that require it"; show
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('006_rq_items', '007_rq_items_note', '008_rq_items_more');")" 3 "all three recorded"
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
