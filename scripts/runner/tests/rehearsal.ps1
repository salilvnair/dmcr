# Production-style rehearsal for dmcr.ps1 (Windows PowerShell 5.1; psql runs in the
# dmcr-test-pg container through psql-shim.ps1). Same scenarios as rehearsal.sh.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'rwork'; $cfgDir = Join-Path $tmp 'rcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$conn = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_CONN = $conn; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'rehearsal'
"[dmcr]`nenv = staging`nchanges_dir = changes`nlock_timeout = 3s`nstatement_timeout = 2min`nchecksum_policy = block`n`n[staging]`nconn =" | Set-Content -Encoding ASCII (Join-Path $cfgDir 'dmcr.cfg')
'{"deployOnlyPatterns":[{"label":"DROP TABLE","regex":"(?i)\\bDROP\\s+TABLE\\b","scope":"deployOnly"}],"alwaysPatterns":[{"label":"TRUNCATE","regex":"(?i)\\bTRUNCATE\\b","scope":"always"}],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":true}' |
    Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$cfg = Join-Path $cfgDir 'dmcr.cfg'
$script:pass = 0; $script:fail = 0
function Q([string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) {
    if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ }
}
function Run([string[]]$a) {
    $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }
    return $LASTEXITCODE
}
function Show { $script:last | Select-String -Pattern 'BLOCKED|ERROR|lock|edited|transaction' | Select-Object -First 2 | ForEach-Object { "        $($_.Line.Trim())" } }
function Mk($id, $deploy, $verify, $revert, $meta) {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') $revert
    if ($meta) { Set-Content -Encoding UTF8 (Join-Path $d 'meta.json') $meta }
}
function Applied($id) { Q "SELECT count(*) FROM dmcr.change_log WHERE change_id='$id';" }
function GuardCol($id, $s, $t, $c) { "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='$id') <> EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='$s' AND table_name='$t' AND column_name='$c') THEN RAISE EXCEPTION 'column $s.$t.$c does not match registry state'; END IF; END `$`$;" }
function GuardRel($id, $rel) { "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='$id') <> (to_regclass('$rel') IS NOT NULL) THEN RAISE EXCEPTION '$rel does not match registry state'; END IF; END `$`$;" }

"== setup: app schema with 200k customers and 500k orders"
Q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE;" | Out-Null
Q "CREATE SCHEMA app; CREATE TABLE app.customers (id bigserial PRIMARY KEY, email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO app.customers(email) SELECT 'user'||g||'@example.com' FROM generate_series(1,200000) g; CREATE TABLE app.orders (id bigserial PRIMARY KEY, customer_id bigint NOT NULL REFERENCES app.customers(id), amount numeric(10,2) NOT NULL, status text); INSERT INTO app.orders(customer_id, amount) SELECT 1 + (g % 200000), (g % 997) / 10.0 FROM generate_series(1,500000) g; ANALYZE app.customers; ANALYZE app.orders;" | Out-Null
Ok (Q "SELECT count(*) FROM app.orders;") '500000' 'seeded 500k orders'
Ok (Run @('init')) 0 'init registry'
Run @('status','--json') | Out-Null
Ok (($script:last -join "`n").Trim().StartsWith('[')) 'True' 'status --json with no changes is a JSON array'

"== a release with a dependency chain and a failing change in the middle"
Mk '001_orders_note' 'ALTER TABLE app.orders ADD COLUMN note text;' (GuardCol '001_orders_note' 'app' 'orders' 'note') 'ALTER TABLE app.orders DROP COLUMN note;'
Mk '002_idx_orders_customer' 'CREATE INDEX idx_orders_customer ON app.orders(customer_id);' (GuardRel '002_idx_orders_customer' 'app.idx_orders_customer') 'DROP INDEX app.idx_orders_customer;'
Mk '003_view_customer_totals' 'CREATE VIEW app.customer_totals AS SELECT customer_id, sum(amount) AS total FROM app.orders GROUP BY customer_id;' (GuardRel '003_view_customer_totals' 'app.customer_totals') 'DROP VIEW app.customer_totals;' '{"requires":["002_idx_orders_customer"]}'
Mk '004_backfill_status' "UPDATE app.orders SET status = 'new' WHERE status IS NULL;" "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='004_backfill_status') AND EXISTS (SELECT 1 FROM app.orders WHERE status IS NULL) THEN RAISE EXCEPTION 'unbackfilled rows'; END IF; END `$`$;" "UPDATE app.orders SET status = NULL WHERE status = 'new';"
Mk '005_customer_tier' "ALTER TABLE app.customers ADD COLUMN tier text NOT NULL DEFAULT 'basic';" (GuardCol '005_customer_tier' 'app' 'customers' 'tier') 'ALTER TABLE app.customers DROP COLUMN tier;'
Mk '006_broken' "ALTER TABLE app.customers ADD COLUMN half_done int;`nUPDATE app.customers SET half_done = 1 WHERE id < 10;`nSELECT * FROM app.table_that_does_not_exist;" 'SELECT 1;' 'ALTER TABLE app.customers DROP COLUMN half_done;'
Ok (Run @('deploy','--to','001_orders_note')) 0 'deploy the first change'
Run @('status','--json') | Out-Null
$st = ($script:last -join "`n") | ConvertFrom-Json
Ok (@($st | Where-Object { $_.status -eq 'applied' }).Count) 1 'status --json with one applied change is still an array'
Ok (Run @('deploy','--to','004_backfill_status')) 0 'deploy up to 004'
Ok (Run @('tag','create','v1')) 0 'tag v1 at 004'
Ok (Run @('deploy')) 1 'rest of the batch, with a failing 6th change, exits 1'; Show
Ok (Q "SELECT count(*) FROM dmcr.change_log;") '5' 'the five good changes stay applied'
Ok (Q "SELECT count(*) FROM information_schema.columns WHERE table_name='customers' AND column_name='half_done';") '0' 'nothing of the failed change is left'
Ok (Q "SELECT count(*) FROM app.orders WHERE status IS NULL;") '0' 'backfill applied to all 500k rows'
Ok (Q "SELECT count(*) FROM dmcr.deploy_lock;") '0' 'deploy lock released after the failure'
Mk '006_broken' 'ALTER TABLE app.customers ADD COLUMN half_done int;' (GuardCol '006_broken' 'app' 'customers' 'half_done') 'ALTER TABLE app.customers DROP COLUMN half_done;'
Ok (Run @('deploy')) 0 'fixed change deploys on the next run'

"== the application holds a lock: deploy must give up after lock_timeout"
Mk '007_customer_flag' 'ALTER TABLE app.customers ADD COLUMN flagged boolean;' (GuardCol '007_customer_flag' 'app' 'customers' 'flagged') 'ALTER TABLE app.customers DROP COLUMN flagged;'
docker exec -d dmcr-test-pg psql $conn -X -q -c "BEGIN; LOCK TABLE app.customers IN ACCESS SHARE MODE; SELECT pg_sleep(15); COMMIT;" | Out-Null
Start-Sleep -Seconds 1
$sw = [Diagnostics.Stopwatch]::StartNew(); $rc = Run @('deploy'); $sw.Stop()
Ok $rc 1 'deploy fails while the table is locked'; Show
Ok ($(if ($sw.Elapsed.TotalSeconds -lt 14) { 'fast' } else { "slow $([int]$sw.Elapsed.TotalSeconds)s" })) 'fast' "it failed after lock_timeout ($([int]$sw.Elapsed.TotalSeconds)s), not after the 15s lock"
Ok (Applied '007_customer_flag') '0' 'nothing recorded for 007'
Ok (Q "SELECT count(*) FROM dmcr.deploy_lock;") '0' 'deploy lock released'
Start-Sleep -Seconds 15
Ok (Run @('deploy')) 0 'deploy succeeds once the application lock is gone'

"== two deploys racing"
Mk '008_slow' 'SELECT pg_sleep(4); CREATE TABLE app.audit_marker (id int);' (GuardRel '008_slow' 'app.audit_marker') 'DROP TABLE app.audit_marker;'
$o1 = Join-Path $tmp 'race1.txt'; $o2 = Join-Path $tmp 'race2.txt'
$p1 = Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$script`"",'-c',"`"$cfg`"",'deploy') -RedirectStandardOutput $o1 -RedirectStandardError "$o1.err" -PassThru -NoNewWindow
$null = $p1.Handle   # PS 5.1: without touching Handle, ExitCode stays empty
Start-Sleep -Seconds 1
$p2 = Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$script`"",'-c',"`"$cfg`"",'deploy') -RedirectStandardOutput $o2 -RedirectStandardError "$o2.err" -PassThru -NoNewWindow
$null = $p2.Handle
$p1.WaitForExit(); $p2.WaitForExit()
Ok ($p1.ExitCode + $p2.ExitCode) 1 'exactly one of the two deploys fails'
$loser = if ($p1.ExitCode -ne 0) { $o1 } else { $o2 }
Ok ([bool](Select-String -Path $loser, "$loser.err" -Pattern 'lock' -Quiet)) 'True' 'the loser reports the deploy lock'
Ok (Applied '008_slow') '1' '008 applied exactly once'

"== editing an applied change is caught (checksum_policy = block)"
$f001 = Join-Path $work 'changes\001_orders_note\deploy.sql'
Set-Content -Encoding UTF8 $f001 "-- edited after release`nALTER TABLE app.orders ADD COLUMN note text;"
Ok (Run @('deploy')) 1 'deploy refuses while an applied deploy.sql was edited'; Show
Run @('check','--json') | Out-Null
Ok ([bool]($script:last -match '001_orders_note')) 'True' 'check reports the edited change'
Set-Content -Encoding UTF8 $f001 'ALTER TABLE app.orders ADD COLUMN note text;'
Ok (Run @('deploy')) 0 'restoring the file clears it'

"== revert to the v1 tag, then roll forward again"
Ok (Run @('revert','to','@v1')) 0 'revert to @v1'
Ok (Q "SELECT string_agg(change_id, ',' ORDER BY change_id) FROM dmcr.change_log;") '001_orders_note,002_idx_orders_customer,003_view_customer_totals,004_backfill_status' 'only 001-004 remain applied'
Ok (Q "SELECT count(*) FROM information_schema.columns WHERE table_name='customers' AND column_name IN ('tier','half_done','flagged');") '0' '005-007 columns removed'
Ok (Q "SELECT count(*) FROM app.orders WHERE status = 'new';") '500000' 'v1 data kept'
Ok (Run @('deploy')) 0 'roll forward'
Ok (Q "SELECT count(*) FROM dmcr.change_log;") '8' 'all eight applied again'
Ok (Run @('verify','all')) 0 'verify all'

"== CREATE INDEX CONCURRENTLY with meta.json transaction:false"
Mk '009_idx_orders_status_concurrently' 'CREATE INDEX CONCURRENTLY idx_orders_status ON app.orders(status);' (GuardRel '009_idx_orders_status_concurrently' 'app.idx_orders_status') 'DROP INDEX CONCURRENTLY IF EXISTS app.idx_orders_status;' '{"transaction": false}'
Ok (Run @('deploy')) 0 'concurrent index change deploys'; Show
Ok (Q "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('app.idx_orders_status');") 't' 'index exists and is valid'
Ok (Applied '009_idx_orders_status_concurrently') '1' '009 recorded'
Ok (Run @('revertLast')) 0 'revert the concurrent index'
Ok (Q "SELECT to_regclass('app.idx_orders_status') IS NULL;") 't' 'index dropped'
Ok (Applied '009_idx_orders_status_concurrently') '0' '009 no longer recorded'
Mk '010_unique_customer_on_orders' 'CREATE UNIQUE INDEX CONCURRENTLY idx_orders_customer_unique ON app.orders(customer_id);' 'SELECT 1;' 'DROP INDEX CONCURRENTLY IF EXISTS app.idx_orders_customer_unique;' '{"transaction": false}'
Ok (Run @('deploy')) 1 'a failing non-transactional change exits 1'; Show
Ok (Applied '010_unique_customer_on_orders') '0' '010 not recorded'
Ok (Q "SELECT count(*) FROM dmcr.deploy_lock;") '0' 'no lock left behind'

""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
