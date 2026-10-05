# No-Docker runner test: drives scripts\runner\dmcr.ps1 against a locally installed PostgreSQL
# (or any server psql can reach) and checks the results. Uses two scratch databases,
# dmcr_local_test and dmcr_local_prod, and drops them at the end (-Keep leaves them).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\scripts\runner-local.ps1 -Password <pw>
#
# Options: -PgHost localhost -Port 5432 -User postgres -Password <pw> (or set PGPASSWORD)
#          -Psql <path to psql.exe> (default: psql on PATH, else the newest
#          C:\Program Files\PostgreSQL\<n>\bin\psql.exe)   -Keep
# Covers: init, round-trip test, promotion gate, deploy, tag, checksum drift, revert one change,
# a danger_ change (skipped by deploy, marked applied by the DBA), verify all, history.
param(
    [string]$PgHost = 'localhost', [int]$Port = 5432, [string]$User = 'postgres',
    [string]$Password = $env:PGPASSWORD, [string]$Psql = '', [switch]$Keep
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$runner = Join-Path $repo 'scripts\runner\dmcr.ps1'

if (-not $Psql) {
    $c = Get-Command psql -ErrorAction SilentlyContinue
    if ($c) { $Psql = $c.Source }
    else {
        $found = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
            Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '0') } -Descending | Select-Object -First 1
        if ($found) { $Psql = $found.FullName }
    }
}
if (-not $Psql) { 'psql not found. Install PostgreSQL (its bin folder has psql.exe) or pass -Psql <path>.'; exit 2 }
$Psql = (Resolve-Path $Psql).Path
if (-not $Password) { 'Pass -Password or set PGPASSWORD.'; exit 2 }

$enc = [uri]::EscapeDataString($Password)
$base = "postgresql://${User}:${enc}@${PgHost}:${Port}"
$testDb = 'dmcr_local_test'; $prodDb = 'dmcr_local_prod'
$tmp = Join-Path $env:TEMP 'dmcr-local-test'
$work = Join-Path $tmp 'work'; $changes = Join-Path $work 'changes'; $cfg = Join-Path $tmp 'dmcr.cfg'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $changes | Out-Null

function Q([string]$db, [string]$sql) {
    $old = $env:PGPASSWORD; $env:PGPASSWORD = $Password
    try { return ((& $Psql "postgresql://${User}@${PgHost}:${Port}/$db" -X -q -t -A -c $sql 2>&1 | ForEach-Object { "$_" }) -join "`n").Trim() }
    finally { $env:PGPASSWORD = $old }
}
$script:pass = 0; $script:fail = 0
function Ok($got, $want, $label) {
    if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ }
}
function Run([string[]]$a) {
    $script:last = (& powershell -NoProfile -ExecutionPolicy Bypass -File $runner -c $cfg @a 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return $LASTEXITCODE
}
function Has([string]$text) { if ($script:last -match [regex]::Escape($text)) { 'yes' } else { 'no' } }
function Mk($id, $deploy, $verify, $revert) {
    $d = Join-Path $changes $id; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') $revert
}
# verify that holds in both states: applied (per the registry) → present, reverted → absent
function Guard($id, $cond) {
@"
DO `$`$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '$id') <> ($cond) THEN
    RAISE EXCEPTION '${id}: state does not match the registry';
  END IF;
END `$`$;
"@
}

"PostgreSQL $(Q 'postgres' 'SHOW server_version;') at ${PgHost}:$Port  (psql: $Psql)"
$ver = Q 'postgres' 'SELECT 1;'
if ($ver -ne '1') { "cannot connect: $ver"; exit 2 }
foreach ($db in $testDb, $prodDb) { Q 'postgres' "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null; Q 'postgres' "CREATE DATABASE $db;" | Out-Null }

"[dmcr]`nenv = test`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`nchecksum_policy = block`n`n[test]`nconn = $base/$testDb`n`n[prod]`nconn = $base/$prodDb`npromote_from = test`nout_of_order = block" |
    Set-Content -Encoding ASCII $cfg
$rules = Join-Path $tmp 'dmcr_danger.json'
'{"deployOnlyPatterns":[{"label":"DROP TABLE","regex":"(?i)\\bDROP\\s+TABLE\\b","scope":"deployOnly"}],"alwaysPatterns":[{"label":"TRUNCATE","regex":"(?i)\\bTRUNCATE\\b","scope":"always"}],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' |
    Set-Content -Encoding ASCII $rules
Remove-Item Env:DMCR_CONN, Env:DMCR_PROMOTE_FROM_CONN -ErrorAction SilentlyContinue
$env:DMCR_PSQL = $Psql; $env:DMCR_BASE_DIR = $work; $env:DMCR_DANGER_RULES = $rules; $env:DMCR_ACTOR = 'local-tester'

Mk '001_create_items' "CREATE SCHEMA app;`nCREATE TABLE app.items (id int PRIMARY KEY, name text NOT NULL);" `
   (Guard '001_create_items' "to_regclass('app.items') IS NOT NULL") "DROP TABLE app.items;`nDROP SCHEMA app;"
Mk '002_seed_items' "INSERT INTO app.items (id, name) VALUES (1, 'espresso'), (2, 'filter');" `
   (Guard '002_seed_items' "(SELECT count(*) FROM app.items WHERE id IN (1, 2)) = 2") 'DELETE FROM app.items WHERE id IN (1, 2);'
Mk '003_add_price' 'ALTER TABLE app.items ADD COLUMN price numeric(12,2);' `
   (Guard '003_add_price' "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'items' AND column_name = 'price')") `
   'ALTER TABLE app.items DROP COLUMN price;'

"== registry"
Ok (Run @('init')) 0 'init test'
Ok (Run @('init', '--env', 'prod')) 0 'init prod'

"== round-trip test on test"
Ok (Run @('test')) 0 'test: 3 changes round-trip'
Ok (Q $testDb "SELECT count(*) FROM dmcr.change_log;") '0' 'nothing recorded by test'
Ok (Q $testDb "SELECT to_regclass('app.items') IS NULL;") 't' 'test rolled everything back'

"== promotion gate"
Ok (Run @('deploy', '--env', 'prod')) 1 'prod refuses changes test has not run'
Ok (Has 'BLOCKED by promotion gate') 'yes' 'says BLOCKED by promotion gate'
Ok (Q $prodDb "SELECT count(*) FROM dmcr.change_log;") '0' 'prod untouched'

"== deploy test, tag, promote"
Ok (Run @('deploy')) 0 'deploy test'
Ok (Q $testDb "SELECT count(*) FROM dmcr.change_log;") '3' '3 applied on test'
Ok (Q $testDb "SELECT string_agg(name, ',' ORDER BY id) FROM app.items;") 'espresso,filter' 'rows on test'
Ok (Run @('tag', 'create', 'v1', 'Local release 1')) 0 'tag v1'
Ok (Run @('deploy', '--env', 'prod')) 0 'promote to prod'
Ok (Q $prodDb "SELECT count(*) FROM dmcr.change_log;") '3' '3 applied on prod'

"== checksum drift blocks prod"
$f = Join-Path $changes '002_seed_items\deploy.sql'; $orig = [IO.File]::ReadAllBytes($f)
Add-Content -Encoding UTF8 $f '-- edited after deploy'
Run @('check', '--env', 'prod') | Out-Null
Ok $(if ($script:last -match 'CHECKSUM\s+002_seed_items') { 'yes' } else { 'no' }) 'yes' 'check reports the edited file'
Ok (Run @('deploy', '--env', 'prod')) 1 'deploy blocked while the file is edited'
Ok (Has 'applied change files edited') 'yes' 'says why'
[IO.File]::WriteAllBytes($f, $orig)   # exact original bytes back
Ok (Run @('check', '--env', 'prod')) 0 'check after restoring the file'
Ok (Has 'All preflight checks passed') 'yes' 'restored file passes check'

"== revert one change, roll forward"
Ok (Run @('revert', '003_add_price')) 0 'revert 003 on test'
Ok (Q $testDb "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'app' AND column_name = 'price';") '0' 'price column gone'
Ok (Run @('deploy')) 0 'deploy 003 again'
Ok (Q $testDb "SELECT count(*) FROM dmcr.change_log;") '3' 'back to 3 applied'

"== danger_ change: deploy skips it, the DBA runs it and marks it applied"
Mk '004_danger_drop_legacy' "DROP TABLE IF EXISTS app.legacy CASCADE;" 'SELECT 1;' 'SELECT 1;'
Q $testDb 'CREATE TABLE app.legacy (id int);' | Out-Null
Ok (Run @('deploy')) 0 'deploy runs, skipping the danger_ change'
Ok (Q $testDb "SELECT count(*) FROM dmcr.change_log WHERE change_id = '004_danger_drop_legacy';") '0' 'danger_ change not recorded by deploy'
Ok (Q $testDb "SELECT to_regclass('app.legacy') IS NOT NULL;") 't' 'its SQL did not run'
Q $testDb 'DROP TABLE IF EXISTS app.legacy CASCADE;' | Out-Null   # the DBA, by hand
Ok (Run @('repair', '--mark-applied', '004_danger_drop_legacy')) 0 'repair --mark-applied'
Ok (Q $testDb "SELECT count(*) FROM dmcr.change_log WHERE change_id = '004_danger_drop_legacy';") '1' 'now recorded'

"== verify and history"
Ok (Run @('verify', 'all')) 0 'verify all on test'
Ok (Has 'FAILED') 'no' 'no verify failed'
Ok (Run @('history')) 0 'history'
Ok (Has '004_danger_drop_legacy') 'yes' 'history lists the marked change'
Ok (Q $testDb "SELECT count(*) FROM dmcr.deploy_lock;") '0' 'no lock left behind'

if (-not $Keep) {
    foreach ($db in $testDb, $prodDb) { Q 'postgres' "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null }
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
} else { "kept $testDb, $prodDb and $tmp" }
''; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
