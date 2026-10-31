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

psql "$ADMIN" -X -q -c "DROP DATABASE IF EXISTS dmcrhpw;" -c "DROP ROLE IF EXISTS h_user;" -c "DROP DATABASE IF EXISTS dmcrhard;" >/dev/null 2>&1
echo; echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
