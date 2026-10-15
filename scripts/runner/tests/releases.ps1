# Tests for releases, projects and change kinds in dmcr.ps1 (releases.json, meta.json project/kind/
# requested_by/created_by/status, deploy --release/--project, revert --project/--release/--kind,
# release list/show). Same scenarios as releases.sh.
#
# The scenario: zp_lookup_data has 100 rows. Project A adds 20 rows and fills custom1/custom2 on 10 rows;
# project B adds 20 rows and fills custom7/custom8 on 10 rows. All of it runs in ST (dmcrtest).
# Project A is then not going, so prod (dmcrprod, promote_from = test, out_of_order = block) gets only
# project B; A follows in a later release. In ST each kind of project change is rolled back on its own.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'rwork'; $cfgDir = Join-Path $tmp 'rcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$st   = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$prod = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrprod'
Remove-Item Env:DMCR_CONN, Env:DMCR_PROMOTE_FROM_CONN -ErrorAction SilentlyContinue
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
$cfg = Join-Path $cfgDir 'dmcr.cfg'
"[dmcr]`nenv = test`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n`n[test]`nconn = $st`n`n[prod]`nconn = $prod`npromote_from = test`nout_of_order = block" | Set-Content -Encoding ASCII $cfg
'{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$changes = Join-Path $work 'changes'
$script:pass = 0; $script:fail = 0
function Q($conn, [string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ } }
function Run([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }; return $LASTEXITCODE }
function Has([string]$text) { [bool](@($script:last | Where-Object { $_ -like "*$text*" }).Count) }
# The JSON document in the last output (log lines around it are skipped)
function J {
    $lines = @($script:last)
    $start = -1; $end = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($start -lt 0 -and $lines[$i] -match '^\s*[\[{]') { $start = $i }; if ($lines[$i] -match '[\]}]\s*$') { $end = $i } }
    if ($start -lt 0 -or $end -lt $start) { return $null }
    $o = (($lines[$start..$end]) -join "`n") | ConvertFrom-Json
    return $o   # PS 5.1: assigning first unrolls a JSON array into its items
}
function Applied($conn) { Q $conn "SELECT coalesce(string_agg(change_id, ',' ORDER BY change_id), '') FROM dmcr.change_log;" }
function Rows($conn) { Q $conn "SELECT count(*) FROM app.zp_lookup_data;" }
# verify.sql: the rows/values must exist exactly when the change is recorded as applied
function Guard($id, [string]$cond) { "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id='$id') <> ($cond) THEN RAISE EXCEPTION '$id does not match the registry'; END IF; END `$`$;" }
function Mk($id, $deploy, $verify, $revert, $meta) {
    $d = Join-Path $changes $id; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') $revert
    if ($meta) { Set-Content -Encoding UTF8 (Join-Path $d 'meta.json') $meta }
}
function Catalog([string]$aRelease, [string]$aStatus) {
@"
{
  "releases": [
    { "id": "2026-06-01", "name": "Baseline", "date": "2026-06-01", "status": "deployed" },
    { "id": "2026-07-10", "name": "July", "date": "2026-07-10", "status": "planned" },
    { "id": "2026-08-11", "name": "August", "date": "2026-08-11", "status": "planned" }
  ],
  "projects": [
    { "id": "BASE", "name": "Lookup table", "type": "new", "release": "2026-06-01", "status": "active" },
    { "id": "PRJ-A", "name": "Zapier A", "type": "new", "release": "$aRelease", "status": "$aStatus", "dropped_reason": "not going in July" },
    { "id": "PRJ-B", "name": "Zapier B", "type": "cr", "release": "2026-07-10", "status": "active" }
  ]
}
"@ | Set-Content -Encoding UTF8 (Join-Path $changes 'releases.json')
}

Q $st "DROP DATABASE IF EXISTS dmcrprod WITH (FORCE);" | Out-Null
Q $st "CREATE DATABASE dmcrprod;" | Out-Null
Q $st "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;" | Out-Null
Q $prod "CREATE SCHEMA app;" | Out-Null
Run @('init') | Out-Null; Run @('init', '--env', 'prod') | Out-Null
Ok (Q $st "SELECT count(*) FROM information_schema.columns WHERE table_schema='dmcr' AND table_name='change_log' AND column_name IN ('project_id','project_type','release_id','change_kind','requested_by','created_by');") 6 'init creates the project/release/people columns'

"== registry upgrade: an old registry gets the new columns"
Q $st "ALTER TABLE dmcr.change_log DROP COLUMN project_id, DROP COLUMN project_type, DROP COLUMN release_id, DROP COLUMN change_kind, DROP COLUMN requested_by, DROP COLUMN created_by;" | Out-Null
Ok (Run @('status')) 0 'status on an old registry'
Ok (Has 'Registry upgraded to v1.2.0') 'True' 'reports the upgrade'
Ok (Q $st "SELECT count(*) FROM information_schema.columns WHERE table_schema='dmcr' AND table_name='change_log' AND column_name IN ('project_id','project_type','release_id','change_kind','requested_by','created_by');") 6 'columns added'

"== ST: baseline 100 rows, then project A and B (inserts and custom column updates)"
Catalog '2026-07-10' 'active'
$cols = (1..8 | ForEach-Object { "custom$_ text" }) -join ', '
Mk '001_zp_lookup_data' "CREATE TABLE app.zp_lookup_data (id int PRIMARY KEY, code text NOT NULL, $cols);`nINSERT INTO app.zp_lookup_data(id, code) SELECT g, 'C' || g FROM generate_series(1, 100) g;" (Guard '001_zp_lookup_data' "to_regclass('app.zp_lookup_data') IS NOT NULL") 'DROP TABLE app.zp_lookup_data;' '{"project":"BASE","requested_by":"dev.base","created_by":"dba.one"}'
Mk '002_a_insert_20' "INSERT INTO app.zp_lookup_data(id, code) SELECT g, 'A' || g FROM generate_series(101, 120) g;" (Guard '002_a_insert_20' "(SELECT count(*) FROM app.zp_lookup_data WHERE id BETWEEN 101 AND 120) = 20") 'DELETE FROM app.zp_lookup_data WHERE id BETWEEN 101 AND 120;' '{"project":"PRJ-A","requested_by":"dev.alice","created_by":"dba.one","created_at":"2026-06-20"}'
Mk '003_b_insert_20' "INSERT INTO app.zp_lookup_data(id, code) SELECT g, 'B' || g FROM generate_series(121, 140) g;" (Guard '003_b_insert_20' "(SELECT count(*) FROM app.zp_lookup_data WHERE id BETWEEN 121 AND 140) = 20") 'DELETE FROM app.zp_lookup_data WHERE id BETWEEN 121 AND 140;' '{"project":"PRJ-B","requested_by":"dev.bob","created_by":"dba.two"}'
Mk '004_a_update_custom' "UPDATE app.zp_lookup_data SET custom1 = 'a1', custom2 = 'a2' WHERE id BETWEEN 1 AND 10;" (Guard '004_a_update_custom' "(SELECT count(*) FROM app.zp_lookup_data WHERE custom1 = 'a1') = 10") 'UPDATE app.zp_lookup_data SET custom1 = NULL, custom2 = NULL WHERE id BETWEEN 1 AND 10;' '{"project":"PRJ-A","requested_by":"dev.alice","created_by":"dba.one"}'
Mk '005_b_update_custom78' "UPDATE app.zp_lookup_data SET custom7 = 'b7', custom8 = 'b8' WHERE id BETWEEN 11 AND 20;" (Guard '005_b_update_custom78' "(SELECT count(*) FROM app.zp_lookup_data WHERE custom7 = 'b7') = 10") 'UPDATE app.zp_lookup_data SET custom7 = NULL, custom8 = NULL WHERE id BETWEEN 11 AND 20;' '{"project":"PRJ-B","requested_by":"dev.bob","created_by":"dba.two"}'
Ok (Run @('check')) 0 'check passes'
Ok (Has 'All preflight checks passed') 'True' 'no preflight issues'
Run @('status', '--json') | Out-Null
$s = @(J)
Ok (($s | Where-Object { $_.change_id -eq '002_a_insert_20' }).kind) 'insert' 'kind inferred: insert'
Ok (($s | Where-Object { $_.change_id -eq '004_a_update_custom' }).kind) 'update' 'kind inferred: update'
Ok (($s | Where-Object { $_.change_id -eq '001_zp_lookup_data' }).kind) 'ddl' 'kind inferred: ddl (CREATE TABLE + seed)'
Ok (($s | Where-Object { $_.change_id -eq '003_b_insert_20' }).release) '2026-07-10' 'release comes from the project'
Ok (($s | Where-Object { $_.change_id -eq '003_b_insert_20' }).project_type) 'cr' 'project type'
Ok (Run @('deploy')) 0 'deploy everything to ST'
Ok (Applied $st) '001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom,005_b_update_custom78' 'ST has 001-005'
Ok (Rows $st) 140 'ST has 140 rows'
Ok (Q $st "SELECT project_id || '|' || release_id || '|' || change_kind || '|' || requested_by || '|' || created_by || '|' || project_type FROM dmcr.change_log WHERE change_id = '005_b_update_custom78';") 'PRJ-B|2026-07-10|update|dev.bob|dba.two|cr' 'registry records project, release, kind, requested_by, created_by'
Run @('history', '--json') | Out-Null
Ok ((@(J) | Where-Object { $_.change_id -eq '002_a_insert_20' }).requested_by) 'dev.alice' 'history --json carries requested_by'

"== prod: project A is not going, only project B is deployed"
Catalog '2026-07-10' 'dropped'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-06-01', '--dry-run', '--json')) 0 'dry run of the baseline release'
Ok (@((J).dropped).Count) 0 'the baseline dry run lists no dropped changes (project A is in July)'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-06-01')) 0 'deploy the baseline release to prod'
Ok (Has 'project PRJ-A dropped') 'False' 'the baseline deploy does not report July changes as dropped'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-07-10', '--dry-run', '--json')) 0 'dry run of the July release'
$d = J
Ok ((@($d.changes) | ForEach-Object { $_.change_id }) -join ',') '003_b_insert_20,005_b_update_custom78' 'July plan holds only project B'
Ok ((@($d.dropped) | ForEach-Object { $_.change_id }) -join ',') '002_a_insert_20,004_a_update_custom' 'dry run lists the dropped project A changes'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-07-10')) 0 'deploy the July release to prod'
Ok (Has '002_a_insert_20*project PRJ-A not going: not going in July') 'True' 'A is skipped as not going, with the reason'
Ok (Applied $prod) '001_zp_lookup_data,003_b_insert_20,005_b_update_custom78' 'prod has 001, 003, 005'
Ok (Rows $prod) 120 'prod has 100 + 20 B rows'
Ok (Q $prod "SELECT count(*) FILTER (WHERE custom7 = 'b7') || '/' || count(*) FILTER (WHERE custom1 IS NOT NULL) FROM app.zp_lookup_data;") '10/0' 'custom7/8 set on 10 rows, custom1 untouched'
Ok (Run @('deploy', '--env', 'prod')) 0 'an unscoped prod deploy also skips the dropped project'
Ok (Applied $prod) '001_zp_lookup_data,003_b_insert_20,005_b_update_custom78' 'prod unchanged'
Ok (Run @('status', '--env', 'prod')) 0 'status on prod'
Ok (Has 'NOT GOING*002_a_insert_20') 'True' 'status shows the dropped project A change as NOT GOING, not PENDING'

"== project A comes back in the August release"
Catalog '2026-08-11' 'active'
Ok (Run @('deploy', '--env', 'prod')) 1 'an unscoped prod deploy refuses A out of order'
Ok (Has '002_a_insert_20 is out of order') 'True' 'names the out-of-order change'
Ok (Run @('release', 'list', '--env', 'prod', '--json')) 0 'release list on prod'
$rl = @((J).releases)
$aug = $rl | Where-Object { $_.release -eq '2026-08-11' }
$jul = $rl | Where-Object { $_.release -eq '2026-07-10' }
Ok "$($jul.applied)/$($jul.total)/$($jul.pending)" '2/2/0' 'July: 2 of 2 applied in prod'
Ok "$($aug.applied)/$($aug.total)/$($aug.pending)" '0/2/2' 'August: 2 pending in prod'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-08-11')) 0 'deploy the August release: A goes out after B'
Ok (Applied $prod) '001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom,005_b_update_custom78' 'prod has everything'
Ok (Rows $prod) 140 'prod has 140 rows'
Ok (Q $prod "SELECT release_id FROM dmcr.change_log WHERE change_id = '002_a_insert_20';") '2026-08-11' 'prod records the release A went out in'
Ok (Run @('release', 'show', '2026-08-11', '--env', 'prod', '--json')) 0 'release show'
$rs = J
Ok ((@($rs.changes) | ForEach-Object { "$($_.change_id):$($_.status):$($_.requested_by)" }) -join ',') '002_a_insert_20:applied:dev.alice,004_a_update_custom:applied:dev.alice' 'release show lists status and requester'

"== several releases at once, like git revert (list and ranges in release order)"
function Get-RevertPlan { $o = J; "$($o.status):$((@($o.changes) | ForEach-Object { $_.change_id }) -join ',')" }
Ok (Run @('revert', '--env', 'prod', '--release', '2026-07-10,2026-08-11', '--dry-run', '--json')) 0 'revert two releases: dry run'
Ok (Get-RevertPlan) 'dry_run:004_a_update_custom,002_a_insert_20,005_b_update_custom78,003_b_insert_20' 'a list takes both releases, newest applied first'
Ok (Run @('revert', '--env', 'prod', '--release', '2026-06-01..2026-08-11', '--dry-run', '--json')) 0 'range a..b'
Ok (Get-RevertPlan) 'dry_run:004_a_update_custom,002_a_insert_20,005_b_update_custom78,003_b_insert_20' 'a..b is after a up to b (the baseline stays)'
Ok (Run @('revert', '--env', 'prod', '--release', '2026-07-10..', '--dry-run', '--json')) 0 'open range a..'
Ok (Get-RevertPlan) 'dry_run:004_a_update_custom,002_a_insert_20' 'a.. is everything after a (August only)'
Ok (Run @('revert', '--env', 'prod', '--release', '2026-07-10^..2026-07-10', '--dry-run', '--json')) 0 'range a^..a'
Ok (Get-RevertPlan) 'dry_run:005_b_update_custom78,003_b_insert_20' 'a^..b includes a'
Ok (Run @('revert', '--env', 'prod', '--release', '..2026-06-01', '--dry-run', '--json')) 1 'range ..a: blocked'
Ok (Get-RevertPlan) 'blocked:001_zp_lookup_data' '..a is up to a; the baseline is blocked: later changes build on it'
Ok (Run @('revert', '--env', 'prod', '--release', '2026-08-11..2026-07-10', '--dry-run')) 1 'a backwards range is refused'
Ok (Has "Release range '2026-08-11..2026-07-10' holds no releases") 'True' 'and says so'
Ok (Run @('revert', '--env', 'prod', '--release', '2026-07-10,2099-01-01', '--dry-run')) 1 'an unknown release in a list is refused'
Ok (Has "Unknown release '2099-01-01'") 'True' 'names it'
Ok (Applied $prod) '001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom,005_b_update_custom78' 'dry runs reverted nothing on prod'

"== ST rollbacks after a Sev1 (each kind of project change on its own)"
Ok (Run @('revert', '--project', 'PRJ-B', '--kind', 'update')) 0 '2. project B updates only'
Ok (Applied $st) '001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom' '005 reverted'
Ok (Q $st "SELECT count(*) FROM app.zp_lookup_data WHERE custom7 IS NOT NULL OR custom8 IS NOT NULL;") 0 'custom7/8 cleared'
Ok (Q $st "SELECT count(*) FROM app.zp_lookup_data WHERE custom1 = 'a1';") 10 'project A updates kept'
Ok (Run @('deploy')) 0 'redeploy'
Ok (Run @('revert', '--project', 'PRJ-B', '--kind', 'insert')) 0 '3. project B inserts only (not the latest change)'
Ok (Has '004_a_update_custom (applied later, outside the scope) also writes app.zp_lookup_data') 'True' 'warns that a later A change writes the same table'
Ok (Applied $st) '001_zp_lookup_data,002_a_insert_20,004_a_update_custom,005_b_update_custom78' '003 reverted, the rest kept'
Ok (Rows $st) 120 'B rows gone'
Ok (Run @('deploy')) 0 'redeploy'
Ok (Run @('revert', '--project', 'PRJ-A', '--kind', 'insert')) 0 '4. project A inserts only'
Ok (Q $st "SELECT count(*) FROM app.zp_lookup_data WHERE id BETWEEN 101 AND 120;") 0 'A rows gone'
Ok (Rows $st) 120 'B rows kept'
Ok (Run @('deploy')) 0 'redeploy'
Ok (Run @('revert', '--project', 'PRJ-A', '--kind', 'update')) 0 '5. project A updates only'
Ok (Q $st "SELECT count(*) FILTER (WHERE custom1 IS NOT NULL) || '/' || count(*) FILTER (WHERE custom7 = 'b7') FROM app.zp_lookup_data;") '0/10' 'custom1/2 cleared, custom7/8 kept'
Ok (Run @('deploy')) 0 'redeploy'
Ok (Run @('revert', '--project', 'PRJ-B', '--dry-run', '--json')) 0 '1. project B completely: dry run'
$rv = J
Ok "$($rv.status):$((@($rv.changes) | ForEach-Object { $_.change_id }) -join ',')" 'dry_run:003_b_insert_20,005_b_update_custom78' 'dry run lists B newest first'
Ok (Applied $st) '001_zp_lookup_data,002_a_insert_20,003_b_insert_20,004_a_update_custom,005_b_update_custom78' 'dry run reverted nothing'
Ok (Run @('revert', '--project', 'PRJ-B')) 0 '1. project B completely'
Ok (Applied $st) '001_zp_lookup_data,002_a_insert_20,004_a_update_custom' 'only A and the baseline remain'
Ok (Q $st "SELECT count(*) || '/' || count(*) FILTER (WHERE custom1 = 'a1') || '/' || count(*) FILTER (WHERE custom7 IS NOT NULL) FROM app.zp_lookup_data;") '120/10/0' '120 rows, A updates kept, no B values'
Ok (Run @('deploy')) 0 'redeploy B'

"== scoped revert refuses what later changes build on"
Mk '006_b_add_custom9' 'ALTER TABLE app.zp_lookup_data ADD COLUMN custom9 text;' (Guard '006_b_add_custom9' "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'zp_lookup_data' AND column_name = 'custom9')") 'ALTER TABLE app.zp_lookup_data DROP COLUMN custom9;' '{"project":"PRJ-B"}'
Mk '007_a_fill_custom9' "UPDATE app.zp_lookup_data SET custom9 = 'a9' WHERE id <= 5;" (Guard '007_a_fill_custom9' "(SELECT count(*) FROM app.zp_lookup_data WHERE custom9 = 'a9') = 5") 'UPDATE app.zp_lookup_data SET custom9 = NULL WHERE id <= 5;' '{"project":"PRJ-A","requires":["006_b_add_custom9"]}'
Ok (Run @('deploy', '--env', 'prod', '--project', 'PRJ-A')) 1 'prod refuses A while the B change it requires is not there'
Ok (Has '007_a_fill_custom9 requires 006_b_add_custom9, which is not applied and is not in this deploy (project PRJ-B') 'True' 'names the missing requirement'
Ok (Run @('deploy')) 0 'deploy 006, 007 to ST'
Ok (Run @('revert', '--project', 'PRJ-B', '--kind', 'ddl')) 1 'B DDL revert refused'
Ok (Has '007_a_fill_custom9 (applied later, outside the scope) requires 006_b_add_custom9') 'True' 'names the requiring change'
Set-Content -Encoding UTF8 (Join-Path $changes '007_a_fill_custom9\meta.json') '{"project":"PRJ-A"}'
Ok (Run @('revert', '--project', 'PRJ-B', '--kind', 'ddl')) 1 'still refused without requires'
Ok (Has 'uses app.zp_lookup_data, whose structure 006_b_add_custom9 changed') 'True' 'structural dependency found from the SQL'
Ok (Q $st "SELECT count(*) FROM dmcr.change_log WHERE change_id = '006_b_add_custom9';") 1 '006 still applied'
Ok (Run @('revert', '--project', 'PRJ-A,PRJ-B', '--kind', 'ddl,update')) 0 'reverting both together is allowed'
Ok (Applied $st) '001_zp_lookup_data,002_a_insert_20,003_b_insert_20' 'updates and DDL of A and B reverted, newest first'

"== a single dropped change, unknown projects and kinds"
Mk '008_b_extra' "INSERT INTO app.zp_lookup_data(id, code) VALUES (999, 'X');" (Guard '008_b_extra' "EXISTS (SELECT 1 FROM app.zp_lookup_data WHERE id = 999)") 'DELETE FROM app.zp_lookup_data WHERE id = 999;' '{"project":"PRJ-B","status":"dropped","dropped_reason":"not needed"}'
Ok (Run @('deploy')) 0 'deploy skips the dropped change'
Ok (Has '008_b_extra*change not going: not needed') 'True' 'with its reason'
Ok (Q $st "SELECT count(*) FROM dmcr.change_log WHERE change_id = '008_b_extra';") 0 '008 not applied'
Mk '009_bad' 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"project":"PRJ-Z","kind":"weird"}'
Ok (Run @('deploy')) 1 'unknown project / kind block the deploy'
Ok (Has "009_bad: project 'PRJ-Z' is not in releases.json") 'True' 'unknown project named'
Ok (Has "009_bad: kind 'weird'") 'True' 'unknown kind named'
Remove-Item -Recurse -Force (Join-Path $changes '009_bad')
Ok (Run @('deploy', '--release', '2099-01-01')) 1 'unknown release refused'
Ok (Has "Unknown release '2099-01-01'") 'True' 'names the release'
Ok (Run @('revert', '005_b_update_custom78')) 1 'plain revert still needs the latest change'
Ok (Has 'dmcr revert --project') 'True' 'and points to the scoped revert'

"== kind inference ignores function bodies"
Mk '010_fn' "CREATE OR REPLACE FUNCTION app.touch() RETURNS void LANGUAGE sql AS `$`$ UPDATE app.zp_lookup_data SET code = code `$`$;" 'SELECT 1;' 'DROP FUNCTION app.touch();' '{"project":"PRJ-B"}'
Mk '011_type' "CREATE TYPE app.lookup_pair AS (k text, v text);`nCREATE DOMAIN app.code_t AS text CHECK (VALUE <> '');" 'SELECT 1;' 'DROP DOMAIN app.code_t; DROP TYPE app.lookup_pair;' '{"project":"PRJ-B"}'
Run @('status', '--json', '--project', 'PRJ-B') | Out-Null
$s = @(J)
Ok (($s | Where-Object { $_.change_id -eq '010_fn' }).kind) 'function' 'CREATE FUNCTION with an UPDATE body is a function change'
Ok (($s | Where-Object { $_.change_id -eq '011_type' }).kind) 'type' 'CREATE TYPE + DOMAIN is a type change'
Ok (@($s | Where-Object { $_.change_id -like '00[12]*' }).Count) 0 'status --project lists only that project'

"== kind inference ignores DMCR's own backup tables (dmcr.bak_*)"
Mk '012_bak_update' "CREATE TABLE IF NOT EXISTS dmcr.bak_012 AS SELECT code, custom7 FROM app.zp_lookup_data WHERE code = 'L001';`nUPDATE app.zp_lookup_data SET custom7 = 'x' WHERE code = 'L001';" 'SELECT 1;' "UPDATE app.zp_lookup_data t SET custom7 = b.custom7 FROM dmcr.bak_012 b WHERE t.code = b.code; DROP TABLE dmcr.bak_012;" '{"project":"PRJ-B"}'
Mk '013_bak_insert' "CREATE TABLE IF NOT EXISTS dmcr.bak_013 (code text PRIMARY KEY);`nINSERT INTO dmcr.bak_013 VALUES ('Z001');`nINSERT INTO app.zp_lookup_data (code, name) VALUES ('Z001', 'z');" 'SELECT 1;' "DELETE FROM app.zp_lookup_data WHERE code = 'Z001'; DROP TABLE dmcr.bak_013;" '{"project":"PRJ-B"}'
Run @('status', '--json', '--project', 'PRJ-B') | Out-Null
$s = @(J)
Ok (($s | Where-Object { $_.change_id -eq '012_bak_update' }).kind) 'update' 'an UPDATE with a dmcr.bak_* backup is an update change'
Ok (($s | Where-Object { $_.change_id -eq '013_bak_insert' }).kind) 'insert' 'an INSERT with a dmcr.bak_* record table is an insert change'

"== a scoped deploy re-applies only the repeatables in its scope"
$rd = Join-Path $changes 'R__base_view'; New-Item -ItemType Directory -Force $rd | Out-Null
Set-Content -Encoding UTF8 (Join-Path $rd 'deploy.sql') 'CREATE OR REPLACE VIEW app.v_base AS SELECT 1 AS x;'
Set-Content -Encoding UTF8 (Join-Path $rd 'verify.sql') 'SELECT 1;'
Set-Content -Encoding UTF8 (Join-Path $rd 'meta.json') '{"project":"BASE"}'
Mk '009_noop' 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"project":"BASE"}'   # no prefix gap, so real deploys pass pre-flight
Remove-Item -Recurse -Force (Join-Path $changes '012_bak_update'), (Join-Path $changes '013_bak_insert')   # kind-inference fixtures, not deployable
Run @('deploy', '--project', 'PRJ-B', '--dry-run', '--json') | Out-Null
Ok (@((J).repeatable).Count) 0 'dry run --project PRJ-B lists no BASE repeatable'
Ok (Run @('deploy', '--project', 'PRJ-B')) 0 'deploy --project PRJ-B succeeds'
Ok (Q $st "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__base_view';") '0' 'deploy --project PRJ-B leaves the BASE repeatable alone'
Run @('deploy', '--project', 'BASE', '--dry-run', '--json') | Out-Null
Ok (@((J).repeatable) -join ',') 'R__base_view' 'dry run --project BASE lists the repeatable it would re-apply'
Ok (Run @('deploy', '--project', 'BASE')) 0 'deploy --project BASE succeeds'
Ok (Q $st "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__base_view';") '1' 'deploy --project BASE applies it'

Q $st "DROP DATABASE IF EXISTS dmcrprod WITH (FORCE);" | Out-Null
""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
