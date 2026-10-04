# Tests for the deploy plan guards in dmcr.ps1: promote_from (promotion gate) and out_of_order.
# Two databases in the dmcr-test-pg container stand in for test and prod. Same scenarios as promotion.sh.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'pwork'; $cfgDir = Join-Path $tmp 'pcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$test = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$prod = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrprod'
Remove-Item Env:DMCR_CONN, Env:DMCR_PROMOTE_FROM_CONN -ErrorAction SilentlyContinue
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
$cfg = Join-Path $cfgDir 'dmcr.cfg'
"[dmcr]`nenv = test`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n`n[test]`nconn = $test`n`n[prod]`nconn = $prod`npromote_from = test`nout_of_order = block" | Set-Content -Encoding ASCII $cfg
'{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$script:pass = 0; $script:fail = 0
function Q($conn, [string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ } }
function Run([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }; return $LASTEXITCODE }
function Has([string]$text) { [bool](@($script:last | Where-Object { $_ -like "*$text*" }).Count) }
function Mk($id, $t) {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') "CREATE TABLE app.$t (id int);"
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') 'SELECT 1;'
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') "DROP TABLE app.$t;"
}
function Applied($conn) { Q $conn "SELECT coalesce(string_agg(change_id, ',' ORDER BY change_id), '') FROM dmcr.change_log;" }

Q $test "DROP DATABASE IF EXISTS dmcrprod WITH (FORCE);" | Out-Null
Q $test "CREATE DATABASE dmcrprod;" | Out-Null
Q $test "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;" | Out-Null
Q $prod "CREATE SCHEMA app;" | Out-Null
Run @('init') | Out-Null; Run @('init', '--env', 'prod') | Out-Null

"== prod refuses what test has not run"
Mk '001_t1' 't1'
Ok (Run @('deploy', '--env', 'prod')) 1 'deploy to prod is blocked'
Ok (Has '001_t1 is not applied in test') 'True' 'names the change test has not run'
Ok (Applied $prod) '' 'nothing applied in prod'

"== test first, then prod"
Ok (Run @('deploy')) 0 'deploy to test'
Ok (Run @('deploy', '--env', 'prod')) 0 'deploy to prod'
Ok (Has 'Promotion gate OK') 'True' 'gate reports OK'
Ok (Applied $prod) '001_t1' 'prod has 001'

"== files edited after test ran them are refused"
Mk '002_danger_t2' 't2'   # manual-only: skipped by deploy in both environments
Mk '003_t3' 't3'
Ok (Run @('deploy')) 0 'deploy 003 to test'
Add-Content -Encoding UTF8 (Join-Path $work 'changes\003_t3\deploy.sql') '-- edited'
Ok (Run @('deploy', '--env', 'prod')) 1 'edited change is blocked'
Ok (Has '003_t3/deploy.sql differs from the one applied in test') 'True' 'names the edited file'
Ok (Applied $prod) '001_t1' 'prod unchanged'
Mk '003_t3' 't3'
Ok (Run @('deploy', '--env', 'prod')) 0 'restored file promotes'

"== the source registry must be readable; --to limits the plan"
Mk '004_t4' 't4'
Ok (Run @('deploy')) 0 'deploy 004 to test'
$env:DMCR_PROMOTE_FROM_CONN = 'postgresql://postgres:dmcrtest@localhost:5432/no_such_db'
Ok (Run @('deploy', '--env', 'prod')) 1 'unreadable source blocks'
Ok (Has "cannot read the DMCR registry of 'test'") 'True' 'says the source could not be read'
Remove-Item Env:DMCR_PROMOTE_FROM_CONN
Mk '005_t5' 't5'
Ok (Run @('deploy', '--env', 'prod', '--to', '004_t4')) 0 '--to stops before a change test has not run'
Ok (Applied $prod) '001_t1,003_t3,004_t4' 'prod has 001,003,004'
Ok (Run @('deploy', '--env', 'prod')) 1 '005 is still blocked'
Remove-Item -Recurse -Force (Join-Path $work 'changes\005_t5')

"== out_of_order = block"
Rename-Item (Join-Path $work 'changes\002_danger_t2') '002_t2'   # later cleared for normal deploys
Ok (Run @('deploy')) 0 'test allows out of order (default)'
Ok (Run @('deploy', '--env', 'prod')) 1 'prod blocks out of order'
Ok (Has '002_t2 is out of order: 004_t4 is already applied') 'True' 'names the out-of-order change'
Ok (Applied $prod) '001_t1,003_t3,004_t4' 'prod unchanged'

Q $test "DROP DATABASE IF EXISTS dmcrprod WITH (FORCE);" | Out-Null
""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
