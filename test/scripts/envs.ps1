# Production-like environments for DMCR Web: two PostgreSQL 16 instances (test, prod), a psql
# client and the bundled pgsql_mcp server, all on one Docker network.
#
#   powershell -File test\scripts\envs.ps1 up      start (keeps data between runs)
#   powershell -File test\scripts\envs.ps1 reset   drop everything and start empty
#   powershell -File test\scripts\envs.ps1 down    stop and remove
#
# Host ports: test 55432, prod 55433 (database "shop"). Passwords: test "testpass", prod
# "prodpass" — over TCP, so they are really checked. DMCR's runner reaches them through
# test\scripts\psql-docker.ps1 (set as DMCR_PSQL), which runs psql in dmcr-psql.
param([ValidateSet('up', 'reset', 'down')][string]$Action = 'up')
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$net = 'dmcr-net'
$dbs = @(
    @{ name = 'dmcr-pg-test'; port = 55432; pass = 'testpass' },
    @{ name = 'dmcr-pg-prod'; port = 55433; pass = 'prodpass' }
)
$all = @('dmcr-pg-test', 'dmcr-pg-prod', 'dmcr-psql', 'dmcr-mcp')

function Exists($n) { [bool](docker ps -a --filter "name=^$n$" --format '{{.Names}}') }

if ($Action -in 'down', 'reset') {
    foreach ($c in $all) { docker rm -f $c 2>$null | Out-Null }
    if ($Action -eq 'down') { docker network rm $net 2>$null | Out-Null; 'environments removed'; return }
}

docker network inspect $net 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { docker network create $net | Out-Null }

foreach ($d in $dbs) {
    if (-not (Exists $d.name)) {
        docker run -d --name $d.name --network $net -p "$($d.port):5432" -e "POSTGRES_PASSWORD=$($d.pass)" -e POSTGRES_DB=shop postgres:16 | Out-Null
    } else { docker start $d.name 2>$null | Out-Null }
}
if (-not (Exists 'dmcr-psql')) {
    # psql client only (the server inside it is never used)
    docker run -d --name dmcr-psql --network $net -e POSTGRES_PASSWORD=unused postgres:16 | Out-Null
} else { docker start dmcr-psql 2>$null | Out-Null }
if (-not (Exists 'dmcr-mcp')) {
    docker run -d --name dmcr-mcp --network $net python:3.12-slim sleep infinity | Out-Null
    docker exec dmcr-mcp mkdir -p /srv/pgsql_mcp | Out-Null
    foreach ($f in 'app_mcp', 'log4py', 'pyproject.toml', 'README.md') { docker cp (Join-Path $repo "pgsql_mcp\$f") "dmcr-mcp:/srv/pgsql_mcp/$f" | Out-Null }
    docker exec dmcr-mcp pip install -q --disable-pip-version-check --root-user-action=ignore '/srv/pgsql_mcp[yaml]' | Out-Null
} else { docker start dmcr-mcp 2>$null | Out-Null }

foreach ($d in $dbs) {
    for ($i = 0; $i -lt 60; $i++) { docker exec $d.name pg_isready -U postgres -d shop -h localhost 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
}
"test  postgresql://postgres@localhost:55432/shop   (password testpass)"
"prod  postgresql://postgres@localhost:55433/shop   (password prodpass)"
"MCP   docker exec -i -w /srv/pgsql_mcp dmcr-mcp python -m app_mcp.server --conn postgresql://postgres:<pass>@dmcr-pg-<env>:5432/shop"
