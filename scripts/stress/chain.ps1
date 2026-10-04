# DMCR stress run on Windows: the runner (dmcr.ps1, Windows PowerShell 5.1) against PostgreSQL 16
# in Docker, driving the 22-change shop chain in scripts/stress/chain through every path:
# round-trip test, partial deploys, tags, a failure mid-chain, racing deploys, an application
# lock, drift, revert to tags, and full roll-forward — with data and schema checked at each stage.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stress\chain.ps1
# Watch it live: node scripts\stress\live\server.mjs  →  http://127.0.0.1:7788
$ErrorActionPreference = 'Continue'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo    = Split-Path -Parent (Split-Path -Parent $here)
$runner  = Join-Path $repo 'scripts\runner\dmcr.ps1'
$shim    = Join-Path $repo 'scripts\runner\tests\psql-shim.ps1'
$tmp     = Join-Path $env:TEMP 'dmcr-stress'
$work    = Join-Path $tmp 'work'; $cfgDir = Join-Path $tmp 'cfg'
$liveDir = Join-Path $env:TEMP 'dmcr-live'
$log     = if ($env:DMCR_LIVE_LOG) { $env:DMCR_LIVE_LOG } else { Join-Path $liveDir 'events.ndjson' }
$conn    = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$utf8    = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8   # dmcr.ps1 writes UTF-8; read it as UTF-8
New-Item -ItemType Directory -Force $liveDir | Out-Null
[IO.File]::WriteAllText($log, '', $utf8)

# ── live events (NDJSON) ─────────────────────────────────────────────────────
function Ev([hashtable]$e) {
    $e['t'] = (Get-Date).ToUniversalTime().ToString('o')
    [IO.File]::AppendAllText($log, (($e | ConvertTo-Json -Compress -Depth 4) + "`n"), $utf8)
}
$script:pass = 0; $script:fail = 0; $script:stepNo = 0; $script:t0 = Get-Date
function Phase([string]$name) { Ev @{ kind = 'phase'; name = $name }; ""; "######## $name" }
function Step([string]$title, [scriptblock]$body) {
    $script:stepNo++; $id = "s$($script:stepNo)"
    Ev @{ kind = 'step'; id = $id; title = $title; status = 'running' }
    "-- $title"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $failBefore = $script:fail
    & $body
    $sw.Stop()
    Ev @{ kind = 'step'; id = $id; title = $title; status = $(if ($script:fail -gt $failBefore) { 'fail' } else { 'pass' }); ms = [int]$sw.ElapsedMilliseconds }
}
function Ok($got, $want, [string]$label) {
    $okv = ("$got" -eq "$want")
    if ($okv) { $script:pass++; "   PASS  $label" } else { $script:fail++; "   FAIL  $label (got '$got', want '$want')" }
    Ev @{ kind = 'check'; label = $label; ok = $okv; got = "$got"; want = "$want" }
}

# ── database + runner helpers ────────────────────────────────────────────────
function Q([string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql 2>&1 | Out-String).Trim() }
$cfg = Join-Path $cfgDir 'dmcr.cfg'
# Runs dmcr.ps1, streaming every output line to the dashboard as it is printed.
function Dmcr([string[]]$a) {
    Ev @{ kind = 'out'; line = "> dmcr $($a -join ' ')" }
    $script:last = New-Object System.Collections.Generic.List[string]
    & powershell -NoProfile -ExecutionPolicy Bypass -File $runner -c $cfg @a 2>&1 | ForEach-Object {
        $l = ([string]$_) -replace "$([char]27)\[[0-9;]*m", ''
        $script:last.Add($l)
        if ($l.Trim()) { Ev @{ kind = 'out'; line = $l } }
    }
    $rc = $LASTEXITCODE
    Ev @{ kind = 'out'; line = "  (exit $rc)" }
    return $rc
}
function Has([string]$pattern) { [bool](@($script:last | Where-Object { $_ -like "*$pattern*" }).Count) }
function Applied { Q "SELECT count(*) FROM dmcr.change_log;" }
function IsApplied([string]$id) { Q "SELECT count(*) FROM dmcr.change_log WHERE change_id = '$id';" }
# Content hash of every shop table (rows as jsonb, order-independent) — proves data is restored exactly.
function DataSnapshot {
    Q @"
SELECT coalesce(string_agg(tablename || '=' || (xpath('/row/h/text()', query_to_xml(format('SELECT md5(coalesce(string_agg(x, '''' ORDER BY x), '''')) AS h FROM (SELECT md5(to_jsonb(t)::text) AS x FROM shop.%I t) s', tablename), false, true, '')))[1]::text, ',' ORDER BY tablename), 'empty')
FROM pg_tables WHERE schemaname = 'shop' AND tablename NOT LIKE 'events_%';
"@
}
function SchemaSnapshot {
    Q @"
SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
  SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS x FROM information_schema.columns WHERE table_schema = 'shop' AND table_name NOT IN ('customer_summary')
  UNION ALL SELECT 'idx:' || indexname FROM pg_indexes WHERE schemaname = 'shop'
  UNION ALL SELECT 'con:' || conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'shop'
  UNION ALL SELECT 'trg:' || tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'shop' AND NOT tgisinternal
) s;
"@
}
function Chain([string]$id) { Join-Path $work "changes\$id" }

Ev @{ kind = 'start'; title = '22-change shop chain · dmcr.ps1 on Windows PowerShell 5.1 · PostgreSQL 16 in Docker' }

# ══════════════════════════════════════════════════════════════════════════════
Phase 'Setup'
Step 'Start a fresh PostgreSQL 16 container' {
    docker rm -f dmcr-test-pg 2>$null | Out-Null
    docker run -d --name dmcr-test-pg -e POSTGRES_PASSWORD=dmcrtest -e POSTGRES_DB=dmcrtest postgres:16 | Out-Null
    for ($i = 0; $i -lt 60; $i++) { docker exec dmcr-test-pg pg_isready -U postgres -d dmcrtest -h localhost 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
    Ok (Q 'SELECT 1;') '1' 'PostgreSQL is up'
}
Step 'Copy the 22-change chain and write dmcr.cfg (checksum_policy = block, bundled danger rules)' {
    Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
    Copy-Item -Recurse (Join-Path $here 'chain\*') (Join-Path $work 'changes')
    "[dmcr]`nenv = staging`nchanges_dir = changes`nlock_timeout = 3s`nstatement_timeout = 10min`nchecksum_policy = block`n`n[staging]`nconn =" | Set-Content -Encoding ASCII $cfg
    $env:DMCR_PSQL = $shim; $env:DMCR_CONN = $conn; $env:DMCR_BASE_DIR = $work; $env:DMCR_ACTOR = 'stress-run'
    $env:DMCR_DANGER_RULES = Join-Path $repo 'scripts\runner\dmcr_danger.json'
    Ok (@(Get-ChildItem (Join-Path $work 'changes') -Directory).Count) 23 '22 changes + 1 repeatable in place'
}
Step 'dmcr init' { Ok (Dmcr @('init')) 0 'registry created' }
Step 'dmcr check — preflight of the whole chain' { Ok (Dmcr @('check')) 0 'check exits 0'; Ok (Has 'Preflight issues') 'False' 'no preflight issues' }

# ══════════════════════════════════════════════════════════════════════════════
Phase 'Prove the chain before touching anything (dmcr test)'
Step 'Round-trip 001-019 on real volumes (850k rows), rolled back' {
    Ok (Dmcr @('test')) 0 'dmcr test passes'
    Ok (@($script:last | Where-Object { $_ -like '*restored exactly*' }).Count) 19 '19 changes proven reversible (schema + data)'
    Ok (Has 'Stopped at 020_idx_items_product_concurrently') 'True' 'stops before the CONCURRENTLY change'
    Ok (Applied) '0' 'nothing recorded'
    Ok (Q "SELECT to_regnamespace('shop') IS NULL;") 't' 'no shop schema left behind'
}

# ══════════════════════════════════════════════════════════════════════════════
Phase 'Release 1: deploy to 009 and tag v1'
Step 'deploy --to 009_backfill_gold_tier' {
    Ok (Dmcr @('deploy', '--to', '009_backfill_gold_tier')) 0 'deploy exits 0'
    Ok (Applied) '9' '9 changes applied'
    Ok (Q 'SELECT count(*) FROM shop.order_items;') '600000' '600k order items'
    Ok (Q "SELECT count(*) > 0 FROM shop.customers WHERE tier = 'gold';") 't' 'gold customers backfilled'
}
Step 'tag create v1, snapshot data + schema' {
    Ok (Dmcr @('tag', 'create', 'v1')) 0 'tag v1'
    $script:S1data = DataSnapshot; $script:S1schema = SchemaSnapshot
    Ok ($script:S1data -ne 'empty') 'True' 'v1 snapshot taken'
}

# ══════════════════════════════════════════════════════════════════════════════
Phase 'Release 2: a broken change mid-chain, then the fix'
Step 'Break 012 (references a column that does not exist) and deploy' {
    $script:good012 = Get-Content (Join-Path (Chain '012_view_top_customers') 'deploy.sql') -Raw
    Set-Content -Encoding UTF8 (Join-Path (Chain '012_view_top_customers') 'deploy.sql') "CREATE VIEW shop.top_customers AS SELECT customer_id, lifetime_value FROM shop.customer_totals;"
    Ok (Dmcr @('deploy', '--to', '016_rename_product_name_to_title')) 1 'deploy stops with exit 1'
    Ok (Has 'lifetime_value') 'True' 'the real error is shown'
    Ok (Applied) '11' '010 and 011 applied before the failure'
    Ok (IsApplied '012_view_top_customers') '0' '012 not recorded'
    Ok (Q "SELECT to_regclass('shop.top_customers') IS NULL;") 't' 'no half-created view'
    Ok (Q 'SELECT count(*) FROM dmcr.deploy_lock;') '0' 'deploy lock released'
}
Step 'Fix 012 and continue to 016; tag v2' {
    [IO.File]::WriteAllText((Join-Path (Chain '012_view_top_customers') 'deploy.sql'), $script:good012, $utf8)
    Ok (Dmcr @('deploy', '--to', '016_rename_product_name_to_title')) 0 'deploy 012-016'
    Ok (Applied) '16' '16 applied'
    Ok (Q "SELECT count(*) FROM shop.orders WHERE total <> (SELECT coalesce(sum(qty * unit_price), 0) FROM shop.order_items i WHERE i.order_id = orders.id);") '0' 'orders.total matches items for all 200k orders'
    Ok (Q 'SELECT count(*) FROM shop.events;') '90000' '90k partitioned events'
    Ok (Dmcr @('tag', 'create', 'v2')) 0 'tag v2'
    $script:S2data = DataSnapshot; $script:S2schema = SchemaSnapshot
}

# ══════════════════════════════════════════════════════════════════════════════
Phase 'Release 3: the rest of the chain'
Step 'dmcr test on 017-019 first' {
    Ok (Dmcr @('test')) 0 'round trip passes'
    Ok (@($script:last | Where-Object { $_ -like '*restored exactly*' }).Count) 3 '017, 018, 019 proven reversible'
}
Step 'deploy everything (danger_ change must be skipped)' {
    Ok (Dmcr @('deploy')) 0 'deploy exits 0'
    Ok (IsApplied '020_idx_items_product_concurrently') '1' 'CONCURRENTLY change applied (no transaction)'
    Ok (Q "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('shop.idx_items_product');") 't' 'index valid'
    Ok (IsApplied '021_danger_drop_legacy_events') '0' 'danger_ change NOT run'
    Ok (Q "SELECT to_regclass('shop.events_2026_01') IS NOT NULL;") 't' 'its partition is still there'
    Ok (IsApplied '022_add_order_note') '1' '022 applied after the skipped danger_ change'
    Ok (Q "SELECT count(*) FROM dmcr.repeatable_log;") '1' 'repeatable view applied'
}
Step 'Data after release 3' {
    Ok (Q "SELECT count(*) FROM shop.addresses;") '50000' 'addresses moved to their own table'
    Ok (Q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customers' AND column_name = 'address';") '0' 'customers.address dropped'
    Ok (Q "SELECT count(*) FROM shop.products p JOIN shop._bak_018_prices b USING (id) WHERE p.price <> round(b.price * 1.10, 2);") '0' 'every price +10%'
    Ok (Q "SELECT count(*) FROM shop.order_items i JOIN shop.products p ON p.id = i.product_id WHERE i.unit_price <> p.price;") '0' '600k items repriced'
    Ok (Q "SELECT count(*) FROM shop.orders WHERE total <> (SELECT coalesce(sum(qty * unit_price), 0) FROM shop.order_items i WHERE i.order_id = orders.id);") '0' 'trigger kept every orders.total right'
}
Step 'verify all' { Ok (Dmcr @('verify', 'all')) 0 'verify all passes' }

# ══════════════════════════════════════════════════════════════════════════════
Phase 'Production hazards'
Step 'Two deploys at the same time' {
    $d = Chain '023_slow_change'; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') "SELECT pg_sleep(6);`nALTER TABLE shop.orders ADD COLUMN channel text;"
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '023_slow_change') <> EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders' AND column_name = 'channel') THEN RAISE EXCEPTION 'channel mismatch'; END IF; END `$`$;"
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') "ALTER TABLE shop.orders DROP COLUMN channel;"
    $o1 = Join-Path $tmp 'race1.txt'; $o2 = Join-Path $tmp 'race2.txt'
    $p1 = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runner`"", '-c', "`"$cfg`"", 'deploy') -RedirectStandardOutput $o1 -RedirectStandardError "$o1.err" -PassThru -NoNewWindow
    $null = $p1.Handle
    Start-Sleep -Seconds 2
    $p2 = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$runner`"", '-c', "`"$cfg`"", 'deploy') -RedirectStandardOutput $o2 -RedirectStandardError "$o2.err" -PassThru -NoNewWindow
    $null = $p2.Handle
    $p1.WaitForExit(); $p2.WaitForExit()
    foreach ($f in $o2, "$o2.err") { Get-Content $f -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Trim()) { Ev @{ kind = 'out'; line = "[second deploy] $($_ -replace "$([char]27)\[[0-9;]*m", '')" } } } }
    Ok ($p1.ExitCode + $p2.ExitCode) 1 'exactly one deploy refused'
    Ok ([bool](Select-String -Path $o2, "$o2.err" -Pattern 'lock' -Quiet)) 'True' 'the second one reports the deploy lock'
    Ok (IsApplied '023_slow_change') '1' '023 applied exactly once'
}
Step 'The application holds a lock on shop.orders' {
    $d = Chain '024_order_flag'; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') "ALTER TABLE shop.orders ADD COLUMN flagged boolean;"
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '024_order_flag') <> EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders' AND column_name = 'flagged') THEN RAISE EXCEPTION 'flagged mismatch'; END IF; END `$`$;"
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') "ALTER TABLE shop.orders DROP COLUMN flagged;"
    docker exec -d dmcr-test-pg psql $conn -X -q -c "BEGIN; LOCK TABLE shop.orders IN ACCESS SHARE MODE; SELECT pg_sleep(20); COMMIT;" | Out-Null
    Start-Sleep -Seconds 1
    $sw = [Diagnostics.Stopwatch]::StartNew(); $rc = Dmcr @('deploy'); $sw.Stop()
    Ok $rc 1 'deploy gives up'
    Ok ($(if ($sw.Elapsed.TotalSeconds -lt 18) { 'before the lock was released' } else { "after $([int]$sw.Elapsed.TotalSeconds)s" })) 'before the lock was released' "after lock_timeout ($([int]$sw.Elapsed.TotalSeconds)s), not after the 20s application lock"
    Ok (IsApplied '024_order_flag') '0' 'nothing recorded'
    Start-Sleep -Seconds 20
    Ok (Dmcr @('deploy')) 0 'deploys once the lock is gone'
}
Step 'Someone edits an applied revert.sql' {
    $f = Join-Path (Chain '019_reprice_order_items') 'revert.sql'
    $orig = Get-Content $f -Raw
    Add-Content -Encoding UTF8 $f "-- tweaked after release"
    Ok (Dmcr @('deploy')) 1 'deploy refuses'
    Ok (Has '019_reprice_order_items/revert.sql') 'True' 'names the edited file'
    [IO.File]::WriteAllText($f, $orig, $utf8)
    Ok (Dmcr @('check')) 0 'check is clean after restoring it'
}

# ══════════════════════════════════════════════════════════════════════════════
Phase 'Roll back and forward'
Step 'revert to @v2 (024 → 017, incl. the CONCURRENTLY index and the 600k-row reprice)' {
    Ok (Dmcr @('revert', 'to', '@v2')) 0 'revert to @v2'
    Ok (Applied) '16' 'back to 16 applied'
    Ok (DataSnapshot) $script:S2data 'every shop table has exactly the v2 data'
    Ok (SchemaSnapshot) $script:S2schema 'schema is exactly v2'
}
Step 'dmcr test, then roll forward again' {
    Ok (Dmcr @('test')) 0 'round trip of 017-019 still passes'
    Ok (Dmcr @('deploy')) 0 'deploy everything again'
    Ok (Applied) '23' '23 applied (all but the danger_ change)'
}
Step 'revert to @v1 (024 → 010: 15 changes, triggers, partitions, views on views)' {
    Ok (Dmcr @('revert', 'to', '@v1')) 0 'revert to @v1'
    Ok (Applied) '9' 'back to 9 applied'
    Ok (DataSnapshot) $script:S1data 'every shop table has exactly the v1 data'
    Ok (SchemaSnapshot) $script:S1schema 'schema is exactly v1'
}
Step 'Final roll forward and verify' {
    Ok (Dmcr @('deploy')) 0 'deploy everything'
    Ok (Applied) '23' '23 applied'
    Ok (Dmcr @('verify', 'all')) 0 'verify all'
    Ok (Dmcr @('check')) 0 'check clean'
    Ok (Q 'SELECT count(*) FROM dmcr.deploy_lock;') '0' 'no lock left behind'
}

$elapsed = [int]((Get-Date) - $script:t0).TotalSeconds
$summary = "$($script:pass) checks passed, $($script:fail) failed in $([int]($elapsed / 60))m $($elapsed % 60)s"
Ev @{ kind = 'end'; summary = $summary }
""; "RESULT: $summary"
if ($script:fail -gt 0) { exit 1 }
