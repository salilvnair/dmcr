# Regression tests for the defects found in the 2026-10 review of dmcr.ps1 — Windows PowerShell 5.1, psql in the
# dmcr-test-pg container through psql-shim.ps1. Same scenarios as review.sh.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'rwork'; $cfgDir = Join-Path $tmp 'rcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$conn = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_CONN = $conn; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
$cfg = Join-Path $cfgDir 'dmcr.cfg'
function Write-Cfg($policy) { "[dmcr]`nenv = staging`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`nchecksum_policy = $policy`n`n[staging]`nconn =`n`n[placeholders]`nschema = app`n" | Set-Content -Encoding ASCII $cfg }
Write-Cfg 'warn'
'{"deployOnlyPatterns":[{"label":"DROP TABLE","regex":"(?i)\\bDROP\\s+TABLE\\b","scope":"deployOnly"}],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":true}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$script:pass = 0; $script:fail = 0
function Q([string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++; @($script:last | Select-Object -Last 14) | ForEach-Object { "        | $_" } } }
# Run: stdout and stderr together (for messages); RunOut: stdout only (for JSON)
function Run([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }; return $LASTEXITCODE }
function RunOut([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>$null | ForEach-Object { "$_" }; return $LASTEXITCODE }
function Has([string]$text) { [bool](@($script:last | Where-Object { $_ -like "*$text*" }).Count) }
function JsonOk { $t = ($script:last -join "`n").Trim(); if (-not $t) { return $false }; try { $null = $t | ConvertFrom-Json; $true } catch { $false } }
function Mk($id, $deploy, $verify, $revert, $meta) {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') $revert
    if ($meta) { Set-Content -Encoding UTF8 (Join-Path $d 'meta.json') $meta }
}
function RmChange($id) { Remove-Item -Recurse -Force (Join-Path $work "changes\$id") -ErrorAction SilentlyContinue }

Q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;" | Out-Null
Run @('init') | Out-Null

"== a placeholder without a value never deploys an empty change"
Mk '001_t1' 'CREATE TABLE ${scheam}.t1 (id int, note text);' 'SELECT 1;' 'DROP TABLE ${schema}.t1;'
Ok (Run @('deploy')) 1 'deploy refuses'
Ok (Has 'Unresolved placeholder') 'True' 'says why'
Ok (Q "SELECT count(*) FROM dmcr.change_log;") '0' 'nothing recorded'
Set-Content -Encoding UTF8 (Join-Path $work 'changes\001_t1\deploy.sql') 'CREATE TABLE ${schema}.t1 (id int, note text);'
Ok (Run @('deploy')) 0 'deploys once the placeholder resolves'
Ok (Q "SELECT count(*) FROM app.t1;") '0' 'the table is there'

"== plan with requires is not a circular dependency"
Mk '002_t2' 'CREATE TABLE app.t2 (id int);' 'SELECT 1;' 'DROP TABLE app.t2;' '{"requires": ["001_t1"]}'
Ok (Run @('plan')) 0 'plan exits 0'
Ok (Has 'Circular') 'False' 'no false circular dependency'
Ok (RunOut @('plan', '--json')) 0 'plan --json exits 0'
Ok (JsonOk) 'True' 'plan --json is JSON'
Ok (Run @('deploy')) 0 'deploys'

"== parse never commits the user's SQL"
Q "INSERT INTO app.t1 (id) VALUES (1);" | Out-Null
Ok (RunOut @('parse', 'DELETE FROM app.t1; COMMIT;')) 0 'parse exits 0'
Ok (Has '"ok":false') 'True' 'refused'
Ok (Has 'COMMIT') 'True' 'names COMMIT'
Ok (Q "SELECT count(*) FROM app.t1;") '1' 'the row is still there'
Ok (RunOut @('parse', 'INSERT INTO app.t1 (id) VALUES (2) WHERE;')) 0 'a syntax error parses'
Ok (Has '"ok":false') 'True' 'reported'
Ok (Has '"line":1') 'True' "on line 1 of the user's SQL"

"== the danger scan reads strings and comments in one pass"
Mk '003_lit' "INSERT INTO app.t1 (id, note) VALUES (3, '--'); DROP TABLE app.t2;" 'SELECT 1;' 'DELETE FROM app.t1 WHERE id = 3;'
Ok (Run @('deploy')) 1 "DROP TABLE after a '--' string is still blocked"
Ok (Q "SELECT count(*) FROM app.t2;") '0' 'app.t2 still exists'
RmChange '003_lit'
Mk '003_semi' "UPDATE app.t1 SET note = 'a;b' WHERE id = 1;" 'SELECT 1;' 'UPDATE app.t1 SET note = NULL WHERE id = 1;'
Ok (Run @('deploy')) 0 "a ';' inside a string does not split the statement"
Ok (Q "SELECT note FROM app.t1 WHERE id = 1;") 'a;b' 'the update ran'

"== a failed repeatable is a failed deploy"
$rb = Join-Path $work 'changes\R__bad'; New-Item -ItemType Directory -Force $rb | Out-Null
Set-Content -Encoding UTF8 (Join-Path $rb 'deploy.sql') 'CREATE OR REPLACE VIEW app.v_bad AS SELECT * FROM app.nope;'
Ok (RunOut @('deploy', '--json')) 1 'deploy exits 1'
Ok (Has '"status":  "failed"') 'True' 'JSON says failed'
Ok (Has 'R__bad') 'True' 'and names it'
Ok (JsonOk) 'True' 'deploy --json on failure is JSON'
Ok (RunOut @('repeatable', '--json')) 1 'dmcr repeatable exits 1 too'
RmChange 'R__bad'

"== deploy --json always prints a document"
Ok (RunOut @('deploy', '--json')) 0 'nothing to deploy'
Ok (@((($script:last -join "`n") | ConvertFrom-Json).changes).Count) 0 'an empty changes list'
Ok (JsonOk) 'True' 'valid JSON (no log lines on stdout)'

"== verify all reports the error and fails the run"
Mk '004_t4' 'CREATE TABLE app.t4 (id int);' "DO `$`$ BEGIN IF to_regclass('app.t4') IS NULL THEN RAISE EXCEPTION 'missing t4'; END IF; END `$`$;" 'DROP TABLE app.t4;'
Ok (Run @('deploy')) 0 'deploys'
Q "DROP TABLE app.t4;" | Out-Null
Ok (RunOut @('verify', 'all', '--json')) 1 'verify all exits 1 on a failure'
Ok (Has 'missing t4') 'True' 'the error is in the JSON'
Ok (Has '"error":') 'True' 'as the error field'
Q "CREATE TABLE app.t4 (id int);" | Out-Null
Ok (RunOut @('verify', 'all', '--json')) 0 'and 0 once it verifies'

"== a deploy failure records the real error"
Mk '005_boom' 'SELECT 1/0;' 'SELECT 1;' 'SELECT 1;'
Ok (RunOut @('deploy', '--json')) 1 'deploy exits 1'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE change_id = '005_boom' AND status = 'failure' AND message LIKE '%division by zero%';") '1' "event_log has psql's error"
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE change_id = '005_boom' AND status = 'failure' AND duration_ms < 60000;") '1' 'duration is in milliseconds'
Ok (Has '"error":') 'True' 'the JSON row has the error'
RmChange '005_boom'

"== baseline skips dropped and danger_ changes"
Mk '005_danger_x' 'DROP TABLE app.t1;' 'SELECT 1;' 'SELECT 1;'
Mk '006_gone' 'CREATE TABLE app.t6 (id int);' 'SELECT 1;' 'DROP TABLE app.t6;' '{"status": "dropped", "dropped_reason": "no"}'
Ok (Run @('baseline', '006_gone')) 0 'baseline exits 0'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('005_danger_x', '006_gone');") '0' 'neither is recorded'
RmChange '005_danger_x'; RmChange '006_gone'

"== revertLast has a deployment id; revert.sql edits are caught"
Mk '005_t7' 'CREATE TABLE app.t7 (id int);' 'SELECT 1;' 'DROP TABLE app.t7;'
Ok (Run @('deploy')) 0 'deploys'
Set-Content -Encoding UTF8 (Join-Path $work 'changes\005_t7\revert.sql') 'DROP TABLE app.t7; -- edited'
Write-Cfg 'block'
Ok (Run @('revertLast')) 1 'an edited revert.sql is refused (checksum_policy=block)'
Ok (Has 'revert.sql') 'True' 'names revert.sql'
Write-Cfg 'warn'
Ok (Run @('revertLast')) 0 'reverts with policy=warn'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'revert' AND change_id = '005_t7' AND deploy_id IS NOT NULL;") '1' 'the revert event has a deployment id'

"== JSON output is escaped; a string ""false"" is not a no-transaction change"
$env:DMCR_ACTOR = "o'brien `"x`"\y"; Run @('deploy') | Out-Null; $env:DMCR_ACTOR = 'tester'
Ok (RunOut @('history', '--json')) 0 'history --json'
Ok (JsonOk) 'True' 'is valid JSON with quotes and a backslash in the actor'
Ok (RunOut @('show', 'config', '--json')) 0 'show config --json'
Ok (JsonOk) 'True' 'is valid JSON'
Mk '006_t8' 'CREATE TABLE app.t8 (id int);' 'SELECT 1;' 'DROP TABLE app.t8;' '{"transaction": "false"}'
Ok (Run @('deploy')) 0 'deploys'
Ok (Has 'OUTSIDE a transaction') 'False' 'inside a transaction (the string is not false)'

"== line endings alone are not an edit"
# Set-Content wrote these with CRLF: LF is the other line ending
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
foreach ($n in 'deploy.sql', 'revert.sql') {
    $p = Join-Path $work "changes\006_t8\$n"
    [System.IO.File]::WriteAllBytes($p, $latin1.GetBytes($latin1.GetString([System.IO.File]::ReadAllBytes($p)).Replace("`r`n", "`n")))
}
Write-Cfg 'block'
Ok (RunOut @('check', '--json')) 0 'check exits 0'
Ok (Has 'CHECKSUM') 'False' 'LF-only change is not reported as edited'
Ok (Run @('deploy')) 0 'deploy is not blocked by it (checksum_policy=block)'
$p8 = Join-Path $work 'changes\006_t8\deploy.sql'; $orig8 = [System.IO.File]::ReadAllBytes($p8)
Set-Content -Encoding UTF8 $p8 'CREATE TABLE app.t8 (id int, x int);'
Ok (Run @('deploy')) 1 'a real edit is still blocked'
[System.IO.File]::WriteAllBytes($p8, $orig8)
Write-Cfg 'warn'

"== a later INSERT does not supersede an earlier table definition"
Mk '007_t9' 'CREATE TABLE app.t9 (id int, label text);' "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 't9' AND column_name = 'label') THEN RAISE EXCEPTION 'no label column'; END IF; END `$`$;" 'DROP TABLE app.t9;'
Mk '008_t9rows' 'INSERT INTO app.t9 (id) VALUES (1);' 'SELECT 1;' 'DELETE FROM app.t9 WHERE id = 1;'
Ok (Run @('deploy')) 0 'deploys'
Q "ALTER TABLE app.t9 DROP COLUMN label;" | Out-Null
Ok (RunOut @('verify', 'all', '--json')) 1 'verify all exits 1'
$v9 = @((($script:last -join "`n") | ConvertFrom-Json) | ForEach-Object { $_ } | Where-Object { $_.change_id -eq '007_t9' })
Ok "$($v9.status)" 'failed' "the table's own drift is a failure, not superseded"
Q "ALTER TABLE app.t9 ADD COLUMN label text;" | Out-Null

"== tags and ticket in JSON; tag create logged; repair usage; check graph"
Mk '009_tagged' 'CREATE TABLE app.t10 (id int);' 'SELECT 1;' 'DROP TABLE app.t10;' '{"tags": ["alpha", "beta"], "ticket": "T-1"}'
Ok (RunOut @('status', '--json')) 0 'status --json'
Ok (Has '"alpha"') 'True' 'status has the tags'
Ok (RunOut @('plan', '--json')) 0 'plan --json'
Ok (Has '"alpha"') 'True' 'plan has the tags'
Ok (Has '"T-1"') 'True' 'plan has the ticket'
Ok (Run @('deploy')) 0 'deploys'
Ok (Run @('tag', 'create', 'rel-1', 'first', 'cut')) 0 'tag create'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'tag' AND message LIKE '%rel-1%';") '1' 'the tag is in event_log'
Ok (RunOut @('tag', 'list', '--json')) 0 'tag list'
Ok (Has 'first cut') 'True' 'the whole description is kept'
Ok (Run @('repair')) 1 'repair without an action exits 1'
Ok (Has 'Usage: dmcr repair') 'True' 'and shows the usage'
Ok (Run @('check')) 0 'check exits 0'
Ok (Has 'Dependency graph OK') 'True' 'check validates the dependency graph'

"== a dependency cycle is refused before anything runs"
Mk '010_ca' 'CREATE TABLE app.ca (id int);' 'SELECT 1;' 'DROP TABLE app.ca;' '{"requires": ["011_cb"]}'
Mk '011_cb' 'CREATE TABLE app.cb (id int);' 'SELECT 1;' 'DROP TABLE app.cb;' '{"requires": ["010_ca"]}'
Ok (Run @('deploy')) 1 'deploy refuses'
Ok (Has 'ircular') 'True' 'names the cycle'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('010_ca', '011_cb');") '0' 'nothing recorded'
Ok (Q "SELECT count(*) FROM dmcr.deploy_lock;") '0' 'no lock left behind'
RmChange '010_ca'; RmChange '011_cb'

''; "RESULT: $($script:pass) passed, $($script:fail) failed"
exit $(if ($script:fail -eq 0) { 0 } else { 1 })
