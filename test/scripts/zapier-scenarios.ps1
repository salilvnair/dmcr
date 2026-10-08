# Zapier shop: release, project and rollback scenarios on two databases, ST (zapier_st) and prod
# (zapier_prod), with the real runner (scripts\runner\dmcr.ps1) against a local PostgreSQL.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\scripts\zapier-scenarios.ps1 -Password <pw>
#   (this PC, Docker stand-in:  ... -Psql test\scripts\psql-local-sim.ps1 -Password postgres)
#
# Options: -PgHost localhost -Port 5432 -User postgres -Password <pw> (or PGPASSWORD) -Psql <psql.exe>
#          -Pause (wait for Enter after each scenario)   -Drop (drop both databases at the end)
# The change folders, releases.json and dmcr.cfg are kept in ~\.dmcr-local\zapier so the result can be
# opened in DMCR afterwards. The story:
#   zp_lookup_data has 100 rows. Project A ("Zapier triggers") adds 20 rows, fills custom1/custom2 on 10
#   rows, adds a scoring function (later rewritten), a view on it and a trigger. Project B ("Lookup
#   custom fields", a CR) adds 20 rows, fills custom7/custom8 on 10 rows, adds an enum, a domain and a
#   composite type, new zap_runs columns using them, an enum value and typed rows. BUG-7 is a bug fix.
#   Everything runs in ST. Then A is not going: prod gets B and BUG-7 in July, A follows in August.
#   In ST a Sev1 is rolled back each way: all of B, B updates, B inserts, A inserts, A updates.
param(
    [string]$PgHost = 'localhost', [int]$Port = 5432, [string]$User = 'postgres',
    [string]$Password = $env:PGPASSWORD, [string]$Psql = '', [switch]$Pause, [switch]$Drop
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
$st = 'zapier_st'; $prod = 'zapier_prod'
$home2 = Join-Path $HOME '.dmcr-local\zapier'
$changes = Join-Path $home2 'changes'; $cfg = Join-Path $home2 'dmcr.cfg'
Remove-Item -Recurse -Force $changes -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $changes | Out-Null

function Q([string]$db, [string]$sql) {
    $old = $env:PGPASSWORD; $env:PGPASSWORD = $Password
    try { return ((& $Psql "postgresql://${User}@${PgHost}:${Port}/$db" -X -q -t -A -c $sql 2>&1 | ForEach-Object { "$_" }) -join "`n").Trim() }
    finally { $env:PGPASSWORD = $old }
}
$script:pass = 0; $script:fail = 0; $script:failed = @()
function Ok($got, $want, $label) {
    if ("$got" -eq "$want") { Write-Host "      PASS  $label" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "      FAIL  $label  (got '$got', want '$want')" -ForegroundColor Red; $script:fail++; $script:failed += "$($script:scn) $label" }
}
function Run([string[]]$a) {
    Write-Host "    > dmcr $($a -join ' ')" -ForegroundColor DarkCyan
    $script:last = (& powershell -NoProfile -ExecutionPolicy Bypass -File $runner -c $cfg @a 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return $LASTEXITCODE
}
function Has([string]$text) { if ($script:last -match [regex]::Escape($text)) { 'yes' } else { 'no' } }
# The JSON document in the last output (log lines before and after it are skipped)
function J {
    $lines = @($script:last -split "`r?`n")
    $start = -1; $end = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($start -lt 0 -and $lines[$i] -match '^\s*[\[{]') { $start = $i }; if ($lines[$i] -match '[\]}]\s*$') { $end = $i } }
    if ($start -lt 0 -or $end -lt $start) { return $null }
    $o = ($lines[$start..$end] -join "`n") | ConvertFrom-Json
    return $o
}
function Scenario($id, $title) {
    if ($Pause -and $script:scn) { Read-Host '    (Enter for the next scenario)' | Out-Null }
    $script:scn = $id
    Write-Host ''
    Write-Host "  $id  $title" -ForegroundColor Cyan
}
function Mk($id, $deploy, $verify, $revert, $meta) {
    $d = Join-Path $changes $id; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') $revert
    if ($meta) { Set-Content -Encoding UTF8 (Join-Path $d 'meta.json') $meta }
}
# verify.sql that holds in both states: applied (per the registry) -> condition true, reverted -> false
function Guard($id, $cond) {
@"
DO `$`$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '$id') <> ($cond) THEN
    RAISE EXCEPTION '${id}: state does not match the registry';
  END IF;
END `$`$;
"@
}
function Meta($project, $by, $extra) { "{ `"project`": `"$project`", `"requested_by`": `"$by`", `"created_by`": `"dba.salil`", `"created_at`": `"2026-06-20`"$extra }" }
function Catalog([string]$aRelease, [string]$aStatus) {
@"
{
  "releases": [
    { "id": "2026-06-01", "name": "Baseline", "date": "2026-06-01", "status": "deployed" },
    { "id": "2026-07-10", "name": "July", "date": "2026-07-10", "status": "planned" },
    { "id": "2026-08-11", "name": "August", "date": "2026-08-11", "status": "planned" }
  ],
  "projects": [
    { "id": "BASE", "name": "Zapier shop baseline", "type": "new", "release": "2026-06-01", "status": "active" },
    { "id": "PRJ-A", "name": "Zapier triggers", "type": "new", "release": "$aRelease", "status": "$aStatus", "dropped_reason": "not going in July" },
    { "id": "PRJ-B", "name": "Lookup custom fields", "type": "cr", "release": "2026-07-10", "status": "active" },
    { "id": "BUG-7", "name": "Retry status fix", "type": "bugfix", "release": "2026-07-10", "status": "active" }
  ]
}
"@ | Set-Content -Encoding UTF8 (Join-Path $changes 'releases.json')
}
function Applied($db) { Q $db "SELECT coalesce(string_agg(left(change_id, 3), ',' ORDER BY change_id), '') FROM dmcr.change_log;" }

Write-Host "Zapier shop scenarios on PostgreSQL $(Q 'postgres' 'SHOW server_version;') at ${PgHost}:$Port" -ForegroundColor White
Write-Host "  changes: $changes" -ForegroundColor DarkGray
if ((Q 'postgres' 'SELECT 1;') -ne '1') { 'cannot connect'; exit 2 }
foreach ($db in $st, $prod) { Q 'postgres' "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null; Q 'postgres' "CREATE DATABASE $db;" | Out-Null }
"[dmcr]`nenv = st`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 2min`nchecksum_policy = block`n`n[st]`nconn = $base/$st`n`n[prod]`nconn = $base/$prod`npromote_from = st`nout_of_order = block" |
    Set-Content -Encoding ASCII $cfg
Remove-Item Env:DMCR_CONN, Env:DMCR_PROMOTE_FROM_CONN, Env:DMCR_DANGER_RULES -ErrorAction SilentlyContinue
$env:DMCR_PSQL = $Psql; $env:DMCR_BASE_DIR = $home2; $env:DMCR_ACTOR = 'zapier-scenarios'

# ── The change folders ────────────────────────────────────────────────────────
Catalog '2026-07-10' 'active'
$cols = (1..8 | ForEach-Object { "custom$_ text" }) -join ', '
Mk '001_zap_baseline' @"
CREATE SCHEMA zap;
CREATE TABLE zap.zp_lookup_data (id int PRIMARY KEY, code text NOT NULL, $cols);
CREATE TABLE zap.zaps (id int PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'on', updated_at timestamptz);
CREATE TABLE zap.zap_runs (id bigserial PRIMARY KEY, zap_id int NOT NULL REFERENCES zap.zaps(id));
INSERT INTO zap.zp_lookup_data (id, code) SELECT g, 'L' || g FROM generate_series(1, 100) g;
INSERT INTO zap.zaps (id, name) SELECT g, 'zap ' || g FROM generate_series(1, 10) g;
"@ (Guard '001_zap_baseline' "to_regclass('zap.zp_lookup_data') IS NOT NULL") "DROP TABLE zap.zap_runs;`nDROP TABLE zap.zaps;`nDROP TABLE zap.zp_lookup_data;`nDROP SCHEMA zap;" (Meta 'BASE' 'dev.base' '')
Mk '002_a_lookup_insert_20' "INSERT INTO zap.zp_lookup_data (id, code) SELECT g, 'A' || g FROM generate_series(101, 120) g;" `
   (Guard '002_a_lookup_insert_20' '(SELECT count(*) FROM zap.zp_lookup_data WHERE id BETWEEN 101 AND 120) = 20') 'DELETE FROM zap.zp_lookup_data WHERE id BETWEEN 101 AND 120;' (Meta 'PRJ-A' 'dev.alice' '')
Mk '003_b_lookup_insert_20' "INSERT INTO zap.zp_lookup_data (id, code) SELECT g, 'B' || g FROM generate_series(121, 140) g;" `
   (Guard '003_b_lookup_insert_20' '(SELECT count(*) FROM zap.zp_lookup_data WHERE id BETWEEN 121 AND 140) = 20') 'DELETE FROM zap.zp_lookup_data WHERE id BETWEEN 121 AND 140;' (Meta 'PRJ-B' 'dev.bob' '')
Mk '004_a_lookup_custom1_2' "UPDATE zap.zp_lookup_data SET custom1 = 'a1', custom2 = 'a2' WHERE id BETWEEN 1 AND 10;" `
   (Guard '004_a_lookup_custom1_2' "(SELECT count(*) FROM zap.zp_lookup_data WHERE custom1 = 'a1') = 10") 'UPDATE zap.zp_lookup_data SET custom1 = NULL, custom2 = NULL WHERE id BETWEEN 1 AND 10;' (Meta 'PRJ-A' 'dev.alice' '')
Mk '005_b_lookup_custom7_8' "UPDATE zap.zp_lookup_data SET custom7 = 'b7', custom8 = 'b8' WHERE id BETWEEN 11 AND 20;" `
   (Guard '005_b_lookup_custom7_8' "(SELECT count(*) FROM zap.zp_lookup_data WHERE custom7 = 'b7') = 10") 'UPDATE zap.zp_lookup_data SET custom7 = NULL, custom8 = NULL WHERE id BETWEEN 11 AND 20;' (Meta 'PRJ-B' 'dev.bob' '')
Mk '006_b_types' @'
CREATE TYPE zap.run_status AS ENUM ('queued', 'running', 'done');
CREATE DOMAIN zap.zap_code AS text CHECK (VALUE ~ '^[A-Z]{2,}[0-9]*$');
CREATE TYPE zap.step_result AS (step int, ok boolean, note text);
'@ (Guard '006_b_types' "to_regtype('zap.run_status') IS NOT NULL AND to_regtype('zap.zap_code') IS NOT NULL AND to_regtype('zap.step_result') IS NOT NULL") `
   "DROP TYPE zap.step_result;`nDROP DOMAIN zap.zap_code;`nDROP TYPE zap.run_status;" (Meta 'PRJ-B' 'dev.bob' '')
Mk '007_b_zap_runs_typed_cols' @'
ALTER TABLE zap.zap_runs ADD COLUMN status zap.run_status NOT NULL DEFAULT 'queued';
ALTER TABLE zap.zap_runs ADD COLUMN code zap.zap_code;
ALTER TABLE zap.zap_runs ADD COLUMN result zap.step_result;
'@ (Guard '007_b_zap_runs_typed_cols' "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'zap' AND table_name = 'zap_runs' AND column_name = 'result')") `
   "ALTER TABLE zap.zap_runs DROP COLUMN result;`nALTER TABLE zap.zap_runs DROP COLUMN code;`nALTER TABLE zap.zap_runs DROP COLUMN status;" (Meta 'PRJ-B' 'dev.bob' ', "requires": ["006_b_types"]')
Mk '008_a_fn_zap_score' @'
CREATE FUNCTION zap.zap_score(p_zap int) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM zap.zap_runs WHERE zap_id = p_zap
$$;
'@ (Guard '008_a_fn_zap_score' "to_regprocedure('zap.zap_score(int)') IS NOT NULL") 'DROP FUNCTION zap.zap_score(int);' (Meta 'PRJ-A' 'dev.alice' '')
Mk '009_a_fn_zap_score_v2' @'
CREATE OR REPLACE FUNCTION zap.zap_score(p_zap int) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) * 10 FROM zap.zap_runs WHERE zap_id = p_zap
$$;
'@ (Guard '009_a_fn_zap_score_v2' "(SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('zap.zap_score(int)')) LIKE '%* 10%'") @'
CREATE OR REPLACE FUNCTION zap.zap_score(p_zap int) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM zap.zap_runs WHERE zap_id = p_zap
$$;
'@ (Meta 'PRJ-A' 'dev.alice' ', "requires": ["008_a_fn_zap_score"]')
Mk '010_a_view_zap_summary' 'CREATE VIEW zap.v_zap_summary AS SELECT z.id, z.name, z.status, zap.zap_score(z.id) AS score FROM zap.zaps z;' `
   (Guard '010_a_view_zap_summary' "to_regclass('zap.v_zap_summary') IS NOT NULL") 'DROP VIEW zap.v_zap_summary;' (Meta 'PRJ-A' 'dev.alice' ', "requires": ["008_a_fn_zap_score"]')
Mk '011_a_trigger_touch' @'
CREATE FUNCTION zap.touch_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_zaps_touch BEFORE UPDATE ON zap.zaps FOR EACH ROW EXECUTE FUNCTION zap.touch_updated();
'@ (Guard '011_a_trigger_touch' "EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_zaps_touch')") "DROP TRIGGER trg_zaps_touch ON zap.zaps;`nDROP FUNCTION zap.touch_updated();" (Meta 'PRJ-A' 'dev.alice' '')
Mk '012_bug7_retry_status' "UPDATE zap.zaps SET status = 'retry' WHERE id IN (3, 7);" `
   (Guard '012_bug7_retry_status' "(SELECT count(*) FROM zap.zaps WHERE status = 'retry') = 2") "UPDATE zap.zaps SET status = 'on' WHERE id IN (3, 7);" (Meta 'BUG-7' 'dev.carol' '')
Mk '013_b_enum_add_failed' "ALTER TYPE zap.run_status ADD VALUE IF NOT EXISTS 'failed';" @'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '013_b_enum_add_failed')
     AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'run_status' AND e.enumlabel = 'failed') THEN
    RAISE EXCEPTION '013: run_status has no failed value';
  END IF;
END $$;
'@ "-- PostgreSQL cannot remove an enum value; 'failed' stays until 006 drops the type.`nSELECT 1;" (Meta 'PRJ-B' 'dev.bob' ', "requires": ["006_b_types"]')
Mk '014_b_typed_runs' @'
INSERT INTO zap.zap_runs (zap_id, status, code, result) VALUES
  (1, 'done', 'ZP1', ROW(1, true, 'b14')::zap.step_result),
  (1, 'done', 'ZP2', ROW(2, true, 'b14')::zap.step_result),
  (2, 'queued', 'ZP3', ROW(1, false, 'b14')::zap.step_result);
'@ (Guard '014_b_typed_runs' "(SELECT count(*) FROM zap.zap_runs WHERE (result).note = 'b14') = 3") "DELETE FROM zap.zap_runs WHERE (result).note = 'b14';" (Meta 'PRJ-B' 'dev.bob' ', "requires": ["007_b_zap_runs_typed_cols"]')

# ── Scenarios ─────────────────────────────────────────────────────────────────
Scenario 'Z01' 'Registries on ST and prod'
Ok (Run @('init')) 0 'init ST'
Ok (Run @('init', '--env', 'prod')) 0 'init prod'

Scenario 'Z02' 'Preflight and the kind DMCR infers for every change'
Ok (Run @('check')) 0 'check'
Ok (Has 'All preflight checks passed') 'yes' 'no preflight issues'
Run @('status', '--json') | Out-Null
$kinds = (@(J) | ForEach-Object { "$($_.change_id.Substring(0,3))=$($_.kind)" }) -join ' '
Ok $kinds '001=ddl 002=insert 003=insert 004=update 005=update 006=type 007=ddl 008=function 009=function 010=ddl 011=ddl 012=update 013=type 014=insert' 'kinds: insert / update / type / function / ddl'

Scenario 'Z03' 'Round-trip test before release (everything rolled back)'
Ok (Run @('test', '--to', '011_a_trigger_touch')) 0 '001-011: deploy, verify, revert, verify leave schema and data exactly as before'
Ok (Run @('test', '--to', '012_bug7_retry_status')) 1 '012 is caught: its revert cannot undo what the A trigger did'
Ok (Has 'data in zap.zaps is not the same after revert') 'yes' 'the A trigger (011) stamps updated_at when BUG-7 (012) updates zaps'

Scenario 'Z04' 'Deploy everything to ST'
Ok (Run @('deploy')) 0 'deploy ST'
Ok (Applied $st) '001,002,003,004,005,006,007,008,009,010,011,012,013,014' 'ST has 001-014'
Ok (Q $st 'SELECT count(*) FROM zap.zp_lookup_data;') 140 '140 lookup rows'
Ok (Q $st 'SELECT score FROM zap.v_zap_summary WHERE id = 1;') 20 'view over the v2 function: 2 runs x 10'

Scenario 'Z05' 'The registry records project, release, kind and people'
Ok (Q $st "SELECT project_id || '|' || project_type || '|' || release_id || '|' || change_kind || '|' || requested_by || '|' || created_by FROM dmcr.change_log WHERE change_id = '005_b_lookup_custom7_8';") 'PRJ-B|cr|2026-07-10|update|dev.bob|dba.salil' '005 recorded with PRJ-B, CR, July, update, dev.bob, dba.salil'
Ok (Q $st "SELECT project_type FROM dmcr.change_log WHERE change_id = '012_bug7_retry_status';") 'bugfix' 'BUG-7 is a bug fix'

Scenario 'Z06' 'Release list on ST'
Ok (Run @('release', 'list', '--json')) 0 'release list'
$jul = @((J).releases) | Where-Object { $_.release -eq '2026-07-10' }
Ok "$($jul.applied)/$($jul.total)" '13/13' 'July: 13 of 13 applied in ST (A, B and BUG-7)'

Scenario 'Z07' 'Project A is not going: prod July plan holds only B and BUG-7'
Catalog '2026-07-10' 'dropped'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-07-10', '--dry-run', '--json')) 0 'dry run'
$d = J
Ok ((@($d.changes) | ForEach-Object { $_.change_id.Substring(0,3) }) -join ',') '003,005,006,007,012,013,014' 'plan: B and BUG-7 only'
Ok ((@($d.dropped) | ForEach-Object { $_.change_id.Substring(0,3) }) -join ',') '002,004,008,009,010,011' 'A listed as dropped'

Scenario 'Z08' 'Prod: baseline release first'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-06-01')) 0 'deploy baseline to prod'
Ok (Applied $prod) '001' 'prod has 001'

Scenario 'Z09' 'Prod: July release (20 B inserts, B custom7/8 updates, B types, BUG-7)'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-07-10')) 0 'deploy July to prod'
Ok (Has 'project PRJ-A dropped: not going in July') 'yes' 'A skipped with the reason'
Ok (Applied $prod) '001,003,005,006,007,012,013,014' 'prod has 001, 003, 005, 006, 007, 012, 013, 014'
Ok (Q $prod "SELECT count(*) || '/' || count(*) FILTER (WHERE custom7 = 'b7') || '/' || count(*) FILTER (WHERE custom1 IS NOT NULL) FROM zap.zp_lookup_data;") '120/10/0' '120 rows, custom7/8 on 10, custom1/2 untouched'
Ok (Q $prod "SELECT to_regprocedure('zap.zap_score(int)') IS NULL AND to_regclass('zap.v_zap_summary') IS NULL;") 't' 'no A function or view in prod'

Scenario 'Z10' 'An unscoped prod deploy also skips the dropped project'
Ok (Run @('deploy', '--env', 'prod')) 0 'deploy prod'
Ok (Applied $prod) '001,003,005,006,007,012,013,014' 'prod unchanged'

Scenario 'Z11' 'Project A moves to August: a plain deploy refuses it out of order'
Catalog '2026-08-11' 'active'
Ok (Run @('deploy', '--env', 'prod')) 1 'plain prod deploy refused'
Ok (Has '002_a_lookup_insert_20 is out of order') 'yes' 'names the out-of-order change'

Scenario 'Z12' 'Prod: August release brings A (inserts, updates, function v1 + v2, view, trigger)'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-08-11')) 0 'deploy August to prod'
Ok (Applied $prod) '001,002,003,004,005,006,007,008,009,010,011,012,013,014' 'prod has everything'
Ok (Q $prod 'SELECT count(*) FROM zap.zp_lookup_data;') 140 '140 rows'
Ok (Q $prod 'SELECT score FROM zap.v_zap_summary WHERE id = 1;') 20 'view works in prod'
Ok (Q $prod "SELECT release_id FROM dmcr.change_log WHERE change_id = '002_a_lookup_insert_20';") '2026-08-11' 'prod records A under August'

Scenario 'Z13' 'Release show on prod: who asked, who built, when it went out'
Ok (Run @('release', 'show', '2026-08-11', '--env', 'prod', '--json')) 0 'release show'
Ok ((@((J).changes) | ForEach-Object { "$($_.change_id.Substring(0,3)):$($_.status):$($_.requested_by)" }) -join ',') '002:applied:dev.alice,004:applied:dev.alice,008:applied:dev.alice,009:applied:dev.alice,010:applied:dev.alice,011:applied:dev.alice' 'six A changes, applied, asked for by dev.alice'

Scenario 'Z14' 'ST Sev1 rollback 2: project B updates only'
Ok (Run @('revert', '--project', 'PRJ-B', '--kind', 'update')) 0 'revert B updates'
Ok (Q $st "SELECT count(*) FILTER (WHERE custom7 IS NOT NULL) || '/' || count(*) FILTER (WHERE custom1 = 'a1') FROM zap.zp_lookup_data;") '0/10' 'custom7/8 cleared, A custom1/2 kept'
Ok (Run @('deploy')) 0 'redeploy'

Scenario 'Z15' 'ST Sev1 rollback 3: project B inserts only'
Ok (Run @('revert', '--project', 'PRJ-B', '--kind', 'insert')) 0 'revert B inserts (003 lookups, 014 typed runs)'
Ok (Q $st "SELECT (SELECT count(*) FROM zap.zp_lookup_data) || '/' || (SELECT count(*) FROM zap.zap_runs);") '120/0' 'B lookup rows and runs gone'
Ok (Has 'also writes zap.zp_lookup_data') 'yes' 'warns about later changes writing the same table'
Ok (Run @('deploy')) 0 'redeploy'

Scenario 'Z16' 'ST Sev1 rollback 4: project A inserts only'
Ok (Run @('revert', '--project', 'PRJ-A', '--kind', 'insert')) 0 'revert A inserts'
Ok (Q $st 'SELECT count(*) FROM zap.zp_lookup_data WHERE id BETWEEN 101 AND 140;') 20 'A rows gone, B rows kept'
Ok (Run @('deploy')) 0 'redeploy'

Scenario 'Z17' 'ST Sev1 rollback 5: project A updates only'
Ok (Run @('revert', '--project', 'PRJ-A', '--kind', 'update')) 0 'revert A updates'
Ok (Q $st "SELECT count(*) FILTER (WHERE custom1 IS NOT NULL) || '/' || count(*) FILTER (WHERE custom7 = 'b7') FROM zap.zp_lookup_data;") '0/10' 'custom1/2 cleared, B custom7/8 kept'
Ok (Run @('deploy')) 0 'redeploy'

Scenario 'Z18' 'ST Sev1 rollback 1: project B completely (dry run, then for real)'
Ok (Run @('revert', '--project', 'PRJ-B', '--dry-run', '--json')) 0 'dry run'
$rv = J
Ok "$($rv.status):$(@($rv.changes).Count)" 'dry_run:6' 'six B changes, newest first'
Ok (Run @('revert', '--project', 'PRJ-B')) 0 'revert all of B'
Ok (Q $st "SELECT to_regtype('zap.run_status') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'zap_runs' AND column_name = 'status');") 't' 'B types and columns gone'
Ok (Q $st "SELECT count(*) || '/' || count(*) FILTER (WHERE custom1 = 'a1') FROM zap.zp_lookup_data;") '120/10' 'A data intact'
Ok (Run @('deploy')) 0 'redeploy B'

Scenario 'Z19' 'Only function changes of A: back to v1 of zap_score'
Ok (Run @('revert', '--project', 'PRJ-A', '--kind', 'function', '--dry-run', '--json')) 1 'refused: the A view uses the function'
Ok ((@((J).problems) -join ' ') -match 'v_zap_summary|010_a_view_zap_summary') 'True' 'names the view that depends on it'

Scenario 'Z20' 'Structural guard: the baseline cannot be pulled from under everything'
Ok (Run @('revert', '--project', 'BASE')) 1 'revert BASE refused'
Ok (Has 'whose structure 001_zap_baseline changed') 'yes' 'names the structural dependency'

Scenario 'Z21' 'requires guard: B types cannot go while B columns use them'
Ok (Run @('revert', '--project', 'PRJ-B', '--kind', 'type')) 1 'revert B types refused'
Ok (Has '007_b_zap_runs_typed_cols (applied later, outside the scope) requires 006_b_types') 'yes' 'names the requiring change'

Scenario 'Z22' 'dml family: roll back the BUG-7 fix'
Ok (Run @('revert', '--project', 'BUG-7', '--kind', 'dml')) 0 'revert BUG-7 (update matches dml)'
Ok (Q $st "SELECT count(*) FROM zap.zaps WHERE status = 'retry';") 0 'retry status undone'
Ok (Run @('deploy')) 0 'redeploy'

Scenario 'Z23' 'A new A change needs a new B change: prod refuses A alone'
Mk '015_b_runs_index' 'CREATE INDEX zap_runs_status_idx ON zap.zap_runs (status);' (Guard '015_b_runs_index' "to_regclass('zap.zap_runs_status_idx') IS NOT NULL") 'DROP INDEX zap.zap_runs_status_idx;' (Meta 'PRJ-B' 'dev.bob' '')
Mk '016_a_failed_runs_view' "CREATE VIEW zap.v_failed_runs AS SELECT * FROM zap.zap_runs WHERE status = 'failed';" (Guard '016_a_failed_runs_view' "to_regclass('zap.v_failed_runs') IS NOT NULL") 'DROP VIEW zap.v_failed_runs;' (Meta 'PRJ-A' 'dev.alice' ', "requires": ["015_b_runs_index"]')
Ok (Run @('deploy')) 0 'deploy 015, 016 to ST'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-08-11')) 1 'prod August deploy refused'
Ok (Has '016_a_failed_runs_view requires 015_b_runs_index, which is not applied and is not in this deploy (project PRJ-B') 'yes' 'names the missing B change'

Scenario 'Z24' 'Release order fixes it: July (015) then August (016)'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-07-10')) 0 'July to prod'
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-08-11')) 0 'August to prod'
Ok (Q $prod "SELECT to_regclass('zap.v_failed_runs') IS NOT NULL;") 't' 'prod has the failed-runs view'

Scenario 'Z25' 'A single change is not going: dropped, then restored'
Mk '017_b_extra_lookup' "INSERT INTO zap.zp_lookup_data (id, code) VALUES (999, 'EXTRA');" (Guard '017_b_extra_lookup' 'EXISTS (SELECT 1 FROM zap.zp_lookup_data WHERE id = 999)') 'DELETE FROM zap.zp_lookup_data WHERE id = 999;' (Meta 'PRJ-B' 'dev.bob' ', "status": "dropped", "dropped_reason": "not needed"')
Ok (Run @('deploy')) 0 'deploy ST'
Ok (Has 'change dropped: not needed') 'yes' 'skipped with its reason'
Ok (Q $st "SELECT count(*) FROM zap.zp_lookup_data WHERE id = 999;") 0 'not applied'
Set-Content -Encoding UTF8 (Join-Path $changes '017_b_extra_lookup\meta.json') (Meta 'PRJ-B' 'dev.bob' '')
Ok (Run @('deploy')) 0 'restored: deploy ST'
Ok (Q $st "SELECT count(*) FROM zap.zp_lookup_data WHERE id = 999;") 1 'applied after restore'

Scenario 'Z26' 'Promotion gate: prod refuses what ST has not run'
Mk '018_b_late_fix' "UPDATE zap.zp_lookup_data SET custom8 = 'b8x' WHERE id = 11;" (Guard '018_b_late_fix' "EXISTS (SELECT 1 FROM zap.zp_lookup_data WHERE id = 11 AND custom8 = 'b8x')") "UPDATE zap.zp_lookup_data SET custom8 = 'b8' WHERE id = 11;" (Meta 'PRJ-B' 'dev.bob' '')
Ok (Run @('deploy', '--env', 'prod', '--release', '2026-07-10')) 1 'prod refuses 017/018'
Ok (Has '018_b_late_fix is not applied in st') 'yes' 'names the change ST has not run'

Scenario 'Z27' 'Unknown release, unknown project, unknown kind'
Ok (Run @('deploy', '--release', '2099-01-01')) 1 'unknown release refused'
Ok (Run @('revert', '--project', 'PRJ-Z')) 1 'unknown project refused'
Ok (Run @('revert', '--project', 'PRJ-A', '--kind', 'weird')) 1 'unknown kind refused'

Scenario 'Z28' 'A plain revert of an older change points to the scoped revert'
Ok (Run @('revert', '005_b_lookup_custom7_8')) 1 'refused: not the latest'
Ok (Has 'dmcr revert --project') 'yes' 'suggests revert --project'

Scenario 'Z29' 'History on prod carries the people'
Ok (Run @('history', '--env', 'prod', '--json')) 0 'history prod'
Ok ((@(J) | Where-Object { $_.change_id -eq '012_bug7_retry_status' }).requested_by) 'dev.carol' 'BUG-7 asked for by dev.carol'

Scenario 'Z30' 'Final verify on both databases'
Ok (Run @('verify', 'all', '--json')) 0 'verify all ST'
Ok (@(J | Where-Object { $_.status -eq 'failed' }).Count) 0 'no failed verify in ST'
Ok (Run @('verify', 'all', '--env', 'prod', '--json')) 0 'verify all prod'
Ok (@(J | Where-Object { $_.status -eq 'failed' }).Count) 0 'no failed verify in prod'

if ($Drop) { foreach ($db in $st, $prod) { Q 'postgres' "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null } }
Write-Host ''
if ($script:fail -eq 0) { Write-Host "RESULT: $script:pass passed, 0 failed" -ForegroundColor Green }
else { Write-Host "RESULT: $script:pass passed, $script:fail failed" -ForegroundColor Red; $script:failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Red } }
if (-not $Drop) { Write-Host "Kept: databases $st / $prod, changes in $changes, cfg $cfg" -ForegroundColor DarkGray }
if ($script:fail -gt 0) { exit 1 }
