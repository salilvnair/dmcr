# Test-only psql stand-in: logs its arguments, forwards PGPASSWORD + args to psql in the container.
$log = if ($env:DMCR_PSQL_ARGV_LOG) { $env:DMCR_PSQL_ARGV_LOG } else { Join-Path $env:TEMP 'dmcr-psql-argv.log' }
Add-Content -Path $log -Value ($args -join ' ')
$fwd = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -ceq '-f' -and ($i + 1) -lt $args.Count) {
        $remote = "/tmp/shim_" + [guid]::NewGuid().ToString('N') + ".sql"
        docker cp ([string]$args[$i + 1]) "$($env:DMCR_TEST_PG):$remote" | Out-Null
        $fwd.Add('-f'); $fwd.Add($remote); $i++
    } else { $fwd.Add($a) }
}
if ($env:PGPASSWORD) { docker exec -i -e PGPASSWORD $env:DMCR_TEST_PG psql @fwd } else { docker exec -i $env:DMCR_TEST_PG psql @fwd }
exit $LASTEXITCODE
