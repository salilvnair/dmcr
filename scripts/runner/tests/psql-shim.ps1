# Test-only psql stand-in: forwards to psql inside the dmcr-test-pg container.
# Files passed with -f are copied into the container first.
$fwd = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -ceq '-f' -and ($i + 1) -lt $args.Count) {
        $local = [string]$args[$i + 1]
        $remote = "/tmp/shim_" + [guid]::NewGuid().ToString('N') + ".sql"
        docker cp $local "$($env:DMCR_TEST_PG):$remote" | Out-Null
        $fwd.Add('-f'); $fwd.Add($remote)
        $i++
    } else {
        $fwd.Add($a)
    }
}
$envArgs = @()
if ($env:PGOPTIONS) { $envArgs += @('-e', 'PGOPTIONS') }   # the environment's search_path (dmcr.ps1)
docker exec -i @envArgs $env:DMCR_TEST_PG psql @fwd
exit $LASTEXITCODE
