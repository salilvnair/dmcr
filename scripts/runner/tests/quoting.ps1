# Values with double quotes, backslashes and single quotes must reach PostgreSQL exactly.
# Windows PowerShell 5.1 does not escape " in native command lines, so before the fix a tag
# description like "Release 1" or an error message naming column "x" broke the psql call.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'qwork'; $cfgDir = Join-Path $tmp 'qcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$conn = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
Remove-Item Env:DMCR_PROMOTE_FROM_CONN -ErrorAction SilentlyContinue
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_CONN = $conn; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester "qa" \ o''neil'
$cfg = Join-Path $cfgDir 'dmcr.cfg'
"[dmcr]`nenv = staging`nchanges_dir = changes`n`n[staging]`nconn =" | Set-Content -Encoding ASCII $cfg
'{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$script:pass = 0; $script:fail = 0
function Q([string]$sql) { ($sql | docker exec -i dmcr-test-pg psql $conn -X -t -A | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -ceq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ } }
# The runner is started the way the extension starts it (Node escapes arguments by the C runtime
# rules); `& powershell @a` would itself mangle the quotes in the arguments under test.
function Quote-Arg([string]$a) {
    if ($a -eq '') { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
function Run([string[]]$a) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = ((@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-c', $cfg) + $a) | ForEach-Object { Quote-Arg $_ }) -join ' '
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    $script:last = @(($so.Result + "`n" + $se.Result) -split "`r?`n")
    return $p.ExitCode
}
function Has([string]$text) { [bool](@($script:last | Where-Object { $_ -like "*$text*" }).Count) }
function Mk($id, $deploy) {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') 'SELECT 1;'
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') 'DROP TABLE IF EXISTS app."Quoted Table";'
}

Q 'DROP SCHEMA IF EXISTS dmcr CASCADE; DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;' | Out-Null
Run @('init') | Out-Null

"== tag description with double quotes, a backslash and a single quote"
Mk '001_quoted' 'CREATE TABLE app."Quoted Table" ("Label" text);'
Ok (Run @('deploy')) 0 'deploy a change with quoted identifiers'
$desc = 'Release "1": it''s C:\path\'
Ok (Run @('tag', 'create', 'v1', $desc)) 0 'tag create'
Ok (Q "SELECT description FROM dmcr.tags WHERE tag_name = 'v1';") $desc 'description stored exactly'
Ok (Q "SELECT actor FROM dmcr.event_log WHERE action = 'tag' ORDER BY id DESC LIMIT 1;") 'tester "qa" \ o''neil' 'actor with quotes and backslash stored exactly'

"== a failure message naming a quoted column is logged"
Mk '002_bad' 'ALTER TABLE app."Quoted Table" DROP COLUMN "No Such";'
Ok (Run @('deploy')) 1 'deploy fails'
Ok (Has 'Could not log deploy failure event') 'False' 'failure event logged without a psql error'
Ok (Q "SELECT message LIKE '%ERROR: column `"No Such`" of relation `"Quoted Table`" does not exist' FROM dmcr.event_log WHERE change_id = '002_bad' AND status = 'failure' ORDER BY id DESC LIMIT 1;") 't' 'whole error message stored, quotes intact'
Ok (Has 'of relation "Quoted Table" does not exist') 'True' 'whole error message shown'

"== registry lookups and tags with quoted values still work"
Ok (Run @('status')) 0 'status'
Ok (Run @('tag', 'list')) 0 'tag list'
Ok (Has 'Release "1"') 'True' 'tag list shows the description'
Ok (Run @('tag', 'list', '--json')) 0 'tag list --json'
$tags = ($script:last | Where-Object { $_ -notmatch '^\s*(INFO|DEBUG)' }) -join "`n" | ConvertFrom-Json
Ok (@($tags)[0].description) $desc 'tag list --json returns the description exactly'

""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
