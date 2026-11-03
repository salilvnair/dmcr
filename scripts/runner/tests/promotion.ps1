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
function Q($conn, [string]$sql) { (docker exec -i $env:DMCR_TEST_PG psql $conn -X -t -A -c $sql | Out-String).Trim() }
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

"== events: what DMCR copies into git"
$j = (& powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg events --env prod 2>$null | Out-String)
$ev = ($j.Substring($j.IndexOf('{"')) | ConvertFrom-Json)
Ok $ev.locked $false 'no run in progress'
Ok (@($ev.events | Where-Object { $_.action -in 'lock', 'unlock' }).Count) 0 'leaves out the lock bookkeeping'
Ok ((@($ev.events | Where-Object { $_.action -eq 'deploy' -and $_.status -eq 'success' }) | ForEach-Object { $_.change_id } | Sort-Object) -join ',') '001_t1,003_t3,004_t4' 'lists what prod deployed'
$j = (& powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg events 2099-01-01T00:00:00Z --env prod 2>$null | Out-String)
Ok (@(($j.Substring($j.IndexOf('{"')) | ConvertFrom-Json).events).Count) 0 'since a later time: nothing'
Ok (Run @('events', 'x''; DROP TABLE dmcr.event_log; --', '--env', 'prod')) 1 'a bad time is refused'

"== round trip before a deploy"
Mk '005_bad_verify' 'bad'
Set-Content -Encoding UTF8 (Join-Path $work 'changes/005_bad_verify/verify.sql') 'SELECT 1 FROM app.bad LIMIT 1;'
$before = Applied $test
Ok (Run @('deploy', '--dry-run')) 0 'a dry run itself still exits 0'
Ok (Has 'the deploy would be BLOCKED') 'True' 'a dry run says the deploy would be refused'
Ok (Run @('deploy')) 1 'a verify.sql that fails after the revert blocks the deploy'
Ok (Has 'BLOCKED by round-trip test (test)') 'True' 'says why'
Ok (Has '005_bad_verify failed the round trip') 'True' 'names the change'
Ok (Has 'does not exist') 'True' 'gives the database error'
Ok (Applied $test) $before 'nothing was applied'
Ok (Q $test "SELECT to_regclass('app.bad') IS NULL;") 't' 'the test left nothing behind'
Set-Content -Encoding UTF8 (Join-Path $work 'changes/005_bad_verify/verify.sql') "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '005_bad_verify') AND to_regclass('app.bad') IS NULL THEN RAISE EXCEPTION 'missing'; END IF; END `$`$;"
Ok (Run @('deploy')) 0 'fixed, it deploys'
Ok (Has 'Round-trip test OK') 'True' 'and says the test passed'
Ok (Applied $test) "$before,005_bad_verify" 'applied once'
Ok (Run @('deploy', '--env', 'prod')) 1 'prod still needs the out-of-order change sorted, not a round trip'
Ok (Has 'BLOCKED by round-trip test') 'False' 'production never runs the round trip'

"== production has the gate with no promote_from"
$cfgNoFrom = (Get-Content -Raw $cfg) -replace '(?m)^promote_from = test\s*$', ''
$cfgNoFrom = "[envs]`nnames = test, prod`n`n" + $cfgNoFrom
$saved = Get-Content -Raw $cfg
Set-Content -Encoding ASCII $cfg $cfgNoFrom
Mk '006_t7' 't7'
Ok (Run @('deploy', '--env', 'prod', '--to', '006_t7')) 1 'prod refuses what test has not run'
Ok (Has '006_t7 is not applied in test') 'True' 'the environment before it is the source'
Set-Content -Encoding ASCII $cfg $saved
Remove-Item -Recurse -Force (Join-Path $work 'changes/006_t7')

"== round_trip_check in dmcr.cfg"
Mk '006_bad_again' 'bad2'
Set-Content -Encoding UTF8 (Join-Path $work 'changes/006_bad_again/verify.sql') 'SELECT 1 FROM app.bad2 LIMIT 1;'
Set-Content -Encoding ASCII $cfg ($saved -replace '\[dmcr\]', "[dmcr]`nround_trip_check = sometimes")
Ok (Run @('deploy')) 1 'an unknown value stops the deploy'
Ok (Has "Invalid round_trip_check 'sometimes'") 'True' 'and says so'
Set-Content -Encoding ASCII $cfg ($saved -replace '\[dmcr\]', "[dmcr]`nround_trip_check = off")
Ok (Run @('deploy')) 0 'off: the deploy does not run it'
Ok (Has 'Round-trip test OK') 'False' 'and does not say it passed'
Set-Content -Encoding ASCII $cfg $saved

Q $test "DROP DATABASE IF EXISTS dmcrprod WITH (FORCE);" | Out-Null
""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
