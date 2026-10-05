# psql stand-in for test\scripts\local-sim.ps1: runs psql inside the dmcr-local-pg container.
# localhost:5432 inside the container is the same server the host reaches on localhost:5432,
# so connection strings work unchanged. Files passed with -f are copied in first; PGPASSWORD is
# passed through. Only for trying the no-Docker scripts on a PC that has no psql.
$fwd = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -ceq '-f' -and ($i + 1) -lt $args.Count) {
        $remote = '/tmp/dmcr_' + [guid]::NewGuid().ToString('N') + '.sql'
        docker cp ([string]$args[$i + 1]) "dmcr-local-pg:$remote" | Out-Null
        $fwd.Add('-f'); $fwd.Add($remote); $i++
    } else { $fwd.Add($a) }
}
if ($env:PGPASSWORD) { docker exec -i -e PGPASSWORD dmcr-local-pg psql @fwd } else { docker exec -i dmcr-local-pg psql @fwd }
exit $LASTEXITCODE
