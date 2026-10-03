#!/usr/bin/env bash
# PGPASSWORD test for dmcr.sh: password-protected role over TCP (scram), psql argv spied.
set -u
IP="$(hostname -i | awk '{print $1}')"
psql -U postgres -d dmcrtest -X -q -c "DROP SCHEMA IF EXISTS dmcr CASCADE;" 2>/dev/null
psql -U postgres -d dmcrtest -X -q -c "DROP ROLE IF EXISTS app_user;" -c "CREATE ROLE app_user LOGIN PASSWORD 'p@ss:w rd!';" -c "GRANT ALL ON DATABASE dmcrtest TO app_user; GRANT ALL ON SCHEMA public TO app_user;"
cat > /tmp/psql-spy <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> /tmp/psql-argv.log
exec /usr/bin/psql "$@"
EOF
chmod +x /tmp/psql-spy; : > /tmp/psql-argv.log
rm -rf /work /cfg; mkdir -p /work/changes/001_t /cfg
printf '[dmcr]\nenv = dev\nchanges_dir = changes\n\n[dev]\nconn =\n' > /cfg/dmcr.cfg
printf 'CREATE TABLE public.sec_t (id int);\n' > /work/changes/001_t/deploy.sql
printf 'SELECT 1;\n' > /work/changes/001_t/verify.sql
printf 'DROP TABLE public.sec_t;\n' > /work/changes/001_t/revert.sql
export DMCR_BASE_DIR=/work DMCR_PSQL=/tmp/psql-spy
pass=0; fail=0
ok() { if [[ "$1" == "$2" ]]; then echo "  PASS  $3"; pass=$((pass+1)); else echo "  FAIL  $3 (got '$1')"; fail=$((fail+1)); fi; }

echo "== scram is enforced over TCP (wrong password must fail)"
PGPASSWORD=wrong psql "postgresql://app_user@$IP:5432/dmcrtest" -X -t -A -c 'select 1' >/dev/null 2>&1; ok "$?" 2 "wrong password rejected by server"

echo "== URL form: postgresql://app_user:<percent-encoded>@host"
export DMCR_CONN="postgresql://app_user:p%40ss%3Aw%20rd%21@$IP:5432/dmcrtest"
bash /runner/dmcr.sh -c /cfg/dmcr.cfg init >/dev/null 2>&1; ok "$?" 0 "init authenticates via PGPASSWORD"
bash /runner/dmcr.sh -c /cfg/dmcr.cfg deploy >/dev/null 2>&1; ok "$?" 0 "deploy authenticates via PGPASSWORD"
ok "$(grep -c 'p@ss\|p%40ss\|w rd\|w%20rd' /tmp/psql-argv.log)" 0 "password never in psql argv ($(wc -l < /tmp/psql-argv.log) psql calls logged)"
ok "$(grep -c "app_user@$IP" /tmp/psql-argv.log | awk '{print ($1>0)}')" 1 "psql got the password-less URL"

echo "== key=value form"
: > /tmp/psql-argv.log
export DMCR_CONN="host=$IP port=5432 dbname=dmcrtest user=app_user password='p@ss:w rd!'"
bash /runner/dmcr.sh -c /cfg/dmcr.cfg revertLast >/dev/null 2>&1; ok "$?" 0 "revertLast with key=value conn"
ok "$(grep -c 'p@ss\|password' /tmp/psql-argv.log)" 0 "password never in psql argv"
echo; echo "RESULT: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
