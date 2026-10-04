# Runs the dmcr.ps1 test suites (Windows PowerShell 5.1) against a throwaway PostgreSQL 16
# container. psql runs inside the container through psql-shim.ps1, so no local psql is needed.
# Needs Docker. Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\runner\tests\run-tests.ps1
#                      (or: npm run test:runner:ps)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'dmcr-test-pg'

docker rm -f $name 2>$null | Out-Null
docker run -d --name $name -e POSTGRES_PASSWORD=dmcrtest -e POSTGRES_DB=dmcrtest postgres:16 | Out-Null
if ($LASTEXITCODE -ne 0) { exit 1 }
try {
    for ($i = 0; $i -lt 60; $i++) {
        docker exec $name pg_isready -U postgres -d dmcrtest -h localhost 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    $failed = $false
    foreach ($suite in 'high.ps1', 'security.ps1', 'rehearsal.ps1', 'roundtrip.ps1', 'promotion.ps1') {
        ''; "######## $suite"
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here $suite)
        if ($LASTEXITCODE -ne 0) { $failed = $true }
    }
    ''
    if ($failed) { 'SOME RUNNER TESTS FAILED'; $code = 1 } else { 'ALL RUNNER SUITES PASSED'; $code = 0 }
} finally {
    docker rm -f $name 2>$null | Out-Null
}
exit $code
