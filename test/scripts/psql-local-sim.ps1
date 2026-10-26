# psql stand-in for test\scripts\local-sim.ps1: runs psql inside the dmcr-local-pg container.
# localhost:5432 inside the container is the same server the host reaches on localhost:5432,
# so connection strings work unchanged. Files passed with -f are copied in first; PGPASSWORD is
# passed through. Only for trying the no-Docker scripts on a PC that has no psql.
# DMCR_PG_CONTAINER picks another container (default dmcr-local-pg), e.g. dmcr-scale-pg for the scale test.
$container = if ($env:DMCR_PG_CONTAINER) { $env:DMCR_PG_CONTAINER } else { 'dmcr-local-pg' }
$fwd = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -ceq '-f' -and ($i + 1) -lt $args.Count) {
        $remote = '/tmp/dmcr_' + [guid]::NewGuid().ToString('N') + '.sql'
        docker cp ([string]$args[$i + 1]) "${container}:$remote" | Out-Null
        $fwd.Add('-f'); $fwd.Add($remote); $i++
    } else {
        # localhost inside the container is a trusted local login (no password asked); through
        # host.docker.internal the server checks the password like any other client, as a real psql would
        $fwd.Add(($a -replace '@(localhost|127\.0\.0\.1):', '@host.docker.internal:'))
    }
}
$envArgs = @()
if ($env:PGPASSWORD) { $envArgs += @('-e', 'PGPASSWORD') }
if ($env:PGOPTIONS)  { $envArgs += @('-e', 'PGOPTIONS') }   # the environment's search_path (dmcr.ps1)
docker exec -i @envArgs $container psql @fwd
exit $LASTEXITCODE
