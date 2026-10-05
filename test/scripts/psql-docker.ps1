# psql for machines without one: runs psql inside the dmcr-psql container (test\scripts\envs.ps1).
# Set DMCR_PSQL to this file. Connection strings pointing at the published host ports are
# rewritten to the containers on the Docker network (localhost:25432 → dmcr-pg-test:5432,
# localhost:25433 → dmcr-pg-prod:5432), so the password is really checked over TCP.
# Files passed with -f are copied into the container first; PGPASSWORD is passed through.
$map = @{ '25432' = 'dmcr-pg-test'; '25433' = 'dmcr-pg-prod' }
if ($env:DMCR_PSQL_DOCKER_MAP) {
    $map = @{}
    foreach ($pair in $env:DMCR_PSQL_DOCKER_MAP.Split(',')) { $kv = $pair.Split('='); if ($kv.Count -eq 2) { $map[$kv[0].Trim()] = $kv[1].Trim() } }
}
$fwd = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $args.Count; $i++) {
    $a = [string]$args[$i]
    if ($a -ceq '-f' -and ($i + 1) -lt $args.Count) {
        $remote = "/tmp/dmcr_" + [guid]::NewGuid().ToString('N') + '.sql'
        docker cp ([string]$args[$i + 1]) "dmcr-psql:$remote" | Out-Null
        $fwd.Add('-f'); $fwd.Add($remote); $i++
        continue
    }
    # postgresql://user@localhost:25433/db  and  host=localhost port=25433 forms
    $m = [regex]::Match($a, '^(postgres(?:ql)?://[^@/]*@)(?:localhost|127\.0\.0\.1):(\d+)(/.*)?$')
    if ($m.Success -and $map.ContainsKey($m.Groups[2].Value)) {
        $a = "$($m.Groups[1].Value)$($map[$m.Groups[2].Value]):5432$($m.Groups[3].Value)"
    } elseif ($a -match '\bport\s*=\s*(\d+)' -and $map.ContainsKey($Matches[1])) {
        $p = $Matches[1]
        $a = ($a -replace '\bhost\s*=\s*\S+', "host=$($map[$p])") -replace '\bport\s*=\s*\d+', 'port=5432'
    }
    $fwd.Add($a)
}
if ($env:PGPASSWORD) { docker exec -i -e PGPASSWORD dmcr-psql psql @fwd } else { docker exec -i dmcr-psql psql @fwd }
exit $LASTEXITCODE
