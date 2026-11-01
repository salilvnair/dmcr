#!/usr/bin/env bash
# Runner hardening tests for dmcr.sh (run inside the postgres:16 container, like security.sh / high.sh):
# psql meta-commands and transaction control anywhere in a file, change folder names and ids, environment
# filters, danger rules, the environment's schema, credentials and connections, config values, registry
# consistency, temp files and locks. Every shell-execution check proves a marker file is NOT created.
set -u
R=/runner/dmcr.sh
CONN="postgresql://postgres:dmcrtest@localhost:5432/dmcrhard"
ADMIN="postgresql://postgres:dmcrtest@localhost:5432/dmcrtest"
export DMCR_CONN="$CONN" DMCR_BASE_DIR=/hwork DMCR_DANGER_RULES=/hcfg/dmcr_danger.json DMCR_ACTOR=tester
unset DMCR_CONN_ENV DMCR_PLACEHOLDER_SCHEMA DMCR_PROMOTE_FROM_CONN PGPASSWORD PGSSLMODE XDG_RUNTIME_DIR
C=/hwork/changes
PASS=0; FAIL=0
q() { psql "$CONN" -X -t -A -c "$1" 2>&1; }
ok() {
    if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; PASS=$((PASS+1)); return; fi
    echo "  FAIL  $3  (got '$1', want '$2')"; FAIL=$((FAIL+1))
    cat /tmp/hout.txt /tmp/herr.txt 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -E '✗|BLOCKED|ERROR' | head -4 | sed 's/^/        /'
}
# run [cfg] args: exit code; stdout in /tmp/hout.txt, stderr in /tmp/herr.txt
run() { bash $R -c /hcfg/dmcr.cfg "$@" >/tmp/hout.txt 2>/tmp/herr.txt; echo $?; }
runc() { local cfg="$1"; shift; bash $R -c "$cfg" "$@" >/tmp/hout.txt 2>/tmp/herr.txt; echo $?; }
has() { cat /tmp/hout.txt /tmp/herr.txt | sed 's/\x1b\[[0-9;]*m//g' | grep -cF -- "$1"; }
isjson() { perl -MJSON::PP -0777 -ne 'print((eval { decode_json($_); 1 }) ? "valid" : "invalid")' /tmp/hout.txt; }
absent() { [[ -e "$1" ]] && echo created || echo absent; }
mk() {  # id deploy verify revert [meta]
    mkdir -p "$C/$1"
    printf '%s\n' "$2" > "$C/$1/deploy.sql"; printf '%s\n' "$3" > "$C/$1/verify.sql"; printf '%s\n' "$4" > "$C/$1/revert.sql"
    [[ -n "${5:-}" ]] && printf '%s\n' "$5" > "$C/$1/meta.json"
    return 0
}
fresh() {   # empty registry and change folder
    q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS myapp CASCADE; DROP TABLE IF EXISTS public.h_t, public.h_v, public.h_cwd, public.h_amp, public.h_ok, public.h_s CASCADE; DROP VIEW IF EXISTS public.h_rview;" >/dev/null
    rm -rf "$C"; mkdir -p "$C"
    bash $R -c /hcfg/dmcr.cfg init >/dev/null 2>&1
}

psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS dmcrhard;" -c "CREATE DATABASE dmcrhard;" >/dev/null 2>&1
rm -rf /hwork /hcfg /tmp/hm_*; mkdir -p "$C" /hcfg
CFG_HEAD='[dmcr]\nenv = dev\nchanges_dir = changes\nlock_timeout = 5s\nstatement_timeout = 1min\n'
printf "${CFG_HEAD}\n[dev]\nconn =\n" > /hcfg/dmcr.cfg
cat > /hcfg/dmcr_danger.json <<'EOF'
{ "deployOnlyPatterns": [ { "label": "DROP TABLE", "regex": "(?i)\\bDROP\\s+TABLE\\b" } ],
  "alwaysPatterns": [ { "label": "TRUNCATE", "regex": "(?i)\\bTRUNCATE\\b" } ],
  "deleteWithoutWhereEnabled": true, "updateWithoutWhereEnabled": true }
EOF
fresh

echo "== A1: psql meta-commands anywhere on a line are blocked (nothing runs)"
mk 001_mid 'SELECT 1; \! touch /tmp/hm_mid' 'SELECT 1;' 'SELECT 1;'
ok "$(run deploy)" 1 "mid-line \\! is blocked"
ok "$(has "BLOCKED: 001_mid/deploy.sql contains the psql meta-command '\\!'. Change files run inside a transaction and cannot use psql backslash commands.")" 1 "with the meta-command message"
ok "$(absent /tmp/hm_mid)" absent "the shell command did not run"
rm -rf "$C/001_mid"
mk 001_bt 'SELECT 1; \echo x`touch /tmp/hm_bt`' 'SELECT 1;' 'SELECT 1;'
ok "$(run deploy)" 1 "backticks inside a mid-line \\echo are blocked"
ok "$(absent /tmp/hm_bt)" absent "the backtick command did not run"
rm -rf "$C/001_bt"
mk 001_dollar 'SELECT 1 AS a$x$; \! touch /tmp/hm_dollar
SELECT 2 AS b$x$;' 'SELECT 1;' 'SELECT 1;'
ok "$(run deploy)" 1 "a\$x\$ ... b\$x\$ (identifiers, not a dollar quote) cannot hide a meta-command"
ok "$(absent /tmp/hm_dollar)" absent "the shell command did not run"
rm -rf "$C/001_dollar"
mk 001_estr "SELECT E'\\''; \\! touch /tmp/hm_estr
SELECT 'x';" 'SELECT 1;' 'SELECT 1;'
ok "$(run deploy)" 1 "an E'\\'' string cannot hide a meta-command"
ok "$(absent /tmp/hm_estr)" absent "the shell command did not run"
rm -rf "$C/001_estr"
mk 001_clean "CREATE TABLE public.h_ok (v text); INSERT INTO public.h_ok VALUES (E'a\\\\b'), ('c\\d'), (\$q\$ \\! not a command \$q\$);
-- \\! in a comment is fine
/* \\c in a block comment too */" 'SELECT 1;' 'DROP TABLE public.h_ok;'
ok "$(run deploy)" 0 "backslashes inside strings, dollar quotes and comments are allowed"
ok "$(q "SELECT count(*) FROM public.h_ok;")" 3 "and the change ran"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id LIKE '001_%' AND change_id <> '001_clean';")" 0 "no blocked change was recorded"

echo "== A2: transaction control"
mk 002_commit_work 'CREATE TABLE public.h_t (id int); COMMIT WORK;' 'SELECT 1;' 'DROP TABLE public.h_t;'
ok "$(run deploy)" 1 "COMMIT WORK is blocked"
ok "$(has "BLOCKED: 002_commit_work/deploy.sql contains COMMIT.")" 1 "with the transaction-control message"
rm -rf "$C/002_commit_work"
mk 002_prepare 'CREATE TABLE public.h_t (id int); PREPARE TRANSACTION '"'x'"';' 'SELECT 1;' 'DROP TABLE public.h_t;'
ok "$(run deploy)" 1 "PREPARE TRANSACTION is blocked"
ok "$(has "contains PREPARE TRANSACTION")" 1 "named in the message"
rm -rf "$C/002_prepare"
mk 002_savepoint 'CREATE TABLE public.h_t (id int); SAVEPOINT s1; INSERT INTO public.h_t VALUES (1); ROLLBACK WORK TO SAVEPOINT s1;' 'SELECT 1;' 'DROP TABLE public.h_t;'
ok "$(run deploy)" 0 "ROLLBACK WORK TO SAVEPOINT is allowed"

echo "== A3: verify.sql passes the guard before every verify run"
printf 'SELECT 1; COMMIT;\n' > "$C/002_savepoint/verify.sql"
ok "$(run verify 002_savepoint)" 1 "verify <id> with COMMIT fails"
ok "$(has "BLOCKED: 002_savepoint/verify.sql contains COMMIT")" 1 "with the BLOCKED message"
ok "$(run verify all --json)" 1 "verify all with it fails"
ok "$(isjson)" valid "verify all --json is valid JSON"
ok "$(grep -c '"change_id":"002_savepoint","status":"failed","error":"BLOCKED: 002_savepoint/verify.sql contains COMMIT' /tmp/hout.txt)" 1 "the batch reports it failed with the BLOCKED message"
ok "$(grep -c '"change_id":"001_clean","status":"ok"' /tmp/hout.txt)" 1 "the other change in the batch still verifies (results mapped by position)"
printf 'SELECT 1; \\! touch /tmp/hm_verify\n' > "$C/002_savepoint/verify.sql"
run verify all >/dev/null; run verify >/dev/null; run verify 002_savepoint >/dev/null
ok "$(absent /tmp/hm_verify)" absent "verify, verify all and verify <id> never ran a meta-command from verify.sql"
printf 'SELECT 1;\n' > "$C/002_savepoint/verify.sql"
ok "$(run verify all)" 0 "verify all passes again"

echo "== A4: parse uses the same guard"
ok "$(run parse 'SELECT 1 \g')" 0 "parse exits 0"
ok "$(grep -c '"ok":false.*psql meta-command' /tmp/hout.txt)" 1 "a trailing \\g is refused"
run parse 'SELECT 1; \! touch /tmp/hm_parse' >/dev/null
ok "$(grep -c '"ok":false' /tmp/hout.txt)" 1 "a mid-line \\! is refused"
ok "$(absent /tmp/hm_parse)" absent "and did not run"
run parse 'SELECT 1; COMMIT AND CHAIN' >/dev/null
ok "$(grep -c '"ok":false,"msg":"SQL contains COMMIT which would escape' /tmp/hout.txt)" 1 "COMMIT AND CHAIN is refused"

echo "== A5: the cleanup after a failed non-transactional deploy passes the revert guards first"
mk 003_notx 'CREATE INDEX CONCURRENTLY IF NOT EXISTS h_nx ON public.no_such_table (id);' 'SELECT 1;' 'DROP INDEX CONCURRENTLY IF EXISTS h_nx; \! touch /tmp/hm_cleanup' '{"transaction": false}'
ok "$(run deploy)" 1 "the failing non-transactional deploy exits 1"
ok "$(has "CLEANUP NOT RUN")" 1 "the blocked revert.sql is not run"
ok "$(has "may be partially applied")" 1 "the change is reported as partially applied"
ok "$(absent /tmp/hm_cleanup)" absent "the meta-command in revert.sql did not run"
rm -rf "$C/003_notx"

echo "== A6 / B1: unsafe change folder names are never run or listed"
# (a folder name has no '/': the commands would touch a marker in the current directory, /tmp/hmk)
mkdir -p /tmp/hmk; rm -f /tmp/hmk/*; cd /tmp/hmk || exit 1
mk "003_bt\`touch hm_fold1\`" 'SELECT 1;' 'SELECT 1;' 'SELECT 1;'
mk '004_x$(touch hm_fold2)' 'SELECT 1;' 'SELECT 1;' 'SELECT 1;'
mk "R__v\`touch hm_fold3\`" 'SELECT 1;' 'SELECT 1;' 'SELECT 1;'
ok "$(run deploy)" 1 "deploy is blocked"
ok "$(has "BLOCKED: unsafe change folder name '003_bt\`touch hm_fold1\`': use letters, digits, '_', '.' and '-' only (like 001_add_orders)")" 1 "naming the folder"
ok "$(run deploy --dry-run --json)" 1 "deploy --dry-run is blocked"
ok "$(run check)" 1 "check is blocked"
ok "$(run plan --json)" 1 "plan is blocked"
ok "$(run status --json)" 0 "status still runs"
ok "$(isjson)" valid "status --json is valid JSON"
ok "$(grep -c 'hm_fold' /tmp/hout.txt)" 0 "and does not list the unsafe folders"
ok "$(grep -c "Skipping unsafe change folder name '003_bt" /tmp/herr.txt)" 1 "it warns once on stderr"
run verify all >/dev/null; run repeatable >/dev/null; run test >/dev/null; run diff >/dev/null
ok "$(ls /tmp/hmk | wc -l)" 0 "no command ran a folder name through the shell (no marker in /tmp/hmk)"
rm -rf "$C"/003_bt* "$C"/004_x* "$C"/R__v*; cd / || exit 1

echo "== B2: change ids from the command line"
for cmd in "show ../x" "diff ../x" "manual-script ../x" "verify ../x" "revert ../x" "repair --mark-applied ../x" "approve ../x" "test --to ../x" "test --only 001_clean,../x" "revert to ../x"; do
    # shellcheck disable=SC2086
    ok "$(run $cmd)" 1 "$cmd is refused"
done
run show ../x >/dev/null
ok "$(has "Not a change id: '../x'")" 1 "with: Not a change id"

echo "== B3: requires entries never reach shell arithmetic"
mk 003_req 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"requires":["x$(touch /tmp/hm_b3)", "a[$(touch /tmp/hm_b3b)]"]}'
run plan --json >/dev/null; run check >/dev/null; run deploy >/dev/null
ok "$(absent /tmp/hm_b3)$(absent /tmp/hm_b3b)" absentabsent "plan, check and deploy ran nothing from requires"
rm -rf "$C/003_req"

echo "== C1: repeatables honour meta.json environments / dropped without --release/--project"
printf "${CFG_HEAD}\n[prod]\nconn =\nsslmode = disable\n\n[test]\nconn =\n" | sed 's/^env = dev/env = prod/' > /hcfg/prod.cfg
fresh
mk R__h_view 'CREATE OR REPLACE VIEW public.h_rview AS SELECT 1 AS one;' 'SELECT 1;' 'DROP VIEW IF EXISTS public.h_rview;' '{"environments":["test"]}'
ok "$(runc /hcfg/prod.cfg deploy)" 0 "a plain deploy on prod"
ok "$(q "SELECT to_regclass('public.h_rview') IS NULL;")" t "does not apply an R__ only for test"
ok "$(has "R__h_view — only for test, not prod")" 1 "and logs the skip"
ok "$(runc /hcfg/prod.cfg repeatable)" 0 "the repeatable command on prod"
ok "$(q "SELECT to_regclass('public.h_rview') IS NULL;")" t "does not apply it either"
ok "$(runc /hcfg/prod.cfg deploy --dry-run --json)" 0 "deploy --dry-run"
ok "$(grep -c 'R__h_view' /tmp/hout.txt)" 0 "does not list it"
printf '{"status":"dropped","dropped_reason":"replaced"}\n' > "$C/R__h_view/meta.json"
ok "$(run deploy)" 0 "a plain deploy on dev"
ok "$(q "SELECT to_regclass('public.h_rview') IS NULL;")" t "does not apply a dropped R__"
rm -rf "$C/R__h_view"

echo "== C2: the round-trip test leaves out dropped and not-for-this-environment changes"
mk 006_dropped 'SELECT 1/0;' 'SELECT 1;' 'SELECT 1;' '{"status":"dropped","dropped_reason":"not needed"}'
mk 007_elsewhere 'SELECT 1/0;' 'SELECT 1;' 'SELECT 1;' '{"environments":["prod"]}'
mk 008_ok 'CREATE TABLE public.h_t (id int);' 'SELECT 1;' 'DROP TABLE public.h_t;'
ok "$(run test --json)" 0 "dmcr test passes"
ok "$(isjson)" valid "test --json is valid JSON"
ok "$(grep -c '006_dropped\|007_elsewhere' /tmp/hout.txt)" 0 "the dropped and elsewhere changes are not tested"
ok "$(grep -c '006_dropped — change not going: not needed' /tmp/herr.txt)" 1 "a skip line for the dropped change"
ok "$(grep -c '007_elsewhere — only for prod, not dev' /tmp/herr.txt)" 1 "a skip line for the change only for prod"

echo "== C3: manual-script and repair --mark-applied refuse a change that does not go here"
mk 009_danger_drop 'DROP TABLE public.nothing;' 'SELECT 1;' 'SELECT 1;' '{"status":"dropped","dropped_reason":"not needed"}'
ok "$(run manual-script 009_danger_drop)" 1 "manual-script refuses a dropped change"
ok "$(has "BLOCKED: 009_danger_drop is not going (change not going: not needed)")" 1 "with the not going message"
ok "$(run repair --mark-applied 007_elsewhere)" 1 "mark-applied refuses a change only for prod"
ok "$(has "BLOCKED: 007_elsewhere is not for dev (only for prod, not dev)")" 1 "with the not for message"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('007_elsewhere', '009_danger_drop');")" 0 "nothing recorded"
rm -rf "$C/006_dropped" "$C/007_elsewhere" "$C/009_danger_drop"

echo "== D1: a dmcr_danger.json in the current directory is ignored"
mkdir -p /tmp/hcwd
printf '{ "alwaysPatterns": [ { "label": "CWD RULE", "regex": "(?i)\\\\bCREATE\\\\b" } ] }\n' > /tmp/hcwd/dmcr_danger.json
ok "$( (cd /tmp/hcwd && env -u DMCR_DANGER_RULES bash $R -c /hcfg/dmcr.cfg deploy >/tmp/hout.txt 2>/tmp/herr.txt); echo $?)" 0 "deploy from that directory runs"
ok "$(has "CWD RULE")" 0 "the current directory's rule was not used"

echo "== D2: a danger rule that runs too long fails closed"
cat > /hcfg/slow.json <<'EOF'
{ "deployOnlyPatterns": [ { "label": "slow", "regex": "^(\\w+\\w+)+\\1\\W\\d" } ] }
EOF
mk 009_slow "$(printf 'x%.0s' $(seq 1 34))!!" 'SELECT 1;' 'SELECT 1;'   # about 2^34 steps without the limit
t0=$SECONDS
ok "$(DMCR_DANGER_RULES=/hcfg/slow.json timeout 120 bash $R -c /hcfg/dmcr.cfg deploy >/tmp/hout.txt 2>/tmp/herr.txt; echo $?)" 1 "the deploy is blocked"
ok "$(has "blocked: rule slow timed out")" 1 "the rule timed out and counts as a match"
ok "$(( SECONDS - t0 < 30 ))" 1 "within the time limit ($(( SECONDS - t0 ))s)"
ok "$(for p in /proc/[0-9]*; do tr '\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done | grep -c 'my \$pid = fork')" 0 "no regex process is left running"
rm -rf "$C/009_slow"

echo "== E1 / E2: the environment's schema is lowercased and must exist"
printf "${CFG_HEAD}\n[dev]\nconn =\nschema = MyApp\n" > /hcfg/schema.cfg
q "DROP SCHEMA IF EXISTS myapp CASCADE;" >/dev/null
ok "$(runc /hcfg/schema.cfg status)" 1 "status refuses a missing schema"
ok "$(has "Schema 'MyApp' lowercased to 'myapp' (PostgreSQL folds unquoted names)")" 1 "warns that the schema is lowercased"
ok "$(has "Schema 'myapp' does not exist on dev. Run dmcr init (DMCR Web: Set up in DMCR Config).")" 1 "says the schema does not exist"
ok "$(runc /hcfg/schema.cfg init)" 0 "init"
ok "$(q "SELECT (to_regnamespace('myapp') IS NOT NULL)::text || '|' || (SELECT count(*) FROM pg_namespace WHERE nspname = 'MyApp');")" "true|0" "creates the lowercase schema"
mk 009_schema 'CREATE TABLE ${schema}.h_s (id int); CREATE TABLE h_s2 (id int);' 'SELECT 1;' 'DROP TABLE ${schema}.h_s; DROP TABLE h_s2;'
ok "$(runc /hcfg/schema.cfg deploy)" 0 "deploy with \${schema} and with no schema"
ok "$(q "SELECT (to_regclass('myapp.h_s') IS NOT NULL)::text || '|' || (to_regclass('myapp.h_s2') IS NOT NULL)::text;")" "true|true" "both tables are in myapp"
ok "$(runc /hcfg/schema.cfg revertLast)" 0 "and revert"
rm -rf "$C/009_schema"

echo "== E3: every session uses standard_conforming_strings = on"
mk 009_scs "DO \$\$ BEGIN IF current_setting('standard_conforming_strings') <> 'on' THEN RAISE EXCEPTION 'scs is off'; END IF; END \$\$;" 'SELECT 1;' 'SELECT 1;'
ok "$(PGOPTIONS='-c standard_conforming_strings=off' run deploy)" 0 "on even when the caller's PGOPTIONS turns it off"

echo "== E4: two environments must not share one database"
printf "${CFG_HEAD}\n[dev]\nconn =\n\n[qa]\nconn =\n" > /hcfg/two.cfg
mk 010_two 'SELECT 1;' 'SELECT 1;' 'SELECT 1;'
ok "$(runc /hcfg/two.cfg deploy --env qa)" 1 "deploy to qa on dev's database is refused"
ok "$(has "BLOCKED: this database's DMCR registry already has changes recorded for environment 'dev'. Two environments must not share one database: point 'qa' at its own database.")" 1 "with the shared-registry message"
ok "$(runc /hcfg/two.cfg revertLast --env qa)" 1 "revert on qa is refused"
ok "$(runc /hcfg/two.cfg baseline 010_two --env qa)" 1 "baseline on qa is refused"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE environment = 'qa';")" 0 "nothing was recorded for qa"
ok "$(runc /hcfg/two.cfg deploy)" 0 "dev itself still deploys"

echo "== F1 / F2: passwords out of the URL query and an empty user; PGPASSWORD reaches psql only"
IP="$(hostname -i | awk '{print $1}')"
psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS dmcrhpw;" -c "DROP ROLE IF EXISTS h_user;" -c "CREATE ROLE h_user LOGIN PASSWORD 'q&p=ss w0rd';" -c "CREATE DATABASE dmcrhpw OWNER h_user;" >/dev/null 2>&1
mkdir -p /tmp/hfake
cat > /tmp/hfake/psql-spy <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> /tmp/h-argv.log
printf 'psql %s %s\n' "${PGPASSWORD:+PW}" "${PGSSLMODE:+SSL=$PGSSLMODE}" >> /tmp/h-env.log
exec /usr/bin/psql "$@"
EOF
for b in perl find sha256sum shasum; do
    printf '#!/bin/bash\n[[ -n "${PGPASSWORD:-}" ]] && echo "%s" >> /tmp/h-leak.log\nexec /usr/bin/%s "$@"\n' "$b" "$b" > "/tmp/hfake/$b"
done
printf '#!/bin/bash\n[[ -n "${PGPASSWORD:-}" ]] && echo git >> /tmp/h-leak.log\nexit 1\n' > /tmp/hfake/git
chmod +x /tmp/hfake/*
: > /tmp/h-argv.log; : > /tmp/h-env.log; : > /tmp/h-leak.log
mkdir -p /hwork2/changes/001_pw
printf 'CREATE TABLE public.h_pw (id int);\n' > /hwork2/changes/001_pw/deploy.sql; printf 'SELECT 1;\n' > /hwork2/changes/001_pw/verify.sql; printf 'DROP TABLE public.h_pw;\n' > /hwork2/changes/001_pw/revert.sql
printf "${CFG_HEAD}\n[dev]\nconn =\n" > /hcfg/pw.cfg
pwrun() { env PATH="/tmp/hfake:$PATH" DMCR_PSQL=/tmp/hfake/psql-spy DMCR_BASE_DIR=/hwork2 bash $R -c /hcfg/pw.cfg "$@" >/tmp/hout.txt 2>/tmp/herr.txt; echo $?; }
ok "$(DMCR_CONN="postgresql://h_user@$IP:5432/dmcrhpw?password=q%26p%3Dss%20w0rd&application_name=dmcr" pwrun init)" 0 "?password= in the URL query authenticates"
ok "$(DMCR_CONN="postgresql://h_user@$IP:5432/dmcrhpw?application_name=dmcr&password=q%26p%3Dss%20w0rd" pwrun deploy)" 0 "&password= in the URL query authenticates"
ok "$(DMCR_CONN="postgresql://:q%26p%3Dss%20w0rd@$IP:5432/dmcrhpw?user=h_user" pwrun status)" 0 "a URL with an empty user (://:pw@host) authenticates"
ok "$(grep -c 'q&p\|q%26p\|w0rd\|password' /tmp/h-argv.log)" 0 "the password is never in psql's argv ($(wc -l < /tmp/h-argv.log) psql calls)"
ok "$(grep -c '^psql PW' /tmp/h-env.log | awk '{print ($1 > 0)}')" 1 "psql gets PGPASSWORD"
ok "$(wc -l < /tmp/h-leak.log)" 0 "git, perl, find and sha256sum never see PGPASSWORD"
: > /tmp/h-leak.log
ok "$(PGPASSWORD='q&p=ss w0rd' DMCR_CONN="postgresql://h_user@$IP:5432/dmcrhpw" pwrun revertLast)" 0 "a PGPASSWORD the caller exports still reaches psql"
ok "$(wc -l < /tmp/h-leak.log)" 0 "and nothing else"

echo "== F3 / F4: DMCR_CONN must be a connection string for this environment"
ok "$(DMCR_CONN='hunter2secret' run status)" 1 "a bare password as DMCR_CONN is refused"
ok "$(has "DMCR_CONN is not a connection string (expected postgresql://... or key=value).")" 1 "with the message"
ok "$(has "hunter2secret")" 0 "and it is never printed"
ok "$(DMCR_CONN_ENV=prod run status)" 1 "DMCR_CONN built for prod is refused on dev"
ok "$(has "DMCR_CONN was built for environment 'prod', not 'dev'.")" 1 "with the message"
ok "$(DMCR_CONN_ENV=dev run status)" 0 "DMCR_CONN built for dev runs"

echo "== F5: dmcr.cfg sslmode; production without TLS warns"
: > /tmp/h-env.log
printf "${CFG_HEAD}sslmode = require\n\n[dev]\nconn =\n" > /hcfg/ssl.cfg
ok "$(DMCR_PSQL=/tmp/hfake/psql-spy runc /hcfg/ssl.cfg status)" 1 "[dmcr] sslmode = require reaches psql (the test server has no TLS)"
ok "$(grep -c 'SSL=require' /tmp/h-env.log | awk '{print ($1 > 0)}')" 1 "psql ran with PGSSLMODE=require"
: > /tmp/h-env.log
ok "$(DMCR_PSQL=/tmp/hfake/psql-spy DMCR_CONN="$CONN?sslmode=disable" runc /hcfg/ssl.cfg status)" 0 "an sslmode in the connection string wins"
ok "$(grep -c 'SSL=' /tmp/h-env.log)" 0 "PGSSLMODE is not set then"
printf "${CFG_HEAD}\n[prod]\nconn =\n" | sed 's/^env = dev/env = prod/' > /hcfg/prodnotls.cfg
ok "$(runc /hcfg/prodnotls.cfg status)" 0 "status on prod without sslmode"
ok "$(has "Connection to production environment 'prod' does not require TLS: set sslmode = verify-full (or require) for [prod] in dmcr.cfg.")" 1 "warns once"
ok "$(run status)" 0 "dev without sslmode"
ok "$(has "does not require TLS")" 0 "no warning off production"

echo "== F7: deployment ids read back from the event log must be hex"
q "INSERT INTO dmcr.event_log(action, change_id, status, environment, actor, deploy_id) VALUES ('deploy', 'x', 'success', 'dev', 't', 'abcd'' OR ''1''=''1');" >/dev/null
ok "$(run log abcd)" 1 "a non-hex deploy_id is refused"
ok "$(has "not a deployment id")" 1 "with an error"
q "DELETE FROM dmcr.event_log WHERE deploy_id LIKE 'abcd%';" >/dev/null

echo "== G1: timeouts in dmcr.cfg are numbers with a unit"
printf "[dmcr]\nenv = dev\nchanges_dir = changes\nlock_timeout = 5s'; DROP TABLE x; --\n\n[dev]\nconn =\n" > /hcfg/badto.cfg
ok "$(runc /hcfg/badto.cfg status)" 1 "a lock_timeout with SQL in it is refused"
ok "$(has "Invalid lock_timeout '5s'; DROP TABLE x; --' in dmcr.cfg: use a number with ms, s, min, h or d (like 5s).")" 1 "with the message"
printf "[dmcr]\nenv = dev\nchanges_dir = changes\nlock_timeout = 500ms\nstatement_timeout = 2 min\n\n[dev]\nconn =\n" > /hcfg/goodto.cfg
ok "$(runc /hcfg/goodto.cfg status)" 0 "500ms and '2 min' are fine"

echo "== G2: manual-script uses a random dollar tag"
mk 011_danger_h 'DROP TABLE public.h_t;' 'SELECT 1;' 'CREATE TABLE public.h_t (id int);'
bash $R -c /hcfg/dmcr.cfg manual-script 011_danger_h > /tmp/hms.sql 2>/dev/null
ok "$(grep -c '\$dmcr\$' /tmp/hms.sql)" 0 "no fixed \$dmcr\$ tag"
ok "$(grep -cE '^DO \$dmcr_[0-9a-f]{8}\$ BEGIN' /tmp/hms.sql)" 1 "a \$dmcr_<8 hex>\$ tag"
psql "$CONN" -X -q -v ON_ERROR_STOP=1 -f /tmp/hms.sql >/dev/null 2>&1
ok "$?" 0 "the script runs in psql"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id = '011_danger_h';")" 1 "and records the change"

echo "== H1: --json output stays valid"
for cmd in "status --json" "plan --json" "deploy --dry-run --json" "verify all --json" "info --json" "history --json" "diff --json"; do
    # shellcheck disable=SC2086
    run $cmd >/dev/null; ok "$(isjson)" valid "$cmd"
done

echo "== H4: a scoped revert with an applied change whose folder is missing is an error"
fresh
mk 001_a 'CREATE TABLE public.h_t (id int);' 'SELECT 1;' 'DROP TABLE public.h_t;'
mk 002_b 'CREATE TABLE public.h_v (id int);' 'SELECT 1;' 'DROP TABLE public.h_v;'
ok "$(run deploy)" 0 "deploy 001 and 002 in one deployment"
did="$(q "SELECT deploy_id FROM dmcr.change_log WHERE change_id = '002_b';")"
mv "$C/001_a" /tmp/h_001_a
ok "$(run revert "${did:0:7}" --dry-run)" 1 "revert <deployment> --dry-run refuses"
ok "$(has "have no change folder in $C: 001_a.")" 1 "naming the change without a folder"
ok "$(run revert "${did:0:7}")" 1 "revert <deployment> refuses"
ok "$(q "SELECT count(*) FROM dmcr.change_log;")" 2 "nothing was reverted"
mv /tmp/h_001_a "$C/001_a"

echo "== H5: revert's success event commits with the revert"
ok "$(run revert "${did:0:7}")" 0 "revert the deployment"
ok "$(q "SELECT count(*) FROM dmcr.event_log WHERE action = 'revert' AND status = 'success' AND change_id IN ('001_a', '002_b');")" 2 "one success event per reverted change"

echo "== H6: duplicate prefixes compare the number"
mk 0001_c 'SELECT 1;' 'SELECT 1;' 'SELECT 1;'
ok "$(run check)" 0 "check runs"
ok "$(has "DUPLICATE PREFIX")" 1 "001_a and 0001_c share prefix 1"
ok "$(run deploy)" 1 "deploy refuses"
rm -rf "$C/0001_c"

echo "== I1 / I2: no registry cache or temp file left in /tmp"
ok "$(ls /tmp | grep -c '^dmcr_reg_')" 0 "no /tmp/dmcr_reg_* cache files"
ok "$(ls /tmp | grep -cE '^dmcr_(tx|notx|verify|parse|rt|regtx)_')" 0 "no dmcr temp files left behind"
ok "$(ls -d /tmp/dmcr_run_* 2>/dev/null | wc -l)" 0 "no run directory left behind"

echo "== I3: the lock directory is private"
mkdir -p /tmp/hxdg /tmp/hother; rm -rf /tmp/hxdg/dmcr_locks_0
ln -s /tmp/hother /tmp/hxdg/dmcr_locks_0
ok "$(XDG_RUNTIME_DIR=/tmp/hxdg run deploy)" 1 "a symlinked lock directory is refused"
ok "$(has "Refusing the lock directory")" 1 "with a message"
rm -f /tmp/hxdg/dmcr_locks_0; mkdir -m 777 /tmp/hxdg/dmcr_locks_0; chmod 777 /tmp/hxdg/dmcr_locks_0
ok "$(XDG_RUNTIME_DIR=/tmp/hxdg run deploy)" 1 "a lock directory others can write to is refused"
chmod 700 /tmp/hxdg/dmcr_locks_0
lockf="/tmp/hxdg/dmcr_locks_0/dmcr_$(printf '%s' "postgresql://postgres@localhost:5432/dmcrhard" | sha256sum | cut -c1-16).lock"
ln -s /tmp/hother/target "$lockf"
ok "$(XDG_RUNTIME_DIR=/tmp/hxdg run deploy)" 1 "a symlinked lock file is refused"
ok "$(absent /tmp/hother/target)" absent "and nothing was written through it"
rm -f "$lockf"
ok "$(XDG_RUNTIME_DIR=/tmp/hxdg run deploy)" 0 "a private lock directory works"
rm -rf /tmp/hxdg/dmcr_locks_0
mk 003_lock 'SELECT 1;' 'SELECT 1;' 'SELECT 1;'
XDG_RUNTIME_DIR=/tmp/hxdg run deploy >/dev/null
ok "$(stat -c %a /tmp/hxdg/dmcr_locks_0)" 700 "a new lock directory is created with mode 700"

echo "== I4: a placeholder value with & is substituted literally"
printf "${CFG_HEAD}\n[dev]\nconn =\n\n[placeholders]\ntag = a&b\\\\&c\n" > /hcfg/amp.cfg
mk 004_amp "CREATE TABLE public.h_amp (v text); INSERT INTO public.h_amp VALUES ('\${tag}');" 'SELECT 1;' 'DROP TABLE public.h_amp;'
ok "$(runc /hcfg/amp.cfg deploy)" 0 "deploy with the placeholder"
ok "$(q "SELECT v FROM public.h_amp;")" 'a&b\&c' "the value is stored as written"

echo "== J. conflict check (Releases › Conflicts) before deploy"
# A fake node (DMCR_NODE) stands in for Node.js and the detector here. It logs its arguments and environment and
# prints the spec's conflict while a deploy would apply 003 or 004 and no change has "merges". Every other deploy in
# these suites runs the real dmcr_conflicts.cjs on the container's real node (run-tests.sh copies it in).
fresh
q "DROP FUNCTION IF EXISTS public.price_label(numeric); DROP TABLE IF EXISTS public.h_cca;" >/dev/null
cat > "$C/releases.json" <<'EOF'
{ "releases": [ { "id": "R1", "name": "R1", "date": "2026-11-01", "status": "planned" } ],
  "projects": [ { "id": "A", "name": "A", "type": "new", "release": "R1", "status": "active" },
                { "id": "B", "name": "B", "type": "cr", "release": "R1", "status": "active" } ] }
EOF
mk 003_b_price_label "CREATE OR REPLACE FUNCTION public.price_label(p numeric) RETURNS text LANGUAGE sql AS \$f\$ SELECT p::text || ' USD' \$f\$;" \
    'SELECT 1;' 'DROP FUNCTION IF EXISTS public.price_label(numeric);' '{"project":"B","created_by":"anika.rao"}'
mk 004_b_price_label_currency_first "CREATE OR REPLACE FUNCTION public.price_label(p numeric) RETURNS text LANGUAGE sql AS \$f\$ SELECT 'USD ' || p::text \$f\$;" \
    'SELECT 1;' "CREATE OR REPLACE FUNCTION public.price_label(p numeric) RETURNS text LANGUAGE sql AS \$f\$ SELECT p::text || ' USD' \$f\$;" '{"project":"B","created_by":"leo.martin"}'
mk 005_a_other 'CREATE TABLE public.h_cca (id int);' 'SELECT 1;' 'DROP TABLE public.h_cca;' '{"project":"A"}'
mkdir -p /tmp/hcc; rm -f /tmp/hcc_fail /tmp/hcc_garbage
CANNED1='{"conflicts":[{"object":"price_label(numeric)","label":"both added","ours":{"change_id":"003_b_price_label","project":"B","created_by":"anika.rao"},"theirs":{"change_id":"004_b_price_label_currency_first","project":"B","created_by":"leo.martin"}}]}'
printf '%s\n' "$CANNED1" > /tmp/hcc_canned.json
cat > /tmp/hcc/node <<'EOF'
#!/bin/bash
{ printf 'ARGV'; printf ' %s' "$@"; echo; echo "ENV ELECTRON_RUN_AS_NODE=${ELECTRON_RUN_AS_NODE:-} PGPASSWORD=${PGPASSWORD:+leaked} DMCR_CONN=${DMCR_CONN:+leaked}"; } >> /tmp/hcc.log
if [[ -f /tmp/hcc_fail ]]; then printf 'cannot read the changes folder\nmore detail\n' >&2; exit 2; fi
if [[ -f /tmp/hcc_garbage ]]; then echo 'not json'; exit 0; fi
ids=",$5,"
if grep -qs '"merges"' "$3"/*/meta.json || [[ "$ids" != *,003_b_price_label,* && "$ids" != *,004_b_price_label_currency_first,* ]]; then
    echo '{"conflicts":[]}'; exit 0
fi
cat /tmp/hcc_canned.json
EOF
chmod +x /tmp/hcc/node
ccrun() { : > /tmp/hcc.log; env DMCR_NODE=/tmp/hcc/node bash $R -c "${CCCFG:-/hcfg/dmcr.cfg}" "$@" >/tmp/hout.txt 2>/tmp/herr.txt; echo $?; }
ccjson() { perl -MJSON::PP -0777 -ne 'my $d = eval { decode_json($_) } or do { print "invalid"; exit }; print join("|", map { defined $_ ? $_ : "-" } $d->{status}, $d->{code}, $d->{env}, (ref $d->{missing} eq "ARRAY" ? scalar @{$d->{missing}} : "x"), (ref $d->{conflicts} eq "ARRAY" ? scalar @{$d->{conflicts}} : "x"), $d->{conflicts}[0]{object}, $d->{conflicts}[0]{ours}{change_id}, $d->{conflicts}[0]{theirs}{created_by})' /tmp/hout.txt; }
reg_cc() { q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('003_b_price_label','004_b_price_label_currency_first','005_a_other','006_b_price_label_merge');"; }
CC_MSG1="BLOCKED: 1 conflict between changes not resolved: price_label(numeric) (both added): 003_b_price_label (anika.rao) vs 004_b_price_label_currency_first (leo.martin). Merge them in DMCR Web (Releases › Conflicts), or add a merge change, then deploy again."

echo "-- J1: an unmerged conflict refuses deploy and its dry run"
ok "$(PGPASSWORD=dmcrtest ccrun deploy)" 1 "deploy is refused"
ok "$(has "$CC_MSG1")" 1 "with the conflict message"
ok "$(reg_cc)" 0 "nothing was applied"
ok "$(q "SELECT to_regprocedure('public.price_label(numeric)') IS NULL AND to_regclass('public.h_cca') IS NULL;")" t "no function or table was created"
ok "$(grep -c '^ARGV /runner/dmcr_conflicts.cjs --changes /hwork/changes --ids 003_b_price_label,004_b_price_label_currency_first,005_a_other$' /tmp/hcc.log)" 1 "the helper gets --changes and the plan's ids in order"
ok "$(grep -c '^ENV ELECTRON_RUN_AS_NODE=1 PGPASSWORD= DMCR_CONN=$' /tmp/hcc.log)" 1 "with ELECTRON_RUN_AS_NODE=1 and no PGPASSWORD or DMCR_CONN"
ok "$(grep -c 'deploy_lock\|Evaluating change' /tmp/hout.txt /tmp/herr.txt | awk -F: '{s+=$2} END {print s}')" 0 "refused before the lock and before any change"
ok "$(ccrun deploy --dry-run)" 1 "deploy --dry-run is refused"
ok "$(has "$CC_MSG1")" 1 "with the conflict message"
ok "$(ccrun deploy --dry-run --json)" 1 "deploy --dry-run --json is refused"
ok "$(isjson)" valid "with valid JSON"
ok "$(ccjson)" "error|conflicts_unresolved|dev|0|1|price_label(numeric)|003_b_price_label|leo.martin" "code conflicts_unresolved, env, missing [] and the helper's conflicts"
ok "$(grep -cF "\"message\":\"$CC_MSG1\"" /tmp/hout.txt)" 1 "the JSON message is the conflict message"
ok "$(ccrun deploy --json)" 1 "deploy --json is refused"
ok "$(ccjson)" "error|conflicts_unresolved|dev|0|1|price_label(numeric)|003_b_price_label|leo.martin" "with the same JSON"
ok "$(reg_cc)" 0 "still nothing applied"
ok "$(ccrun deploy --to 003_b_price_label --dry-run)" 1 "a deploy --to 003 (one side) is refused"
ok "$(grep -c -- '--ids 003_b_price_label$' /tmp/hcc.log)" 1 "and passes only 003"

echo "-- J2: two conflicts, one side without created_by"
printf '%s\n' '{"conflicts":[{"object":"price_label(numeric)","label":"both added","ours":{"change_id":"003_b_price_label","project":"B","created_by":"anika.rao"},"theirs":{"change_id":"004_b_price_label_currency_first","project":"B","created_by":"leo.martin"}},{"object":"h_view","label":"both changed","ours":{"change_id":"003_b_price_label","project":"B"},"theirs":{"change_id":"004_b_price_label_currency_first","project":"B"}}]}' > /tmp/hcc_canned.json
ok "$(ccrun deploy)" 1 "deploy is refused"
ok "$(has "BLOCKED: 2 conflicts between changes not resolved: price_label(numeric) (both added): 003_b_price_label (anika.rao) vs 004_b_price_label_currency_first (leo.martin); h_view (both changed): 003_b_price_label vs 004_b_price_label_currency_first. Merge them in DMCR Web (Releases › Conflicts), or add a merge change, then deploy again.")" 1 "lists both, '2 conflicts', no () without created_by"
printf '%s\n' "$CANNED1" > /tmp/hcc_canned.json

echo "-- J3: the helper fails or prints no result"
touch /tmp/hcc_fail
ok "$(ccrun deploy)" 1 "a failing helper refuses the deploy (block)"
ok "$(has "BLOCKED: the conflict check failed: cannot read the changes folder")" 1 "with its first stderr line"
ok "$(has "more detail")" 0 "only the first line"
ok "$(ccrun deploy --dry-run --json)" 1 "deploy --dry-run --json too"
ok "$(isjson)" valid "with valid JSON"
rm -f /tmp/hcc_fail; touch /tmp/hcc_garbage
ok "$(ccrun deploy --dry-run)" 1 "a helper that prints no JSON refuses the deploy"
ok "$(has "BLOCKED: the conflict check failed: no result")" 1 "with: no result"
rm -f /tmp/hcc_garbage
ok "$(reg_cc)" 0 "nothing applied"

echo "-- J4: a deploy that applies neither side is not refused"
ok "$(ccrun deploy --project A)" 0 "deploy --project A"
ok "$(grep -c -- '--ids 005_a_other$' /tmp/hcc.log)" 1 "passes only 005_a_other"
ok "$(has "conflict")" 0 "no conflict output"
ok "$(q "SELECT count(*) FROM dmcr.change_log WHERE change_id = '005_a_other';")" 1 "005_a_other applied"
ok "$(ccrun deploy --dry-run --project A)" 0 "nothing pending in A: no check"
ok "$(wc -l < /tmp/hcc.log)" 0 "the helper is not called for an empty list"

echo "-- J5: conflict_check = off / invalid / warn"
printf "${CFG_HEAD}conflict_check = off\n\n[dev]\nconn =\n" > /hcfg/ccoff.cfg
printf "${CFG_HEAD}conflict_check = maybe\n\n[dev]\nconn =\n" > /hcfg/ccbad.cfg
printf "${CFG_HEAD}conflict_check = warn\n\n[dev]\nconn =\n" > /hcfg/ccwarn.cfg
ok "$(CCCFG=/hcfg/ccoff.cfg ccrun deploy --dry-run)" 0 "off: the dry run goes on"
ok "$(has "onflict")" 0 "off: no output"
ok "$(wc -l < /tmp/hcc.log)" 0 "off: the helper is not called"
ok "$(CCCFG=/hcfg/ccbad.cfg ccrun deploy)" 1 "an invalid conflict_check refuses the deploy"
ok "$(has "Invalid conflict_check 'maybe' in dmcr.cfg: use block, warn or off.")" 1 "with the message"
ok "$(CCCFG=/hcfg/ccbad.cfg ccrun deploy --dry-run)" 1 "and the dry run"
ok "$(reg_cc)" 1 "nothing more applied"
CC_WARN="WARNING: 1 conflict between changes not resolved: price_label(numeric) (both added): 003_b_price_label (anika.rao) vs 004_b_price_label_currency_first (leo.martin). conflict_check = warn: deploying anyway."
ok "$(CCCFG=/hcfg/ccwarn.cfg ccrun deploy --dry-run --json)" 0 "warn: the dry run goes on"
ok "$(isjson)" valid "with valid JSON"
ok "$(grep -c '"status":"dry_run"' /tmp/hout.txt)" 1 "the dry-run result"
ok "$(has "$CC_WARN")" 1 "warn: the warning"
touch /tmp/hcc_fail
ok "$(CCCFG=/hcfg/ccwarn.cfg ccrun deploy --dry-run)" 0 "warn: a failing helper does not refuse"
ok "$(has "WARNING: the conflict check failed: cannot read the changes folder. conflict_check = warn: deploying anyway.")" 1 "warn: it warns"
rm -f /tmp/hcc_fail
ok "$(CCCFG=/hcfg/ccwarn.cfg ccrun deploy)" 0 "warn: deploy goes through"
ok "$(has "$CC_WARN")" 1 "warn: with the warning"
ok "$(reg_cc)" 3 "warn: 003 and 004 applied"
did="$(q "SELECT deploy_id FROM dmcr.change_log WHERE change_id = '004_b_price_label_currency_first';")"
ok "$(run revert "${did:0:7}")" 0 "revert that deployment"

echo "-- J6: Node.js or the helper not found: refused (block), a warning (warn)"
CC_NONODE="BLOCKED: the conflict check failed: Node.js not found (put node on PATH or set DMCR_NODE). To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg."
NONODE_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx /usr/local/bin | paste -sd: -)"
ok "$(PATH="$NONODE_PATH" bash -c 'command -v node' >/dev/null; echo $?)" 1 "(no node on that PATH)"
ok "$(DMCR_NODE=/nope/node run deploy --dry-run)" 1 "DMCR_NODE pointing at a missing file: the dry run is refused"
ok "$(has "$CC_NONODE")" 1 "with the message, once"
ok "$(PATH="$NONODE_PATH" run deploy --dry-run)" 1 "no DMCR_NODE and no node on PATH: the dry run is refused"
ok "$(has "$CC_NONODE")" 1 "with the message"
ok "$(DMCR_NODE=/nope/node run deploy --dry-run --json)" 1 "deploy --dry-run --json is refused"
ok "$(isjson)" valid "with valid JSON"
ok "$(ccjson)" "error|conflict_check_failed|dev|0|0|-|-|-" "code conflict_check_failed, missing [], conflicts []"
ok "$(grep -cF "\"message\":\"$CC_NONODE\"" /tmp/hout.txt)" 1 "the JSON message"
ok "$(DMCR_CONFLICTS_JS=/nope/dmcr_conflicts.cjs ccrun deploy --dry-run)" 1 "a missing helper: the dry run is refused"
ok "$(has "BLOCKED: the conflict check failed: dmcr_conflicts.cjs not found next to the runner (or set DMCR_CONFLICTS_JS). To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg.")" 1 "with the message"
ok "$(wc -l < /tmp/hcc.log)" 0 "node is not called"
ok "$(DMCR_NODE=/nope/node run deploy)" 1 "DMCR_NODE missing: the deploy is refused"
ok "$(has "$CC_NONODE")" 1 "with the message"
ok "$(grep -c 'deploy_lock\|Evaluating change' /tmp/hout.txt /tmp/herr.txt | awk -F: '{s+=$2} END {print s}')" 0 "refused before the lock and before any change"
ok "$(reg_cc)" 1 "nothing applied"
ok "$(DMCR_NODE=/nope/node bash $R -c /hcfg/ccoff.cfg deploy --dry-run >/tmp/hout.txt 2>/tmp/herr.txt; echo $?)" 0 "conflict_check = off: no Node.js needed"
ok "$(has "onflict")" 0 "off: no output"
ok "$(DMCR_NODE=/nope/node bash $R -c /hcfg/ccwarn.cfg deploy >/tmp/hout.txt 2>/tmp/herr.txt; echo $?)" 0 "conflict_check = warn: the deploy goes on"
ok "$(has "WARNING: the conflict check failed: Node.js not found (put node on PATH or set DMCR_NODE). conflict_check = warn: deploying anyway.")" 1 "with the warning"
ok "$(has "BLOCKED")" 0 "never BLOCKED"
ok "$(reg_cc)" 3 "003 and 004 applied"
did="$(q "SELECT deploy_id FROM dmcr.change_log WHERE change_id = '004_b_price_label_currency_first';")"
ok "$(run revert "${did:0:7}")" 0 "revert that deployment"

echo "-- J7: a merge change resolves the conflict"
mk 006_b_price_label_merge "CREATE OR REPLACE FUNCTION public.price_label(p numeric) RETURNS text LANGUAGE sql AS \$f\$ SELECT 'USD ' || p::text || ' (merged)' \$f\$;" \
    'SELECT public.price_label(1);' 'DROP FUNCTION IF EXISTS public.price_label(numeric);' \
    '{"project":"B","merges":[{"key":"function:price_label(numeric)","changes":["003_b_price_label","004_b_price_label_currency_first"]}],"requires":["003_b_price_label","004_b_price_label_currency_first"]}'
ok "$(ccrun deploy)" 0 "deploy goes through"
ok "$(grep -c -- '--ids 003_b_price_label,004_b_price_label_currency_first,006_b_price_label_merge$' /tmp/hcc.log)" 1 "the merge change is in the ids"
ok "$(has "onflict")" 0 "no conflict output"
ok "$(reg_cc)" 4 "003, 004, 005 and 006 applied"
ok "$(q "SELECT public.price_label(1);")" "USD 1 (merged)" "the merged function is live"
ok "$(ls /tmp | grep -c '^dmcr_cc_')" 0 "no conflict-check temp file left behind"

echo "-- J8: a long id list (over 8000 characters) reaches the helper on stdin"
cat > /tmp/hcc/node2 <<'EOF'
#!/bin/bash
{ printf 'ARGV'; printf ' %s' "$@"; echo; } >> /tmp/hcc.log
ids=""
if [[ "$5" == "-" ]]; then ids="$(cat)"; printf 'STDIN %s\n' "$(printf '%s' "$ids" | tr ',' '\n' | grep -c .)" >> /tmp/hcc.log; else ids="$5"; fi
if [[ ",$ids," == *,351_b_price_badge_currency_first,* ]]; then
  echo '{"conflicts":[{"object":"price_badge(numeric)","label":"both added","ours":{"change_id":"350_b_price_badge","project":"B"},"theirs":{"change_id":"351_b_price_badge_currency_first","project":"B"}}]}'
else echo '{"conflicts":[]}'; fi
EOF
chmod +x /tmp/hcc/node2
for n in $(seq 100 349); do mk "${n}_a_long_change_name_for_the_stdin_check" 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"project":"A"}'; done
mk 350_b_price_badge "CREATE OR REPLACE FUNCTION public.price_badge(p numeric) RETURNS text LANGUAGE sql AS \$f\$ SELECT 'A' \$f\$;" 'SELECT 1;' 'DROP FUNCTION IF EXISTS public.price_badge(numeric);' '{"project":"B"}'
mk 351_b_price_badge_currency_first "CREATE OR REPLACE FUNCTION public.price_badge(p numeric) RETURNS text LANGUAGE sql AS \$f\$ SELECT 'B' \$f\$;" 'SELECT 1;' 'DROP FUNCTION IF EXISTS public.price_badge(numeric);' '{"project":"B"}'
: > /tmp/hcc.log
ok "$(env DMCR_NODE=/tmp/hcc/node2 bash $R -c "${CCCFG:-/hcfg/dmcr.cfg}" deploy --dry-run >/tmp/hout.txt 2>/tmp/herr.txt; echo $?)" 1 "deploy --dry-run is refused"
ok "$(grep -c -- '--ids -$' /tmp/hcc.log)" 1 "the ids go on stdin (--ids -)"
ok "$(grep -c '^STDIN 252$' /tmp/hcc.log)" 1 "all 252 ids arrive"
ok "$(has "price_badge(numeric) (both added): 350_b_price_badge vs 351_b_price_badge_currency_first")" 1 "the helper saw the last ids of the long list"
rm -rf /hwork/changes/[1-3][0-9][0-9]_a_long_change_name_for_the_stdin_check /hwork/changes/350_b_price_badge /hwork/changes/351_b_price_badge_currency_first

psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS dmcrhpw;" -c "DROP ROLE IF EXISTS h_user;" -c "DROP DATABASE IF EXISTS dmcrhard;" >/dev/null 2>&1
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
