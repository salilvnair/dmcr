# Stand-in for "PostgreSQL installed locally", for trying the no-Docker scripts on a machine that
# has Docker but no PostgreSQL: one postgres:16 container published on localhost:5432.
# On a PC with a real PostgreSQL install you do not need this file.
#
#   powershell -File test\scripts\local-sim.ps1 up     start (password: postgres)
#   powershell -File test\scripts\local-sim.ps1 down   stop and remove
#
# There is no psql on the host here either, so use test\scripts\psql-local-sim.ps1 as the psql:
#   powershell -File test\scripts\envs-local.ps1 up -Psql test\scripts\psql-local-sim.ps1 -Password postgres
param([ValidateSet('up', 'down')][string]$Action = 'up', [int]$Port = 5432, [string]$Password = 'postgres')
$ErrorActionPreference = 'Continue'
$name = 'dmcr-local-pg'

docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop (this stand-in needs it; a real local PostgreSQL does not).' }
if ($Action -eq 'down') { docker rm -f $name 2>$null | Out-Null; 'local stand-in removed'; return }

if (-not [bool](docker ps -a --filter "name=^$name$" --format '{{.Names}}')) {
    docker run -d --name $name -p "${Port}:5432" -e "POSTGRES_PASSWORD=$Password" postgres:16 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not start $name (is port $Port free?)" }
} else { docker start $name 2>$null | Out-Null }
for ($i = 0; $i -lt 60; $i++) { docker exec $name pg_isready -U postgres -h localhost 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 1 }
"local stand-in ready: postgresql://postgres@localhost:$Port/postgres  (password $Password)"
"psql for this machine: $(Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'psql-local-sim.ps1')"
