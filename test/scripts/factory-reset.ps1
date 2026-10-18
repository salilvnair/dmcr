# Factory reset (local / Docker test only, never shipped): DMCR back to nothing.
#   1. everything inside <Workspace>\db\changes goes, dot files too (.gitkeep, a stray .git, releases.json, conflicts.json)
#      and the emptied folder is committed in the workspace git, so the Commits tab and Releases start clean
#      (the workspace's own .git and its history stay; -NoCommit leaves the deletion uncommitted)
#   2. in shop_test and shop_prod: the dmcr registry schema and the environment schemas zp_st and zp are dropped
#      with everything in them (CASCADE). Releases > Set up DMCR creates dmcr and the schema again.
# Settings, DBA name, LLM providers, MCP servers and the prompt library stay. Restart DMCR Web afterwards.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\scripts\factory-reset.ps1 -Psql test\scripts\psql-local-sim.ps1 -Password postgres
param(
    [string]$PgHost = 'localhost', [int]$Port = 5432, [string]$User = 'postgres',
    [string]$Password = $env:PGPASSWORD, [string]$Psql = '',
    [string]$Workspace = (Join-Path $HOME 'workspace\dmcr_repo'),
    [string[]]$Databases = @('shop_test', 'shop_prod'),
    [string[]]$Schemas = @('dmcr', 'zp_st', 'zp'),
    [switch]$NoCommit
)
$ErrorActionPreference = 'Continue'
# -File passes "a,b" as one string
$Databases = @($Databases | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$Schemas = @($Schemas | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
function Step($n, $text) { Write-Host ''; Write-Host "  $n  $text" -ForegroundColor Cyan }
function Did($text) { Write-Host "      $text" -ForegroundColor Green }
function Skip($text) { Write-Host "      $text" -ForegroundColor DarkGray }
function Bad($text) { Write-Host "      $text" -ForegroundColor Red; $script:bad++ }
$script:bad = 0
Write-Host 'DMCR factory reset' -ForegroundColor White

# 1 ── change folders
Step 1 "Everything in $Workspace\db\changes"
$changes = Join-Path $Workspace 'db\changes'
if (Test-Path $changes) {
    $items = @(Get-ChildItem -Force $changes)
    foreach ($i in $items) { Remove-Item -Recurse -Force $i.FullName }
    if ($items.Count) { Did "removed $($items.Count) item(s)" } else { Skip 'already empty' }
} else { New-Item -ItemType Directory -Force $changes | Out-Null; Did 'created (empty)' }
if ($NoCommit) { Skip 'not committed (-NoCommit)' }
elseif (Test-Path (Join-Path $Workspace '.git')) {
    $pending = (git -C $Workspace status --porcelain -- db/changes) -join "`n"
    if ($pending) {
        git -C $Workspace add -A -- db/changes | Out-Null
        git -C $Workspace -c user.name=dmcr -c user.email=dmcr@localhost commit -q -m 'chore(dmcr): factory reset, changes folder emptied' -- db/changes | Out-Null
        if ($LASTEXITCODE -eq 0) { Did "committed: $((git -C $Workspace log -1 --format='%h %s'))" } else { Bad 'commit failed' }
    } else { Skip 'nothing to commit' }
} else { Skip 'workspace is not a git repository' }

# 2 ── schemas
Step 2 "Schemas $($Schemas -join ', ') in $($Databases -join ', ')"
if (-not $Psql) { $c = Get-Command psql -ErrorAction SilentlyContinue; if ($c) { $Psql = $c.Source } }
if (-not $Psql) { Bad 'psql not found: pass -Psql <path>' }
elseif (-not $Password) { Bad 'pass -Password or set PGPASSWORD' }
else {
    $Psql = (Resolve-Path $Psql).Path
    function Q([string]$db, [string]$sql) {
        $old = $env:PGPASSWORD; $env:PGPASSWORD = $Password
        try { return ((& $Psql "postgresql://${User}@${PgHost}:${Port}/$db" -X -q -t -A -c $sql 2>&1 | ForEach-Object { "$_" }) -join "`n").Trim() }
        finally { $env:PGPASSWORD = $old }
    }
    foreach ($db in $Databases) {
        if ((Q $db 'SELECT 1;') -ne '1') { Bad "$db not reachable (left as it is)"; continue }
        $drop = ($Schemas | ForEach-Object { "DROP SCHEMA IF EXISTS `"$_`" CASCADE;" }) -join ' '
        Q $db $drop | Out-Null
        $left = Q $db "SELECT string_agg(nspname, ', ') FROM pg_namespace WHERE nspname IN ('$($Schemas -join "','")');"
        if ($left) { Bad "$db still has: $left" } else { Did "${db}: dropped $($Schemas -join ', ')" }
    }
}

Write-Host ''
if ($script:bad) { Write-Host "Done with $($script:bad) problem(s) (red above)." -ForegroundColor Yellow }
else { Write-Host 'Done. Restart DMCR Web, then Releases > Set up DMCR on test and on prod.' -ForegroundColor Green }
