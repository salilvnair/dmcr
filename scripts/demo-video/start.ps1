# DMCR Web for the demo recording: port 7841, home and workspace under C:\dmcr-demo (setup.ps1),
# psql runs inside the dmcr-demo-pg container. The AI key comes from the daakia checkout's .env (never printed).
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo
$env:DMCR_WEB_PORT = '7841'
$env:DMCR_WEB_HOME = 'C:\dmcr-demo\home'
$env:DMCR_WEB_WORKSPACE = 'C:\dmcr-demo\shop'
$env:DMCR_PSQL = "$repo\test\scripts\psql-local-sim.ps1"
$env:DMCR_PG_CONTAINER = 'dmcr-demo-pg'
if (-not $env:DMCR_WEB_ENV_FILE) { $env:DMCR_WEB_ENV_FILE = Join-Path (Split-Path -Parent $repo) 'daakia\.env' }
node local-server/dist/server.js
