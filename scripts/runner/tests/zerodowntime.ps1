# Zero-downtime changes written with ${schema} (fixtures\zero-downtime, made by DMCR's own templates)
# through dmcr.ps1 on two environments with different schemas: test = zp_st (database dmcrtest),
# prod = zp (database dmcrzp). Same scenarios as zerodowntime.sh; psql runs in the dmcr-test-pg
# container through psql-shim.ps1.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'zwork'; $cfgDir = Join-Path $tmp 'zcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
Copy-Item -Recurse (Join-Path $here 'fixtures\zero-downtime\*') (Join-Path $work 'changes')
$test = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$prod = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrzp'
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; Remove-Item Env:DMCR_CONN -ErrorAction SilentlyContinue; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
$cfg = Join-Path $cfgDir 'dmcr.cfg'
"[dmcr]`nenv = test`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n`n[envs]`nnames = prod, test`n`n[test]`nconn = $test`nschema = zp_st`n`n[prod]`nconn = $prod`nschema = zp" | Set-Content -Encoding ASCII $cfg
'{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$script:pass = 0; $script:fail = 0
function Q([string]$conn, [string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ } }
function Run([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }; return $LASTEXITCODE }
function Count([string]$text) { @($script:last | Where-Object { $_ -like "*$text*" }).Count }
function Base($conn, $s) {
    Q $conn "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS $s CASCADE; CREATE SCHEMA $s; CREATE TABLE $s.zaps (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner varchar(100) NOT NULL); CREATE TABLE $s.zap_runs (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, zap_id bigint, started_at timestamptz DEFAULT now(), duration_ms integer); INSERT INTO $s.zaps (owner) VALUES ('lena'), ('priya'), ('marco'); INSERT INTO $s.zap_runs (zap_id, duration_ms) SELECT 1 + g % 3, g * 100 FROM generate_series(1, 5) g;" | Out-Null
}
function CheckEnv($c, $s, $e) {
    Ok (Q $c "SELECT count(*) FROM $s.zaps WHERE owner_name = owner;") 3 "${e}: owner_name backfilled in $s"
    Q $c "INSERT INTO $s.zaps (owner) VALUES ('tom');" | Out-Null
    Ok (Q $c "SELECT owner_name FROM $s.zaps WHERE owner = 'tom';") 'tom' "${e}: the sync trigger in $s copies owner to owner_name"
    Q $c "INSERT INTO $s.zaps (owner, owner_name) VALUES ('x', 'x'); UPDATE $s.zaps SET owner_name = 'ana' WHERE owner = 'x';" | Out-Null
    Ok (Q $c "SELECT count(*) FROM $s.zaps WHERE owner = 'ana';") 1 "${e}: and owner_name back to owner"
    Ok (Q $c "SELECT count(*) FROM $s.zap_runs WHERE duration_ms_big = duration_ms;") 5 "${e}: duration_ms_big backfilled in $s"
    Ok (Q $c "SELECT is_nullable FROM information_schema.columns WHERE table_schema = '$s' AND table_name = 'zap_runs' AND column_name = 'started_at';") 'NO' "${e}: $s.zap_runs.started_at is NOT NULL"
    Ok (Q $c "SELECT convalidated::text || ' ' || confrelid::regclass::text FROM pg_constraint WHERE conrelid = '$s.zap_runs'::regclass AND contype = 'f';") "true $s.zaps" "${e}: FK validated, references $s.zaps"
    Ok (Q $c "SELECT count(*) FROM pg_indexes WHERE schemaname = '$s' AND indexdef ILIKE '%(zap_id, started_at)%';") 1 "${e}: index on $s.zap_runs (zap_id, started_at)"
    Ok (Q $c "SELECT (SELECT count(*) FROM pg_namespace WHERE nspname LIKE '%{%') + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('zaps', 'zap_runs')) + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'dmcr_sync%');") 0 "${e}: nothing landed in public or in a schema named `${schema}"
}

Q $test "DROP DATABASE IF EXISTS dmcrzp;" | Out-Null
Q $test "CREATE DATABASE dmcrzp;" | Out-Null
Base $test 'zp_st'; Base $prod 'zp'
Run @('init', '--env', 'test') | Out-Null; Run @('init', '--env', 'prod') | Out-Null

"== test (zp_st): deploy, verify"
Ok (Run @('deploy', '--env', 'test')) 0 'deploy --env test succeeds'
Ok (Q $test "SELECT count(*) FROM dmcr.change_log;") 7 'the 7 expand / single changes are applied on test'
Ok ([int]((Count '002_danger_rename_zaps_owner_contract') -gt 0) + [int]((Count '004_danger_retype_zap_runs_duration_ms_contract') -gt 0)) 2 'the 2 danger_ contracts are named as left to the DBA'
CheckEnv $test 'zp_st' 'test'
Ok (Run @('verify', 'all', '--env', 'test')) 0 'verify all --env test passes'

"== prod (zp): the same files"
Ok (Run @('deploy', '--env', 'prod')) 0 'deploy --env prod succeeds'
Ok (Q $prod "SELECT count(*) FROM dmcr.change_log;") 7 'the 7 changes are applied on prod'
CheckEnv $prod 'zp' 'prod'
Ok (Run @('verify', 'all', '--env', 'prod')) 0 'verify all --env prod passes'
Ok (Q $test "SELECT count(*) FROM pg_namespace WHERE nspname = 'zp';") 0 'test database has no zp schema'

"== the contracts as manual scripts (test)"
foreach ($id in '002_danger_rename_zaps_owner_contract', '004_danger_retype_zap_runs_duration_ms_contract') {
    $file = Join-Path $tmp "$id.sql"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg manual-script $id --env test 2>$null | Set-Content -Encoding UTF8 $file
    $text = Get-Content -Raw $file
    Ok ([regex]::Matches($text, '\$\{').Count) 0 "${id}: the script has no `${...} left"
    Ok ([int]($text -match 'zp_st\.')) 1 "${id}: the script names zp_st"
    & $env:DMCR_PSQL $test -X -q -v ON_ERROR_STOP=1 -f $file *> $null
    Ok $LASTEXITCODE 0 "${id}: the script runs"
}
Ok (Q $test "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'zp_st' AND table_name = 'zaps';") 'id,owner_name' 'zp_st.zaps keeps only id, owner_name'
Ok (Q $test "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'zp_st' AND table_name = 'zap_runs' AND column_name = 'duration_ms';") 0 'zp_st.zap_runs.duration_ms dropped'
Ok (Q $test "SELECT count(*) FROM dmcr.change_log;") 9 'registry: all 9 changes on test'
Ok (Run @('verify', 'all', '--env', 'test')) 0 'verify all --env test passes after the contracts'
Ok (Q $prod "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'zp' AND table_name = 'zaps' AND column_name = 'owner';") 1 'prod still has zp.zaps.owner (contract not run there)'

"== revert on prod down to the start"
Ok (Run @('revert', 'to', '001_rename_zaps_owner_expand', '--env', 'prod')) 0 'revert to 001 on prod succeeds'
Ok (Q $prod "SELECT count(*) FROM dmcr.change_log;") 0 'prod registry empty'
Ok (Q $prod "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'zp' AND table_name IN ('zaps', 'zap_runs');") 'duration_ms,id,id,owner,started_at,zap_id' 'zp tables back to their original columns'
Ok (Q $prod "SELECT count(*) FROM pg_proc WHERE pronamespace = 'zp'::regnamespace;") 0 'sync trigger functions removed from zp'
Ok (Q $prod "SELECT count(*) FROM pg_constraint WHERE conrelid = 'zp.zap_runs'::regclass AND contype IN ('f', 'c');") 0 'FK and NOT NULL check removed'

''
"RESULT: $($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
