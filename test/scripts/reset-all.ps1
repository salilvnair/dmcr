# Wipes every smoke / example / scenario run so DMCR starts empty. Keeps settings, LLM providers and
# keys, MCP servers, connections and the prompt library.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\scripts\reset-all.ps1 -Password <pw>
#   (this PC, Docker stand-in:  ... -Psql test\scripts\psql-local-sim.ps1 -Password postgres)
#
# What goes:
#   1. running DMCR Web servers are stopped (they would write their state back); start it again after
#   2. databases shop_test and shop_prod (and zapper_st / zapper_prod, when there) are dropped and recreated
#      empty, roles app_ro / app_rw dropped;
#      zapier_st, zapier_prod, zapier_rt, dmcr_local_test and dmcr_local_prod are dropped
#   3. everything inside <Workspace>\db\changes (change folders and releases.json)
#   4. ~\.dmcr-local\zapier, ~\.dmcr-web-zapier, the runner test temp folders, test\scripts\*.last.log
#   5. DMCR Web screen state in <WebHome>\db\dmcr.db: form drafts, Assistant conversations, Runner
#      history, AI footprint
#   6. the dmcr-test-pg container of the runner test suites, when Docker is there
# Options: -PgHost localhost -Port 5432 -User postgres -Password <pw> (or PGPASSWORD) -Psql <psql.exe>
#          -Workspace <DMCR Web workspace> (default ~\workspace\dmcr_repo)
#          -WebHome <DMCR Web home> (default ~\.dmcr-web-local)   -SkipDatabases
param(
    [string]$PgHost = 'localhost', [int]$Port = 5432, [string]$User = 'postgres',
    [string]$Password = $env:PGPASSWORD, [string]$Psql = '',
    [string]$Workspace = (Join-Path $HOME 'workspace\dmcr_repo'),
    [string]$WebHome = (Join-Path $HOME '.dmcr-web-local'),
    [switch]$SkipDatabases
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
function Step($n, $text) { Write-Host ''; Write-Host "  $n  $text" -ForegroundColor Cyan }
function Did($text) { Write-Host "      $text" -ForegroundColor Green }
function Skip($text) { Write-Host "      $text" -ForegroundColor DarkGray }

Write-Host 'DMCR reset: back to an empty screen' -ForegroundColor White

# 1 ── DMCR Web servers
Step 1 'Stop DMCR Web'
$servers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'local-server[\\/]dist[\\/]server\.js' })
if ($servers.Count) {
    foreach ($p in $servers) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Did "stopped DMCR Web (pid $($p.ProcessId))" }
} else { Skip 'none running' }

# 2 ── databases
Step 2 'Databases'
if ($SkipDatabases) { Skip 'skipped (-SkipDatabases)' }
else {
    if (-not $Psql) {
        $c = Get-Command psql -ErrorAction SilentlyContinue
        if ($c) { $Psql = $c.Source }
        else {
            $found = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
                Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '0') } -Descending | Select-Object -First 1
            if ($found) { $Psql = $found.FullName }
        }
    }
    if (-not $Psql) { Write-Host '      psql not found: pass -Psql <path> (databases left as they are)' -ForegroundColor Yellow }
    elseif (-not $Password) { Write-Host '      pass -Password or set PGPASSWORD (databases left as they are)' -ForegroundColor Yellow }
    else {
        $Psql = (Resolve-Path $Psql).Path
        function Q([string]$sql) {
            $old = $env:PGPASSWORD; $env:PGPASSWORD = $Password
            try { return ((& $Psql "postgresql://${User}@${PgHost}:${Port}/postgres" -X -q -t -A -c $sql 2>&1 | ForEach-Object { "$_" }) -join "`n").Trim() }
            finally { $env:PGPASSWORD = $old }
        }
        if ((Q 'SELECT 1;') -ne '1') { Write-Host "      cannot connect to ${PgHost}:$Port (databases left as they are)" -ForegroundColor Yellow }
        else {
            foreach ($db in 'zapier_st', 'zapier_prod', 'zapier_rt', 'dmcr_local_test', 'dmcr_local_prod') {
                if ((Q "SELECT 1 FROM pg_database WHERE datname = '$db';") -eq '1') { Q "DROP DATABASE $db WITH (FORCE);" | Out-Null; Did "dropped $db" }
            }
            foreach ($db in 'shop_test', 'shop_prod') {
                Q "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null
                Q "CREATE DATABASE $db;" | Out-Null
                Did "$db recreated empty"
            }
            # the walkthrough's own databases (zapper_st / zapper_prod, each owned by its login role): recreated empty, owner kept
            foreach ($db in 'zapper_st', 'zapper_prod') {
                if ((Q "SELECT 1 FROM pg_database WHERE datname = '$db';") -ne '1') { continue }
                $owner = Q "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$db';"
                Q "DROP DATABASE $db WITH (FORCE);" | Out-Null
                Q "CREATE DATABASE $db OWNER `"$owner`";" | Out-Null
                Did "$db recreated empty (owner $owner)"
            }
            Q 'DROP ROLE IF EXISTS app_ro; DROP ROLE IF EXISTS app_rw;' | Out-Null
            Did 'roles app_ro, app_rw dropped'
        }
    }
}

# 3 ── change folders
Step 3 "Change folders in $Workspace\db\changes"
$changes = Join-Path $Workspace 'db\changes'
if (Test-Path $changes) {
    $items = @(Get-ChildItem -Force $changes)
    foreach ($i in $items) { Remove-Item -Recurse -Force $i.FullName }
    if ($items.Count) { Did "removed $($items.Count) item(s)" } else { Skip 'already empty' }
} else { New-Item -ItemType Directory -Force $changes | Out-Null; Did 'created (empty)' }

# 4 ── scenario and test leftovers
Step 4 'Scenario and test leftovers'
$leftovers = @(
    (Join-Path $HOME '.dmcr-local\zapier'), (Join-Path $HOME '.dmcr-web-zapier'),
    (Join-Path $env:TEMP 'dmcr-runner-tests'), (Join-Path $env:TEMP 'dmcr-local-test'), (Join-Path $env:TEMP 'zrt')
) + @(Get-ChildItem (Join-Path $repo 'test\scripts') -Filter '*.last.log' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$gone = 0
foreach ($l in $leftovers) { if (Test-Path $l) { Remove-Item -Recurse -Force $l; $gone++; Did "removed $l" } }
if (-not $gone) { Skip 'nothing left over' }

# 5 ── DMCR Web screen state (settings, providers, MCP servers, connections and prompts stay)
Step 5 "DMCR Web state in $WebHome"
$dbFile = Join-Path $WebHome 'db\dmcr.db'
if (Test-Path $dbFile) {
    $sqljs = Join-Path $repo 'node_modules\sql.js\dist\sql-wasm.js'
    $js = @'
const fs = require('fs');
const [sqljs, file] = process.argv.slice(2);
require(sqljs)({ locateFile: f => require('path').join(require('path').dirname(sqljs), f) }).then(SQL => {
  const db = new SQL.Database(fs.readFileSync(file));
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values.map(v => v[0]) ?? [];
  const out = [];
  for (const t of ['conversation_sql', 'runner_event_log', 'ce_audit']) {
    if (!tables.includes(t)) continue;
    const n = db.exec(`SELECT count(*) FROM ${t}`)[0].values[0][0];
    db.run(`DELETE FROM ${t}`); out.push(`${t}: ${n} row(s) cleared`);
  }
  if (tables.includes('kv')) {
    const n = db.exec("SELECT count(*) FROM kv WHERE collection = 'ui_state'")[0].values[0][0];
    db.run("DELETE FROM kv WHERE collection = 'ui_state'"); out.push(`form drafts and open tabs (ui_state): ${n} cleared`);
  }
  fs.writeFileSync(file, Buffer.from(db.export()));
  console.log(out.join('\n'));
});
'@
    $tmpJs = Join-Path $env:TEMP 'dmcr-reset-web.js'
    Set-Content -Encoding ASCII $tmpJs $js
    & node $tmpJs $sqljs $dbFile | ForEach-Object { Did $_ }
    Remove-Item -Force $tmpJs
} else { Skip "no $dbFile" }

# 6 ── runner test container
Step 6 'Runner test container'
if (Get-Command docker -ErrorAction SilentlyContinue) {
    $exists = (docker ps -a --filter name=^dmcr-test-pg$ --format '{{.Names}}' 2>$null)
    if ($exists) { docker rm -f dmcr-test-pg 2>$null | Out-Null; Did 'removed dmcr-test-pg' } else { Skip 'none' }
} else { Skip 'no Docker on this PC' }

Write-Host ''
Write-Host 'Done. Start DMCR Web again; every tab is empty.' -ForegroundColor Green
