# Smoke clear: everything back to the first step of the example run, then a check that it really is empty.
# The one reset for the local / Docker test setup (dev only, not shipped: test/** is in .vscodeignore).
# Runs reset-all.ps1 (DMCR Web stopped, shop_test / shop_prod recreated empty, so the dmcr registry and the
# environment schemas zp_st / zp go too; Releases > Set up DMCR creates them again; change folders, scenario
# leftovers, DMCR Web screen state, runner test container) and on top of it:
#   - drops the scratch databases of later work (shop_staging, shop_ci, shop_speed)
#   - clears the DBA name (Settings > DMCR Config), so the run sets it again; -KeepDba keeps it
#   - commits the emptied changes folder in the workspace git, so the next run starts from a clean tree
#     (history stays; nothing is reset or pushed); -NoCommit leaves the deletion uncommitted
#   - checks: no table in shop_test / shop_prod (and zapper_st / zapper_prod), no dmcr schema, changes folder empty, git tree clean
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\scripts\smoke-clear-all.ps1 -Password <pw>
#   (this PC, Docker stand-in:  ... -Psql test\scripts\psql-local-sim.ps1 -Password postgres)
# Then start DMCR Web again.
param(
    [string]$PgHost = 'localhost', [int]$Port = 5432, [string]$User = 'postgres',
    [string]$Password = $env:PGPASSWORD, [string]$Psql = '',
    [string]$Workspace = (Join-Path $HOME 'workspace\dmcr_repo'),
    [string]$WebHome = (Join-Path $HOME '.dmcr-web-local'),
    [switch]$KeepDba, [switch]$NoCommit
)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)
function Step($n, $text) { Write-Host ''; Write-Host "  $n  $text" -ForegroundColor Cyan }
function Did($text) { Write-Host "      $text" -ForegroundColor Green }
function Skip($text) { Write-Host "      $text" -ForegroundColor DarkGray }
function Bad($text) { Write-Host "      $text" -ForegroundColor Red; $script:bad++ }
$script:bad = 0

$resetArgs = @('-PgHost', $PgHost, '-Port', $Port, '-User', $User, '-Workspace', $Workspace, '-WebHome', $WebHome)
if ($Password) { $resetArgs += @('-Password', $Password) }
if ($Psql) { $resetArgs += @('-Psql', $Psql) }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'reset-all.ps1') @resetArgs

if (-not $Psql) { $c = Get-Command psql -ErrorAction SilentlyContinue; if ($c) { $Psql = $c.Source } }
function Q([string]$db, [string]$sql) {
    $old = $env:PGPASSWORD; $env:PGPASSWORD = $Password
    try { return ((& $Psql "postgresql://${User}@${PgHost}:${Port}/$db" -X -q -t -A -c $sql 2>&1 | ForEach-Object { "$_" }) -join "`n").Trim() }
    finally { $env:PGPASSWORD = $old }
}

Step 7 'Scratch databases'
if (-not $Psql -or -not $Password) { Skip 'no psql or password: left as they are' }
else {
    $Psql = (Resolve-Path $Psql).Path
    foreach ($db in 'shop_staging', 'shop_ci', 'shop_speed') {
        if ((Q 'postgres' "SELECT 1 FROM pg_database WHERE datname = '$db';") -eq '1') { Q 'postgres' "DROP DATABASE $db WITH (FORCE);" | Out-Null; Did "dropped $db" }
    }
}

Step 8 'DBA name'
$dbFile = Join-Path $WebHome 'db\dmcr.db'
if ($KeepDba) { Skip 'kept (-KeepDba)' }
elseif (Test-Path $dbFile) {
    $sqljs = Join-Path $repo 'node_modules\sql.js\dist\sql-wasm.js'
    $js = @'
const fs = require('fs'); const path = require('path');
const [sqljs, file] = process.argv.slice(2);
require(sqljs)({ locateFile: f => path.join(path.dirname(sqljs), f) }).then(SQL => {
  const db = new SQL.Database(fs.readFileSync(file));
  const n = db.exec("SELECT count(*) FROM kv WHERE collection = 'dmcr_profile'")[0].values[0][0];
  db.run("DELETE FROM kv WHERE collection = 'dmcr_profile'");
  fs.writeFileSync(file, Buffer.from(db.export()));
  console.log(n ? 'cleared' : 'none set');
});
'@
    $tmpJs = Join-Path $env:TEMP 'dmcr-smoke-clear.js'
    Set-Content -Encoding ASCII $tmpJs $js
    & node $tmpJs $sqljs $dbFile | ForEach-Object { Did "DBA name: $_" }
    Remove-Item -Force $tmpJs
} else { Skip "no $dbFile" }

Step 9 "Workspace git ($Workspace)"
if (-not (Test-Path (Join-Path $Workspace '.git'))) { Skip 'not a git repository' }
elseif ($NoCommit) { Skip 'not committed (-NoCommit)' }
else {
    $dirty = git -C $Workspace status --porcelain -- db
    if ($dirty) {
        git -C $Workspace add -A -- db | Out-Null
        # the workspace's git config stays as it is: identity only for this commit
        git -C $Workspace -c user.name=dmcr-smoke -c user.email=dmcr-smoke@localhost commit -q -m 'chore: smoke clear (empty changes folder for a fresh run)' | Out-Null
        Did "committed: $(git -C $Workspace log -1 --format='%h %s')"
    } else { Skip 'nothing to commit' }
}

Step 10 'Check'
if ($Psql -and $Password) {
    foreach ($db in 'shop_test', 'shop_prod', 'zapper_st', 'zapper_prod') {
        if ($db -like 'zapper_*' -and (Q 'postgres' "SELECT 1 FROM pg_database WHERE datname = '$db';") -ne '1') { continue }
        $t = Q $db "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');"
        $d = Q $db "SELECT count(*) FROM pg_namespace WHERE nspname = 'dmcr';"
        if ($t -eq '0' -and $d -eq '0') { Did "${db}: no tables, no dmcr registry" } else { Bad "${db}: $t table(s), dmcr schema $d" }
    }
}
$changes = Join-Path $Workspace 'db\changes'
$n = @(Get-ChildItem -Force $changes -ErrorAction SilentlyContinue).Count
if ($n -eq 0) { Did 'changes folder empty' } else { Bad "changes folder has $n item(s)" }
if ((Test-Path (Join-Path $Workspace '.git')) -and -not $NoCommit) {
    if (git -C $Workspace status --porcelain) { Bad 'workspace git tree not clean' } else { Did 'workspace git tree clean' }
}
Write-Host ''
if ($script:bad) { Write-Host "Smoke clear finished with $script:bad problem(s)." -ForegroundColor Red; exit 1 }
Write-Host 'Smoke clear done: start DMCR Web again for a fresh run.' -ForegroundColor Green
