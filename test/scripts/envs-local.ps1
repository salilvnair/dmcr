# No-Docker environments for DMCR Web: the locally installed PostgreSQL (or any server you can
# reach with psql) gets two databases, shop_test and shop_prod, standing in for test and prod;
# pgsql_mcp runs from a Python venv instead of the dmcr-mcp container. Same walkthrough as
# envs.ps1, with these connections instead of ports 25432/25433.
#
#   powershell -File test\scripts\envs-local.ps1 up       create the databases (+ MCP venv)
#   powershell -File test\scripts\envs-local.ps1 reset    drop and recreate them empty
#   powershell -File test\scripts\envs-local.ps1 down     drop them
#   powershell -File test\scripts\envs-local.ps1 status   what is there now
#
# Options: -PgHost localhost -Port 5432 -User postgres -Password <pw> (or set PGPASSWORD)
#          -Psql <path to psql.exe> (default: psql on PATH, else the newest
#          C:\Program Files\PostgreSQL\<n>\bin\psql.exe)   -NoMcp (skip the Python venv)
#
# One server holds both databases, so roles (app_rw, app_ro, ...) are shared between "test" and
# "prod": a revert on test that drops a role drops it for prod too. Fine for trying DMCR; use two
# servers if you need test and prod fully apart.
param(
    [ValidateSet('up', 'reset', 'down', 'status')][string]$Action = 'up',
    [string]$PgHost = 'localhost', [int]$Port = 5432, [string]$User = 'postgres',
    [string]$Password = $env:PGPASSWORD, [string]$Psql = '', [switch]$NoMcp
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$dbs = @('shop_test', 'shop_prod')
$home2 = Join-Path $HOME '.dmcr-local'

# ── psql ──
if (-not $Psql) {
    $c = Get-Command psql -ErrorAction SilentlyContinue
    if ($c) { $Psql = $c.Source }
    else {
        $found = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
            Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '0') } -Descending | Select-Object -First 1
        if ($found) { $Psql = $found.FullName }
    }
}
if (-not $Psql) { throw 'psql not found. Install PostgreSQL (its bin folder has psql.exe) or pass -Psql <path>.' }
$Psql = (Resolve-Path $Psql).Path
if (-not $Password) {
    if ([Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost') {
        $s = Read-Host "Password for $User@${PgHost}:$Port" -AsSecureString
        $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    } else { throw 'Pass -Password or set PGPASSWORD.' }
}

function Q([string]$db, [string]$sql) {
    $old = $env:PGPASSWORD; $env:PGPASSWORD = $Password
    $ErrorActionPreference = 'Continue'   # psql NOTICEs on stderr must not abort (PS 5.1)
    try {
        $out = & $Psql "postgresql://${User}@${PgHost}:${Port}/$db" -X -q -t -A -v ON_ERROR_STOP=1 -c $sql 2>&1
        if ($LASTEXITCODE -ne 0) { throw "psql failed on ${db}: $($out | Out-String)" }
        return (($out | ForEach-Object { "$_" }) -join "`n").Trim()
    } finally { $env:PGPASSWORD = $old }
}
function Exists([string]$db) { (Q 'postgres' "SELECT count(*) FROM pg_database WHERE datname = '$db';") -eq '1' }

$ver = Q 'postgres' 'SHOW server_version;'
"PostgreSQL $ver at ${PgHost}:$Port  (psql: $Psql)"

if ($Action -eq 'status') {
    foreach ($db in $dbs) {
        if (-not (Exists $db)) { "$db  (missing)"; continue }
        # two queries: dmcr.change_log is resolved at plan time even inside a CASE branch
        $n = if ((Q $db "SELECT to_regclass('dmcr.change_log') IS NULL;") -eq 't') { 'no DMCR registry yet (run init)' }
             else { (Q $db 'SELECT count(*) FROM dmcr.change_log;') + ' changes applied' }
        "$db  $n"
    }
    return
}

if ($Action -in 'reset', 'down') {
    foreach ($db in $dbs) { Q 'postgres' "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null; "dropped $db" }
    # roles the walkthrough creates; they outlive the databases because roles belong to the server
    try { Q 'postgres' 'DROP ROLE IF EXISTS app_ro; DROP ROLE IF EXISTS app_rw;' | Out-Null; 'dropped roles app_ro, app_rw (if they existed)' }
    catch { "could not drop app_ro/app_rw (they still own objects or privileges elsewhere): $($_.Exception.Message.Trim())" }
    if ($Action -eq 'down') { return }
}

foreach ($db in $dbs) {
    if (Exists $db) { "$db exists" } else { Q 'postgres' "CREATE DATABASE $db;" | Out-Null; "created $db" }
}

# ── pgsql_mcp in a venv (replaces the dmcr-mcp container) ──
$py = $null
if (-not $NoMcp) {
    $venv = Join-Path $home2 'mcp-venv'
    $py = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path $py)) {
        New-Item -ItemType Directory -Force $home2 | Out-Null
        # python on PATH first, then the py launcher (a stale launcher can point at a removed install)
        $made = $false
        foreach ($base in @(@('python'), @('py', '-3'))) {
            if (-not (Get-Command $base[0] -ErrorAction SilentlyContinue)) { continue }
            $ErrorActionPreference = 'Continue'
            & $base[0] @($base | Select-Object -Skip 1) -m venv $venv 2>&1 | Out-Null
            $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE -eq 0 -and (Test-Path $py)) { $made = $true; break }
        }
        if (-not $made) { throw 'Python 3.10+ is needed for the MCP server (python -m venv failed), or pass -NoMcp.' }
    }
    $ErrorActionPreference = 'Continue'
    & $py -m pip install -q --disable-pip-version-check -e "$(Join-Path $repo 'pgsql_mcp')[yaml]"
    if ($LASTEXITCODE -ne 0) { throw 'pip install of pgsql_mcp failed' }
    $ErrorActionPreference = 'Stop'
    "MCP server installed in $venv"
}

''
'── DMCR Web ──'
"  `$env:DMCR_PSQL = `"$Psql`""
'  $env:DMCR_WEB_ENV_FILE = "<path to your .env with the AI provider key>"'
'  npm run web            → http://127.0.0.1:7799'
''
'── Settings › DMCR Config ──'
'  Changes directory   db/changes'
'  Active environment  test'
"  test   postgresql://${User}@${PgHost}:${Port}/shop_test   (password: yours)"
"  prod   postgresql://${User}@${PgHost}:${Port}/shop_prod   (password: yours)"
'  Release pipeline    prod › Promote from: test · Out of order: block · Checksum policy: block'
if ($py) {
    ''
    '── Settings › MCP Servers (one per environment) ──'
    "  Command   $py"
    '  Args      -m'
    '            app_mcp.server'
    "  Env       APP_PG_CONN=postgresql://${User}:<password>@${PgHost}:${Port}/shop_test   (shop-prod: .../shop_prod)"
    '  Category  Database'
}
