# Tests for `dmcr test` (round-trip test) in dmcr.ps1 — Windows PowerShell 5.1, psql in the
# dmcr-test-pg container through psql-shim.ps1. Same scenarios as roundtrip.sh.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'twork'; $cfgDir = Join-Path $tmp 'tcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$conn = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_CONN = $conn; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
$cfg = Join-Path $cfgDir 'dmcr.cfg'
function Write-Cfg($envName) { "[dmcr]`nenv = $envName`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n`n[$envName]`nconn =" | Set-Content -Encoding ASCII $cfg }
Write-Cfg 'staging'
'{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$script:pass = 0; $script:fail = 0
function Q([string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ } }
function Run([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }; return $LASTEXITCODE }
function Has([string]$text) { [bool](@($script:last | Where-Object { $_ -like "*$text*" }).Count) }
function Mk($id, $deploy, $verify, $revert, $meta) {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') $revert
    if ($meta) { Set-Content -Encoding UTF8 (Join-Path $d 'meta.json') $meta }
}
function GuardCol($id, $s, $t, $c) { "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='$id') <> EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='$s' AND table_name='$t' AND column_name='$c') THEN RAISE EXCEPTION 'column mismatch'; END IF; END `$`$;" }
function Fingerprint { Q "SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type, ',' ORDER BY 1)) FROM information_schema.columns WHERE table_schema='app';" }

Q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE;" | Out-Null
Q "CREATE SCHEMA app; CREATE TABLE app.orders (id int PRIMARY KEY, status text); INSERT INTO app.orders SELECT g, CASE WHEN g <= 10 THEN 'old' END FROM generate_series(1, 5000) g;" | Out-Null
Run @('init') | Out-Null

"== a correct change round-trips"
Mk '001_add_note' "ALTER TABLE app.orders ADD COLUMN note text; UPDATE app.orders SET note = 'n' WHERE id < 100;" (GuardCol '001_add_note' 'app' 'orders' 'note') 'ALTER TABLE app.orders DROP COLUMN note;'
$before = Fingerprint
Ok (Run @('test')) 0 'dmcr test passes'
Ok (Has 'restored exactly') 'True' 'reports schema and data restored'
Ok (Fingerprint) $before 'database schema unchanged afterwards'
Ok (Q "SELECT count(*) FROM dmcr.change_log;") '0' 'registry unchanged afterwards'

"== a revert that loses data is caught"
Mk '002_backfill' "UPDATE app.orders SET status = 'new' WHERE status IS NULL;" 'SELECT 1;' "UPDATE app.orders SET status = NULL WHERE status IN ('new', 'old');"
Ok (Run @('test')) 1 'dmcr test fails'
Ok (Has 'data in app.orders is not the same after revert') 'True' 'names the table whose data was not restored'
Ok (Q "SELECT count(*) FROM app.orders WHERE status = 'old';") '10' 'real data untouched'
Set-Content -Encoding UTF8 (Join-Path $work 'changes\002_backfill\revert.sql') "UPDATE app.orders SET status = NULL WHERE status = 'new';"
Ok (Run @('test')) 0 'fixed revert passes'

"== a revert that leaves an object behind is caught"
Mk '003_idx' 'CREATE INDEX ix_orders_status ON app.orders(status);' 'SELECT 1;' 'SELECT 1; -- forgot DROP INDEX'
Ok (Run @('test')) 1 'dmcr test fails'
Ok (Has 'left behind by revert: index app.ix_orders_status') 'True' 'names the index revert forgot'
Ok (Q "SELECT to_regclass('app.ix_orders_status') IS NULL;") 't' 'no index left in the database'
Set-Content -Encoding UTF8 (Join-Path $work 'changes\003_idx\revert.sql') 'DROP INDEX app.ix_orders_status;'

"== verify.sql must pass in both states; a failing revert is caught"
Mk '004_bad_verify' 'ALTER TABLE app.orders ADD COLUMN flag boolean;' "DO `$`$ BEGIN RAISE EXCEPTION 'verify always fails'; END `$`$;" 'ALTER TABLE app.orders DROP COLUMN flag;'
Ok (Run @('test')) 1 'failing verify fails the test'
Ok (Has 'verify always fails') 'True' 'reports the verify error'
Remove-Item -Recurse -Force (Join-Path $work 'changes\004_bad_verify')
Mk '004_broken_revert' 'ALTER TABLE app.orders ADD COLUMN flag boolean;' 'SELECT 1;' 'ALTER TABLE app.orders DROP COLUMN no_such_column;'
Ok (Run @('test')) 1 'failing revert fails the test'
Ok (Has 'no_such_column') 'True' 'reports the revert error'
Remove-Item -Recurse -Force (Join-Path $work 'changes\004_broken_revert')

"== --json, and stopping at changes that can't be rolled back"
Mk '004_concurrent' 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_id2 ON app.orders(id);' 'SELECT 1;' 'DROP INDEX CONCURRENTLY IF EXISTS app.ix_orders_id2;' '{"transaction": false}'
Mk '005_vacuum' 'VACUUM app.orders;' 'SELECT 1;' 'SELECT 1;' '{"transaction": false}'
$rc = Run @('test', '--json')
Ok $rc 0 'everything testable passes'
$j = (($script:last | Where-Object { $_ -notmatch '^\s*(INFO|DEBUG)' }) -join "`n") | ConvertFrom-Json
Ok ((@($j.changes) | ForEach-Object { "$($_.change_id):$($_.status)" }) -join ',') '001_add_note:pass,002_backfill:pass,003_idx:pass,004_concurrent:pass' 'CONCURRENTLY index change is tested in the transaction'
Ok ([bool](@($j.changes) | Where-Object { $_.change_id -eq '004_concurrent' -and $_.details -match 'tested without CONCURRENTLY' })) 'True' 'says it was tested without CONCURRENTLY'
Ok $j.stopped_at.change_id '005_vacuum' 'stops at a change that cannot run in a transaction'
Remove-Item -Recurse -Force (Join-Path $work 'changes\004_concurrent'), (Join-Path $work 'changes\005_vacuum')
Ok (Run @('test', '--to', '002_backfill')) 0 'test --to'
Ok (Has '003_idx') 'False' 'stopped at the --to target'

"== safety: production needs --allow-prod; applied changes are skipped"
Write-Cfg 'prod'
Ok (Run @('test')) 1 'refuses an environment named prod'
Ok (Has 'allow-prod') 'True' 'explains --allow-prod'
Write-Cfg 'staging'
Ok (Run @('deploy', '--to', '001_add_note')) 0 'deploy 001 for real'
Ok (Run @('test')) 0 'test skips applied changes'
Ok (Has '001_add_note') 'False' '001 not tested again'
Ok (Q "SELECT count(*) FROM dmcr.change_log;") '1' 'only the real deploy is recorded'

""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
