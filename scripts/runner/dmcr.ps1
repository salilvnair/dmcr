$ErrorActionPreference = "Stop"

# =========================================================
# ANSI colour support
# Set DMCR_ANSI_OUTPUT=1 (done automatically by the VS Code extension) to
# emit ANSI escape sequences instead of Write-Host -ForegroundColor calls.
# Works on PS 5.1+; on PS 7.2+ we additionally enable $PSStyle.OutputRendering
# so that ALL Write-Host colour calls in table helpers produce ANSI codes too.
# =========================================================
$script:UseAnsi = ($env:DMCR_ANSI_OUTPUT -eq '1')
$script:ESC = [char]0x1B
$script:AnsiMap = @{
    'Black'       = '30'; 'DarkBlue'    = '34'; 'DarkGreen'  = '32'
    'DarkCyan'    = '36'; 'DarkRed'     = '31'; 'DarkMagenta'= '35'
    'DarkYellow'  = '33'; 'Gray'        = '37'; 'DarkGray'   = '90'
    'Blue'        = '94'; 'Green'       = '92'; 'Cyan'       = '96'
    'Red'         = '91'; 'Magenta'     = '95'; 'Yellow'     = '93'
    'White'       = '97'
}
if ($script:UseAnsi -and $PSVersionTable.PSVersion.Major -ge 7) {
    try { $PSStyle.OutputRendering = 'Ansi' } catch { }
}

# =========================================================
# Helpers
# =========================================================
function Log-Info($msg)   { Write-Color -m1 "INFO" -m2 "    $msg" -c1 Cyan -c2 Yellow }
function Log-Init($msg)   { Write-Color -m1 "INIT" -m2 "    $msg" -c1 Yellow -c2 DarkCyan }
function Log-Apply($msg)  { Write-Color -m1 "APPLY" -m2 "    $msg" -c1 Green -c2 Yellow }
function Log-Verify($msg) { Write-Color -m1 "VERIFY" -m2 "    $msg" -c1 Magenta -c2 Yellow }
function Log-Revert($msg) { Write-Color -m1 "REVERT" -m2 "    $msg" -c1 Red -c2 Yellow }
function Log-Skip($msg)   { Write-Color -m1 "SKIP" -m2 "    $msg" -c1 Blue -c2 Yellow }
function Log-Done($msg)   { Write-Color -m1 "DONE" -m2 "    $msg" -c1 Green -c2 Green }
function Log-Warn($msg)   { Write-Color -m1 "WARN" -m2 "    $msg" -c1 Yellow -c2 DarkCyan }
function Log-Error($msg)  { Write-Color -m1 "ERROR" -m2 "   $msg" -c1 Red -c2 DarkCyan }

$script:DmcrDebug    = $false
$script:DmcrJsonMode = $false
function Log-Debug($msg) {
    if ($script:DmcrDebug) { Write-Color -m1 "DEBUG" -m2 "   $msg" -c1 DarkMagenta -c2 DarkCyan }
}

function Redact-Conn([string]$Conn) {
    if ([string]::IsNullOrWhiteSpace($Conn)) { return $Conn }

    $s = $Conn

    # key=value style: password=...; or pwd=...
    $s = [regex]::Replace($s, '(?i)\b(password|pwd)\s*=\s*([^;]+)', '$1=****')

    # URL style: postgres://user:pass@host/db
    $s = [regex]::Replace($s, '(?i)://([^:/@\s]+):([^@\s]+)@', '://$1:****@')

    # URL query style: ?password=... or &password=...
    $s = [regex]::Replace($s, '(?i)([?&]password=)([^&]+)', '$1****')

    return $s
}

function Format-Args([string[]]$Args) {
    if ($null -eq $Args -or $Args.Count -eq 0) { return "" }
    return ($Args | ForEach-Object {
        if ($_ -match '\s') { '"' + ($_ -replace '"','\"') + '"' } else { $_ }
    }) -join ' '
}

# =========================================================
# STARTUP CLEANUP — remove orphaned temp files from crashed runs
# =========================================================
# Temp files are created in %TEMP% with prefixes dmcr_tx_, dmcr_verify_, dmcr_parse_.
# Normally they are cleaned up in `finally` blocks, but a hard kill (power loss,
# kill -9, OS restart) may leave them behind. Clean up anything older than 1 hour.
$script:CleanupReport = @{ tempFiles = 0; lockFiles = 0; details = @() }

function Cleanup-OrphanedTempFiles {
    $prefixes = @('dmcr_tx_', 'dmcr_verify_', 'dmcr_parse_', 'dmcr_scalar_')
    $cutoff   = (Get-Date).AddHours(-1)
    $tmpDir   = [System.IO.Path]::GetTempPath()
    foreach ($prefix in $prefixes) {
        try {
            Get-ChildItem -Path $tmpDir -Filter "${prefix}*.sql" -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt $cutoff } |
                ForEach-Object {
                    try {
                        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
                        $script:CleanupReport.tempFiles++
                        $script:CleanupReport.details += "removed temp: $($_.Name)"
                    } catch { }
                }
        } catch { }
    }
    # Also clean stale lock files (older than 1 hour and not currently locked)
    $lockDir = Join-Path $tmpDir "dmcr_locks"
    if (Test-Path $lockDir) {
        Get-ChildItem -Path $lockDir -Filter "dmcr_*.lock" -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cutoff } |
            ForEach-Object {
                try {
                    # Try to open exclusively — if it succeeds, the lock is stale
                    $fs = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
                    $fs.Close(); $fs.Dispose()
                    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
                    $script:CleanupReport.lockFiles++
                    $script:CleanupReport.details += "removed stale lock: $($_.Name)"
                } catch { } # still locked by another process — leave it
            }
    }
}

Cleanup-OrphanedTempFiles

# =========================================================
# ENTRYPOINT (CLI-style: supports -d / --debug anywhere)
# =========================================================
function dmcr {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Args
    )

    $debug       = $false
    $dryRun      = $false
    $allowProd   = $false
    $jsonOut     = $false
    $deployTo    = $null
    $envOverride = $null
    $configPath  = $(if ($env:DMCR_CONFIG) { $env:DMCR_CONFIG } else { Join-Path $PSScriptRoot "dmcr.cfg" })
    $positional = New-Object System.Collections.Generic.List[string]

    # Also allow env var
    if ($env:DMCR_DEBUG -and $env:DMCR_DEBUG.ToString().Trim() -match '^(1|true|yes|y|on)$') {
        $debug = $true
    }

    for ($i = 0; $i -lt $Args.Count; $i++) {
        $t = $Args[$i]

        switch ($t) {
            { $_ -in @("--debug") } {
                $debug = $true
                continue
            }
            { $_ -in @("--dry-run") } {
                $dryRun = $true
                continue
            }
            { $_ -in @("--allow-prod") } {
                $allowProd = $true
                continue
            }
            { $_ -in @("--json") } {
                $jsonOut = $true
                continue
            }
            { $_ -in @("--to") } {
                $i++
                if ($i -ge $Args.Count) { throw "Missing value for --to" }
                $deployTo = $Args[$i]
                continue
            }
            { $_ -in @("--env") } {
                $i++
                if ($i -ge $Args.Count) { throw "Missing value for --env" }
                $envOverride = $Args[$i]
                continue
            }
            { $_ -in @("-h","--help","/?","help") } {
                $positional.Add("help")
                continue
            }
            { $_ -in @("-c","--config") } {
                $i++
                if ($i -ge $Args.Count) { throw "Missing value for $t" }
                $configPath = $Args[$i]
                continue
            }
            default {
                $positional.Add($t)
                continue
            }
        }
    }

    $command = if ($positional.Count -ge 1) { $positional[0] } else { "help" }
    $arg1    = if ($positional.Count -ge 2) { $positional[1] } else { $null }
    $arg2    = if ($positional.Count -ge 3) { $positional[2] } else { $null }

    $script:DmcrDebug    = [bool]$debug
    $script:DmcrJsonMode = [bool]$jsonOut

    # ---------------- HELP (NO DB) ----------------
    if ($command -in @("help","-h","--help","/?")) {
        Show-Help
        return
    }

    # [Enum]::GetValues([System.ConsoleColor]) | ForEach-Object { Write-Host $_ -ForegroundColor $_ }

    # ---------------- LOAD CONFIG ----------------
    $cfg = Get-Cfg $configPath

    if ($envOverride) {
        $ini = Read-Ini $configPath
        if (-not $ini.ContainsKey($envOverride)) {
            throw "Unknown environment '$envOverride' — no [$envOverride] section in $configPath"
        }
        $conn = $env:DMCR_CONN
        if ([string]::IsNullOrWhiteSpace($conn)) { $conn = $ini[$envOverride]["conn"] }
        if ([string]::IsNullOrWhiteSpace($conn)) {
            throw "No connection string found in [$envOverride] section or DMCR_CONN env var"
        }
        $cfg.EnvName = $envOverride
        $cfg.Conn    = $conn
        Log-Debug "--env override applied: EnvName=$envOverride"
    }

    if ($script:DmcrDebug) {
        Print-Config $cfg $configPath
        Log-Debug "Command=$command Arg1=$arg1 Arg2=$arg2"
    }

    # ---------------- SHOW CONFIG (NO DB) ----------------
    if ($command -eq "show" -and $arg1 -eq "config") {
        if ($jsonOut) {
            $phCount     = if ($cfg.Placeholders) { $cfg.Placeholders.Count } else { 0 }
            $phStr       = if ($phCount -gt 0) { "$phCount defined" } else { "none" }
            $psqlPathVal = if ([string]::IsNullOrWhiteSpace($cfg.PsqlPath)) { "auto" } else { $cfg.PsqlPath }
            (@{
                command         = "show_config"
                path            = $configPath
                env             = $cfg.EnvName
                changes_dir     = $cfg.ChangesDir
                psql_path       = $psqlPathVal
                lock_timeout    = $cfg.LockTimeout
                stmt_timeout    = $cfg.StmtTimeout
                checksum_policy = $cfg.ChecksumPolicy
                placeholders    = $phStr
                conn            = (Redact-Conn $cfg.Conn)
            } | ConvertTo-Json -Compress) | Write-Output
        } else {
            Print-Config $cfg $configPath
        }
        return
    }

    # ---------------- INIT (ONLY place schema is created) ----------------
    if ($command -eq "init") {
        Log-Init "creating DMCR registry"
        # Run DDL inside a transaction so partial failures leave nothing behind
        Exec-PsqlFileTx $cfg (Join-Path $PSScriptRoot "dmcr_change_log_ddl.sql") ""
        Log-Done "DMCR registry ready"
        if ($jsonOut) {
            (@{ command = "init"; status = "ok"; message = "DMCR registry ready" } | ConvertTo-Json -Compress) | Write-Output
        }
        return
    }

    if ($command -eq "parse") {
        try {
            # If args were passed after `parse`, treat them as SQL; otherwise read stdin.
            $sqlText = $null
            if ($positional.Count -ge 2) {
                $sqlText = ($positional[1..($positional.Count-1)] -join " ")
            } else {
                $sqlText = ($input | Out-String)
            }

            $res = Invoke-DmcrParseSql -cfg $cfg -SqlText $sqlText
            ($res | ConvertTo-Json -Compress) | Write-Output
            return
        } 
        catch {
            $msg = $_.Exception.Message

            # If this is psql's "psql:<file>:<line>: ERROR: ..." format, strip file path
            $m = [regex]::Match($msg, '(?im)^\s*psql:.*:(\d+):\s*(ERROR|FATAL):\s*(.+)\s*$')
            if ($m.Success) {
                $tmpLine = [int]$m.Groups[1].Value
                $kind    = $m.Groups[2].Value.ToUpper()
                $detail  = $m.Groups[3].Value.Trim()
                $line    = [Math]::Max(1, $tmpLine - 4)

                (@{ ok = $false; msg = "${kind}: ${detail}"; line = $line } | ConvertTo-Json -Compress) | Write-Output
                return
            }

            (@{ ok = $false; msg = $msg } | ConvertTo-Json -Compress) | Write-Output
            return
        }
    }

    # 🔒 HARD GATE — EVERYTHING ELSE REQUIRES REGISTRY
    Require-Registry $cfg

    # 📝 Flush cleanup report to event_log if anything was cleaned
    if (($script:CleanupReport.tempFiles -gt 0) -or ($script:CleanupReport.lockFiles -gt 0)) {
        $cleanMsg = "Startup cleanup: $($script:CleanupReport.tempFiles) temp file(s), $($script:CleanupReport.lockFiles) stale lock(s) removed"
        Log-Debug $cleanMsg
        try {
            $escapedMsg = $cleanMsg.Replace("'", "''")
            $actor = if ($cfg.Actor) { $cfg.Actor } else { "$env:USERNAME@$env:COMPUTERNAME" }
            $escapedActor = $actor.Replace("'", "''")
            $escapedEnv = ($cfg.Env).Replace("'", "''")
            $sql = "INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor) VALUES ('cleanup', '__system__', 'success', '$escapedMsg', '$escapedEnv', '$escapedActor');"
            Exec-Psql $cfg $sql | Out-Null
        } catch {
            Log-Debug "Could not log cleanup to event_log: $($_.Exception.Message)"
        }
        # Reset so it doesn't log again on subsequent calls in same session
        $script:CleanupReport = @{ tempFiles = 0; lockFiles = 0; details = @() }
    }

    switch ($command) {
        "status" {
            $folders = @(Get-ChangeFolders $cfg.ChangesDir)
            Log-Debug "Found $($folders.Count) change folder(s) under $($cfg.ChangesDir)"

            if ($jsonOut) {
                $result = @()
                foreach ($f in $folders) {
                    $id = $f.Name
                    $isApplied = Is-Applied $cfg $id
                    $meta = Read-MetaJson $f.FullName
                    $entry = @{ change_id = $id; status = $(if ($isApplied) { "applied" } else { "pending" }) }
                    if ($meta) {
                        if ($meta.tags) { $entry.tags = @($meta.tags) }
                        if ($meta.ticket) { $entry.ticket = $meta.ticket }
                    }
                    $result += $entry
                }
                (ConvertTo-Json -InputObject @($result) -Depth 5) | Write-Output  # array even for 0 or 1 items
                return
            }

            $columns = @(
                @{ Name = "Status"; hasEmoji = $true  },
                @{ Name = "Change"; hasEmoji = $false }
            )

            $statusData = @()

            foreach ($f in $folders) {
                $id = $f.Name
                $isApplied = Is-Applied $cfg $id
                $mark = if ($isApplied) { "APPLIED ✅ " } else { "PENDING ⏹ " }
                $statusData += @{
                    Status        = $mark
                    Status_Color  = $(if ($isApplied) { "Green" } else { "DarkYellow" })
                    Change        = $id
                    Change_Color  = "Gray"
                }
                Log-Debug "Status for $($id): $mark"
                Log-Debug "Data row added: $($statusData[-1] | Out-String)"
            }

            Log-Debug "Rendering status table with $($statusData.Count) row(s)"

            BoxedColorTableWithTitle -Title "Change Status" -columns $columns -data $statusData
        }

        "test" {
            if ($cfg.EnvName -match '(?i)prod' -and -not $allowProd) {
                throw "Refusing to run 'test' against environment '$($cfg.EnvName)': it holds locks on the tables it changes until it rolls back. Run it against staging or a copy of production, or add --allow-prod."
            }
            $testTo = $null
            if ($deployTo) {
                $testTo = if ($deployTo.StartsWith('@')) { Get-TagChangeId $cfg $deployTo.Substring(1) } else { $deployTo }
            }
            if (-not $jsonOut) { Log-Info "Round-trip test of pending changes on '$($cfg.EnvName)' (rolled back at the end)" }
            if (-not (Invoke-RoundTripTest $cfg $testTo ([bool]$jsonOut))) { exit 1 }
        }

        "deploy" {
            Log-Info "Starting DMCR deploy$(if ($dryRun) { ' (DRY RUN — no changes will be made)' })"
            Log-Info "Environment: $($cfg.EnvName)"
            Log-Info "Changes directory: $($cfg.ChangesDir)"

            # Resolve --to target (supports @tag syntax)
            $stopAtId = $null
            if ($deployTo) {
                if ($deployTo.StartsWith("@")) {
                    $tagName = $deployTo.Substring(1)
                    $resolved = Get-TagChangeId $cfg $tagName
                    if (-not $resolved) { throw "Tag '@$tagName' not found. Use 'dmcr tag list' to see available tags." }
                    Log-Info "Deploy target: @$tagName → $resolved"
                    $stopAtId = $resolved
                } else {
                    $stopAtId = $deployTo
                    Log-Info "Deploy target: $stopAtId"
                }
            }

            $folders = @(Get-ChangeFolders $cfg.ChangesDir)
            Log-Debug "Found $($folders.Count) change folder(s) under $($cfg.ChangesDir)"

            if ($dryRun) {
                # ── DRY-RUN: show what would be applied; read and print each deploy.sql ──
                $pending = @($folders | Where-Object {
                    $f = $_; $f.Name -notmatch '(?i)(^|_)danger_' -and -not (Is-Applied $cfg $f.Name)
                })

                if ($pending.Count -eq 0) {
                    if ($jsonOut) {
                        (@{ status = "ok"; message = "Nothing to deploy"; changes = @() } | ConvertTo-Json -Depth 5) | Write-Output
                    } else {
                        Log-Info "Dry-run complete — nothing to deploy (all changes already applied)"
                    }
                    return
                }

                if ($jsonOut) {
                    $dryResult = @($pending | ForEach-Object { @{ change_id = $_.Name } })
                    (@{ status = "dry_run"; count = $pending.Count; changes = $dryResult } | ConvertTo-Json -Depth 5) | Write-Output
                    return
                }

                Log-Warn "DRY RUN — the following $($pending.Count) change(s) would be deployed:"
                foreach ($f in $pending) {
                    $id = $f.Name
                    $deploySql = Join-Path $f.FullName 'deploy.sql'
                    Log-Info "--- $id ---"
                    if (Test-Path $deploySql) {
                        Get-Content $deploySql -Raw -Encoding UTF8 | Write-Host -ForegroundColor DarkCyan
                    } else {
                        Log-Warn "  deploy.sql not found"
                    }
                }
                Log-Warn "DRY RUN complete — re-run without --dry-run to apply"
                return
            }

            if ($stopAtId -and -not ($folders | Where-Object { $_.Name -eq $stopAtId })) {
                throw "--to target '$stopAtId' does not match any change folder in $($cfg.ChangesDir)"
            }

            # Enhanced preflight
            $preflightIssues = Invoke-EnhancedPreflight $cfg $folders
            if ($preflightIssues.Count -gt 0) {
                $list = ($preflightIssues | ForEach-Object { "  >> $_" }) -join "`n"
                throw "Pre-flight failed:`n$list`n`nFix these issues before deploying."
            }
            # Dependency cycles in meta.json `requires` block the deploy
            Build-DependencyPlan $cfg | Out-Null
            Log-Info "Pre-flight OK — all change folders validated"

            # Advisory lock
            Acquire-AdvisoryLock $cfg
            $deployResults = @()

            try {
                # Applied changes must still match what was deployed (checksum_policy)
                $drifted = @(Get-DriftedChanges $cfg)
                if ($drifted.Count -gt 0) {
                    switch ($cfg.ChecksumPolicy) {
                        'warn' {
                            Log-Warn "Applied change files edited since they were deployed: $($drifted -join ', ') (checksum_policy=warn — continuing)"
                        }
                        'repair' {
                            foreach ($g in ($drifted | Group-Object { $_.Split('/')[0] })) {
                                Accept-ChangeChecksums $cfg $g.Name ((@($g.Group) | ForEach-Object { $_.Split('/')[1] }) -join ',')
                            }
                            Log-Warn "Accepted edited applied change files: $($drifted -join ', ') (checksum_policy=repair — recorded in dmcr.event_log)"
                        }
                        default {
                            throw "BLOCKED: applied change files edited since they were deployed: $($drifted -join ', '). Restore them, or accept the edit with: dmcr repair --checksums (checksum_policy=$($cfg.ChecksumPolicy))"
                        }
                    }
                }

                foreach ($f in $folders) {
                    $id = $f.Name
                    Log-Info "Evaluating change: $id"

                    if (Is-Applied $cfg $id) {
                        Log-Skip "$id already applied"
                        # Check --to target: if already applied and is our target, stop here
                        if ($stopAtId -and $id -eq $stopAtId) {
                            Log-Info "Reached --to target '$stopAtId' (already applied) — stopping"
                            break
                        }
                        continue
                    }

                    # --- danger_ folders: git-tracked but NEVER auto-deployed ---
                    if ($id -match '(?i)(^|_)danger_') {
                        Log-Skip "$id — manual-only (danger_ folder, DBA must run deploy.sql directly)"
                        if ($stopAtId -and $id -eq $stopAtId) {
                            Log-Info "Reached --to target '$stopAtId' — stopping deploy"
                            break
                        }
                        continue
                    }

                    $deploySw = [System.Diagnostics.Stopwatch]::StartNew()
                    try {
                        Log-Apply "$id (before deploy)"
                        Log-Debug "Deploy folder: $($f.FullName)"

                        # --- DANGER GATE: block dangerous SQL in normal folders ---
                        Assert-SafeChange -FolderId $id -FolderPath $f.FullName -Mode 'deploy'

                        # --- READ METADATA ---
                        $meta = Read-MetaJson $f.FullName

                        # --- DEPENDENCIES: every meta.json `requires` must already be applied ---
                        if ($meta -and $meta.requires) {
                            foreach ($req in @($meta.requires)) {
                                if (-not (Is-Applied $cfg $req)) {
                                    throw "'$id' requires '$req', which is not applied. Deploy '$req' first (folders deploy in number order), or fix meta.json."
                                }
                            }
                        }

                        # --- TRANSACTION GUARD: no COMMIT/BEGIN/\c inside change files ---
                        foreach ($fileName in @('deploy.sql', 'verify.sql')) {
                            Assert-NoTxControl $id (Join-Path $f.FullName $fileName)
                        }
                        $ticketId    = if ($meta -and $meta.ticket) { $meta.ticket } else { $null }
                        $gitCommit   = Get-GitCommit $cfg.ChangesDir
                        $actor       = Get-DmcrActor
                        $appName     = if ($meta -and $meta.PSObject.Properties['app_name']) { $meta.app_name } else { $null }

                        # --- TRANSACTIONAL: deploy.sql + record in ONE psql call ---
                        $safeId = Escape-SqlLiteral $id
                        $deployFile = Join-Path $f.FullName "deploy.sql"
                        $verifyFile = Join-Path $f.FullName "verify.sql"
                        $revertFile = Join-Path $f.FullName "revert.sql"
                        $deployChecksum = Get-FileChecksum $deployFile
                        $verifyChecksum = if (Test-Path $verifyFile) { Get-FileChecksum $verifyFile } else { $null }
                        $revertChecksum = if (Test-Path $revertFile) { Get-FileChecksum $revertFile } else { $null }

                        # Build enriched INSERT
                        $cols = "change_id, deploy_checksum, verify_checksum, revert_checksum, environment, actor"
                        $vals = ":'dmcr_id', :'dmcr_dchk', :'dmcr_vchk', :'dmcr_rchk', :'dmcr_env', :'dmcr_actor'"
                        $bindVars = @{
                            dmcr_id    = $id
                            dmcr_dchk  = $deployChecksum
                            dmcr_vchk  = $(if ($verifyChecksum) { $verifyChecksum } else { "" })
                            dmcr_rchk  = $(if ($revertChecksum) { $revertChecksum } else { "" })
                            dmcr_env   = $cfg.EnvName
                            dmcr_actor = $actor
                        }
                        if ($ticketId) {
                            $cols += ", ticket_id"; $vals += ", :'dmcr_ticket'"
                            $bindVars["dmcr_ticket"] = $ticketId
                        }
                        if ($gitCommit) {
                            $cols += ", git_commit"; $vals += ", :'dmcr_git'"
                            $bindVars["dmcr_git"] = $gitCommit
                        }
                        if ($appName) {
                            $cols += ", app_name"; $vals += ", :'dmcr_app'"
                            $bindVars["dmcr_app"] = $appName
                        }

                        # Use the old direct-interpolation approach for the file TX (can't use bind vars in Exec-PsqlFileTx easily)
                        $safeDeployChk = Escape-SqlLiteral $deployChecksum
                        $safeVerifyChk = Escape-SqlLiteral $(if ($verifyChecksum) { $verifyChecksum } else { "" })
                        $safeRevertChk = Escape-SqlLiteral $(if ($revertChecksum) { $revertChecksum } else { "" })
                        $safeEnv       = Escape-SqlLiteral $cfg.EnvName
                        $safeActor     = Escape-SqlLiteral $actor
                        $safeTicket    = if ($ticketId) { Escape-SqlLiteral $ticketId } else { $null }
                        $safeGit       = if ($gitCommit) { Escape-SqlLiteral $gitCommit } else { $null }
                        $safeApp       = if ($appName) { Escape-SqlLiteral $appName } else { $null }

                        $insertCols = "change_id, deploy_checksum, verify_checksum, revert_checksum, environment, actor"
                        $insertVals = "'$safeId', '$safeDeployChk', '$safeVerifyChk', '$safeRevertChk', '$safeEnv', '$safeActor'"
                        if ($ticketId)  { $insertCols += ", ticket_id";  $insertVals += ", '$safeTicket'" }
                        if ($gitCommit) { $insertCols += ", git_commit"; $insertVals += ", '$safeGit'" }
                        if ($appName)   { $insertCols += ", app_name";   $insertVals += ", '$safeApp'" }

                        $recordSql = "INSERT INTO dmcr.change_log($insertCols) VALUES ($insertVals);"

                        if (Test-NoTxChange $meta) {
                            # meta.json "transaction": false — deploy.sql runs statement by statement
                            # (e.g. CREATE INDEX CONCURRENTLY), then registry row + verify in a transaction.
                            # If anything fails, revert.sql (re-runnable by rule) puts the database back.
                            Assert-RerunnableNoTx $id $f.FullName
                            Log-Warn "$id runs OUTSIDE a transaction (meta.json `"transaction`": false)"
                            $failure = $null
                            try { Exec-PsqlFileNoTx $cfg $deployFile } catch { $failure = "deploy.sql failed outside a transaction: $($_.Exception.Message)" }
                            if (-not $failure) {
                                Log-Verify "$id (with the registry update)"
                                try { Exec-PsqlSqlTx $cfg ($recordSql + (Get-TxVerifySql $cfg $verifyFile)) } catch { $failure = "verify.sql failed: $($_.Exception.Message)" }
                            }
                            if ($failure) {
                                $cleanup = 'cleaned up with revert.sql'
                                try { Exec-PsqlFileNoTx $cfg $revertFile } catch { $cleanup = "CLEANUP FAILED — revert.sql also failed; inspect the database ($($_.Exception.Message))" }
                                throw "$failure; $cleanup. Nothing was recorded."
                            }
                        } else {
                        # deploy.sql + registry row + verify.sql commit together, or not at all.
                        Log-Info "Executing deploy.sql + recording change (single transaction)"
                        Log-Verify "$id (inside the deploy transaction)"
                        try {
                            Exec-PsqlFileTx $cfg $deployFile ($recordSql + (Get-TxVerifySql $cfg $verifyFile))
                        }
                        catch {
                            throw "deploy.sql or verify.sql failed — the whole change was rolled back, nothing was applied. $($_.Exception.Message)"
                        }
                        }

                        $deploySw.Stop()

                        # --- EVENT LOG (enriched) ---
                        Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, environment, actor, duration_ms)
VALUES ('deploy', :'dmcr_id', 'success', :'dmcr_env', :'dmcr_actor', :dmcr_ms);
"@ -Vars @{ dmcr_id = $id; dmcr_env = $cfg.EnvName; dmcr_actor = $actor; dmcr_ms = "$($deploySw.ElapsedMilliseconds)" } | Out-Null

                        $deployResults += @{ change_id = $id; status = "success"; duration_ms = $deploySw.ElapsedMilliseconds }
                        Log-Done "$id applied successfully ($($deploySw.ElapsedMilliseconds)ms)"

                        # Stop if we reached the --to target
                        if ($stopAtId -and $id -eq $stopAtId) {
                            Log-Info "Reached --to target '$stopAtId' — stopping deploy"
                            break
                        }
                    }
                    catch {
                        $deploySw.Stop()
                        Log-Error "Failed to apply ${id}: $($_.Exception.Message)"

                        try {
                            Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor, duration_ms)
VALUES ('deploy', :'dmcr_id', 'failure', :'dmcr_msg', :'dmcr_env', :'dmcr_actor', :dmcr_ms);
"@ -Vars @{ dmcr_id = $id; dmcr_msg = $_.Exception.Message; dmcr_env = $cfg.EnvName; dmcr_actor = $actor; dmcr_ms = "$($deploySw.ElapsedMilliseconds)" } | Out-Null
                        } catch {
                            Log-Warn "Could not log deploy failure event: $($_.Exception.Message)"
                        }

                        $deployResults += @{ change_id = $id; status = "failure"; error = $_.Exception.Message }
                        throw
                    }
                }
            }
            finally {
                Release-AdvisoryLock $cfg
            }

            # After versioned changes, run any repeatable migrations that changed
            $rFolders = @(Get-RepeatableFolders $cfg.ChangesDir)
            $repeatableResults = @()
            if ($rFolders.Count -gt 0 -and -not $dryRun) {
                Log-Info "Checking repeatable migrations..."
                Acquire-AdvisoryLock $cfg
                try {
                    foreach ($rf in $rFolders) {
                        $rid = $rf.Name
                        $rDeployFile = Join-Path $rf.FullName "deploy.sql"
                        if (-not (Test-Path $rDeployFile)) { continue }
                        if (-not (Test-RepeatableNeedsRun $cfg $rf.FullName)) {
                            Log-Skip "$rid — unchanged"
                            continue
                        }
                        $rsw = [System.Diagnostics.Stopwatch]::StartNew()
                        $rActor = Get-DmcrActor
                        $rChecksum = Get-FileChecksum $rDeployFile
                        try {
                            Assert-SafeChange -FolderId $rid -FolderPath $rf.FullName -Mode 'deploy'
                            $rVerifyFile = Join-Path $rf.FullName "verify.sql"
                            Assert-NoTxControl $rid $rDeployFile
                            Assert-NoTxControl $rid $rVerifyFile
                            $safeRid = Escape-SqlLiteral $rid
                            $safeRChk = Escape-SqlLiteral $rChecksum
                            $safeREnv = Escape-SqlLiteral $cfg.EnvName
                            $safeRActor = Escape-SqlLiteral $rActor
                            # deploy.sql + checksum record + verify.sql commit together
                            $rUpsert = @"
INSERT INTO dmcr.repeatable_log(change_id, last_checksum, applied_at, environment, actor)
VALUES ('$safeRid', '$safeRChk', now(), '$safeREnv', '$safeRActor')
ON CONFLICT (change_id) DO UPDATE SET last_checksum = EXCLUDED.last_checksum, applied_at = EXCLUDED.applied_at, environment = EXCLUDED.environment, actor = EXCLUDED.actor;
"@
                            Exec-PsqlFileTx $cfg $rDeployFile ($rUpsert + (Get-TxVerifySql $cfg $rVerifyFile))
                            $rsw.Stop()
                            $repeatableResults += @{ change_id = $rid; status = "applied"; duration_ms = $rsw.ElapsedMilliseconds }
                            Log-Done "$rid applied ($($rsw.ElapsedMilliseconds)ms)"
                        } catch {
                            $rsw.Stop()
                            Log-Error "Repeatable $rid failed: $($_.Exception.Message)"
                            $repeatableResults += @{ change_id = $rid; status = "failed"; error = $_.Exception.Message }
                        }
                    }
                } finally {
                    Release-AdvisoryLock $cfg
                }
            }

            if ($jsonOut -and ($deployResults.Count -gt 0 -or $repeatableResults.Count -gt 0)) {
                $output = @{ status = "ok"; changes = $deployResults }
                if ($repeatableResults.Count -gt 0) { $output.repeatable = $repeatableResults }
                ($output | ConvertTo-Json -Depth 5) | Write-Output
            }
        }

        "verify" {
            if ($arg1 -eq "all") {
                # Verify ALL applied changes in order
                $folders = @(Get-ChangeFolders $cfg.ChangesDir)
                $applied = @($folders | Where-Object { Is-Applied $cfg $_.Name })
                if ($applied.Count -eq 0) {
                    Log-Info "No applied changes to verify"
                    return
                }
                $results = @()
                foreach ($f in $applied) {
                    $id = $f.Name
                    Log-Verify "$id"
                    try {
                        Verify-Change $cfg $id "verify all"
                        Log-Done "$id verified OK"
                        $results += @{ change_id = $id; status = "ok" }
                    } catch {
                        Log-Error "$id verify FAILED: $($_.Exception.Message)"
                        $results += @{ change_id = $id; status = "failed"; error = $_.Exception.Message }
                    }
                }
                if ($jsonOut) {
                    (ConvertTo-Json -InputObject @($results) -Depth 5) | Write-Output  # array even for 0 or 1 items
                }
                return
            }

            if (-not [string]::IsNullOrWhiteSpace($arg1)) {
                # Verify specific change_id
                if (-not (Is-Applied $cfg $arg1)) {
                    throw "Change '$arg1' is not applied"
                }
                Log-Verify "$arg1"
                Verify-Change $cfg $arg1 "specific"
                Log-Done "$arg1 verified OK"
                if ($jsonOut) { (@{ change_id = $arg1; status = "ok" } | ConvertTo-Json -Compress) | Write-Output }
                return
            }

            # Default: verify last applied
            $last = Last-Applied $cfg
            if ([string]::IsNullOrWhiteSpace($last)) {
                Log-Info "no applied changes"
                return
            }
            Verify-Change $cfg $last "last applied"
            Log-Done "$last verified OK"
            if ($jsonOut) { (@{ change_id = $last; status = "ok" } | ConvertTo-Json -Compress) | Write-Output }
        }

        "history" {
            $sql = @"
SELECT change_id, applied_at, applied_by, deploy_checksum,
       ticket_id, git_commit, environment, actor
FROM dmcr.change_log
ORDER BY applied_at DESC, change_id DESC;
"@
            if ($jsonOut) {
                $rawOut = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args @("-q","-v","ON_ERROR_STOP=1","-X","-t","-A","-F","|","-c","SET lock_timeout = '$($cfg.LockTimeout)'; $sql") -PsqlPath $cfg.PsqlPath 2>&1)
                $text = ($rawOut | Out-String).Trim()
                $result = @()
                foreach ($line in ($text -split "`r?`n")) {
                    $line = $line.Trim()
                    if (-not $line -or $line -eq "SET") { continue }
                    $parts = $line -split '\|', -1
                    if ($parts.Count -ge 4) {
                        $entry = @{
                            change_id       = $parts[0].Trim()
                            applied_at      = $parts[1].Trim()
                            applied_by      = $parts[2].Trim()
                            deploy_checksum = $parts[3].Trim()
                        }
                        if ($parts.Count -ge 5) { $entry.ticket_id   = $parts[4].Trim() }
                        if ($parts.Count -ge 6) { $entry.git_commit  = $parts[5].Trim() }
                        if ($parts.Count -ge 7) { $entry.environment = $parts[6].Trim() }
                        if ($parts.Count -ge 8) { $entry.actor       = $parts[7].Trim() }
                        $result += $entry
                    }
                }
                (ConvertTo-Json -InputObject @($result) -Depth 5) | Write-Output  # array even for 0 or 1 items
                return
            }
            Log-Info "Change history (most recent first):"
            Exec-Psql $cfg $sql
        }

        "info" {
            $folders = @(Get-ChangeFolders $cfg.ChangesDir)
            $appliedCount = 0; $pendingCount = 0; $dangerCount = 0
            foreach ($f in $folders) {
                if ($f.Name -match '(?i)(^|_)danger_') { $dangerCount++ }
                elseif (Is-Applied $cfg $f.Name) { $appliedCount++ }
                else { $pendingCount++ }
            }

            # Registry health check
            $registryOk = $true
            try { Require-Registry $cfg } catch { $registryOk = $false }

            if ($jsonOut) {
                $infoResult = @{
                    environment    = $cfg.EnvName
                    total_changes  = $folders.Count
                    applied        = $appliedCount
                    pending        = $pendingCount
                    danger         = $dangerCount
                    registry_ok    = $registryOk
                    checksum_policy = $cfg.ChecksumPolicy
                }
                ($infoResult | ConvertTo-Json -Depth 5) | Write-Output
                return
            }

            $columns = @(
                @{ Name = "Property"; hasEmoji = $false },
                @{ Name = "Value";    hasEmoji = $false }
            )
            $data = @(
                @{ Property = "Environment";     Property_Color = "DarkCyan"; Value = $cfg.EnvName;             Value_Color = "Gray" }
                @{ Property = "Total Changes";   Property_Color = "DarkCyan"; Value = "$($folders.Count)";       Value_Color = "Gray" }
                @{ Property = "Applied";         Property_Color = "DarkCyan"; Value = "$appliedCount";           Value_Color = "Green" }
                @{ Property = "Pending";         Property_Color = "DarkCyan"; Value = "$pendingCount";           Value_Color = $(if ($pendingCount -gt 0) { "DarkYellow" } else { "Gray" }) }
                @{ Property = "Danger (manual)"; Property_Color = "DarkCyan"; Value = "$dangerCount";            Value_Color = $(if ($dangerCount -gt 0) { "Red" } else { "Gray" }) }
                @{ Property = "Registry";        Property_Color = "DarkCyan"; Value = $(if ($registryOk) { "OK ✅" } else { "NOT FOUND ❌" }); Value_Color = $(if ($registryOk) { "Green" } else { "Red" }) }
                @{ Property = "Checksum Policy"; Property_Color = "DarkCyan"; Value = $cfg.ChecksumPolicy;       Value_Color = "Gray" }
            )
            BoxedColorTableWithTitle -Title "DMCR Info" -columns $columns -data $data
        }

        "plan" {
            $plan = Build-DependencyPlan $cfg
            $folders = @(Get-ChangeFolders $cfg.ChangesDir)

            if ($jsonOut) {
                $result = @()
                foreach ($id in $plan.Order) {
                    $isApplied = Is-Applied $cfg $id
                    $entry = @{
                        change_id  = $id
                        status     = $(if ($isApplied) { "applied" } else { "pending" })
                        requires   = @($plan.Graph[$id].Requires)
                    }
                    $meta = $plan.Graph[$id].Meta
                    if ($meta -and $meta.tags)   { $entry.tags   = @($meta.tags) }
                    if ($meta -and $meta.ticket) { $entry.ticket = $meta.ticket }
                    $result += $entry
                }
                (ConvertTo-Json -InputObject @($result) -Depth 5) | Write-Output  # array even for 0 or 1 items
                return
            }

            Log-Info "Dependency-aware execution plan:"
            $columns = @(
                @{ Name = "Order"; hasEmoji = $false },
                @{ Name = "Change"; hasEmoji = $false },
                @{ Name = "Status"; hasEmoji = $true },
                @{ Name = "Requires"; hasEmoji = $false }
            )
            $data = @()
            $i = 1
            foreach ($id in $plan.Order) {
                $isApplied = Is-Applied $cfg $id
                $reqs = if ($plan.Graph[$id].Requires.Count -gt 0) { $plan.Graph[$id].Requires -join ", " } else { "—" }
                $data += @{
                    Order          = "$i"
                    Order_Color    = "DarkGray"
                    Change         = $id
                    Change_Color   = "Gray"
                    Status         = $(if ($isApplied) { "APPLIED ✅" } else { "PENDING ⏹" })
                    Status_Color   = $(if ($isApplied) { "Green" } else { "DarkYellow" })
                    Requires       = $reqs
                    Requires_Color = "DarkCyan"
                }
                $i++
            }
            BoxedColorTableWithTitle -Title "Execution Plan" -columns $columns -data $data
        }

        "check" {
            $folders = @(Get-ChangeFolders $cfg.ChangesDir)
            $issues = @(Invoke-EnhancedPreflight $cfg $folders)
            foreach ($drift in @(Get-DriftedChanges $cfg)) {
                $issues += "CHECKSUM  $($drift.Split('/')[0]) — $($drift.Split('/')[1]) was edited after it was applied (restore it, or accept with: dmcr repair --checksums)"
            }

            if ($jsonOut) {
                (@{ ok = ($issues.Count -eq 0); issues = @($issues) } | ConvertTo-Json -Depth 5) | Write-Output
                return
            }

            if ($issues.Count -eq 0) {
                Log-Done "All preflight checks passed"
            } else {
                Log-Warn "Preflight issues found:"
                foreach ($issue in $issues) {
                    Log-Warn "  >> $issue"
                }
            }

            # Also validate dependency graph
            try {
                $plan = Build-DependencyPlan $cfg
                Log-Done "Dependency graph OK ($($plan.Order.Count) changes in order)"
            } catch {
                Log-Error "Dependency graph problem: $($_.Exception.Message)"
            }
        }

        "baseline" {
            if ([string]::IsNullOrWhiteSpace($arg1)) {
                throw "Usage: dmcr baseline <change_id>`n  Marks the given change (and all earlier changes) as already applied without executing SQL."
            }

            $folders = @(Get-ChangeFolders $cfg.ChangesDir)
            $target = $arg1
            $found = $false
            $baselined = @()

            foreach ($f in $folders) {
                $id = $f.Name
                if (Is-Applied $cfg $id) {
                    Log-Skip "$id already applied"
                } else {
                    # Mark as applied without running deploy.sql
                    $safeId = Escape-SqlLiteral $id
                    $deployFile = Join-Path $f.FullName "deploy.sql"
                    $checksum = if (Test-Path $deployFile) { Get-FileChecksum $deployFile } else { "" }
                    $safeChecksum = Escape-SqlLiteral $checksum
                    $safeEnv = Escape-SqlLiteral $cfg.EnvName
                    $safeActor = Escape-SqlLiteral (Get-DmcrActor)

                    Exec-PsqlScalar $cfg @"
INSERT INTO dmcr.change_log(change_id, deploy_checksum, environment, actor)
VALUES ('$safeId', '$safeChecksum', '$safeEnv', '$safeActor')
ON CONFLICT (change_id) DO NOTHING;
"@ | Out-Null

                    Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('baseline', :'dmcr_id', 'success', 'Baselined without execution', :'dmcr_env', :'dmcr_actor');
"@ -Vars @{ dmcr_id = $id; dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor) } | Out-Null

                    Log-Done "$id baselined"
                    $baselined += $id
                }

                if ($id -eq $target) { $found = $true; break }
            }

            if (-not $found) {
                throw "Target change '$target' not found in change folders"
            }

            if ($jsonOut) {
                (@{ status = "ok"; baselined = @($baselined) } | ConvertTo-Json -Depth 5) | Write-Output
            } else {
                Log-Done "Baseline complete — $($baselined.Count) change(s) marked as applied"
            }
        }

        "repair" {
            if ([string]::IsNullOrWhiteSpace($arg1)) {
                throw @"
Usage: dmcr repair <action> [change_id]

Actions:
  --mark-applied <change_id>   Mark a change as applied without executing it
  --mark-reverted <change_id>  Remove a change from the registry without executing revert
  --checksums                  Reconcile stored checksums with current files
"@
            }

            switch ($arg1) {
                "--unlock" {
                    Ensure-DeployLockTable $cfg
                    $existing = Exec-PsqlScalar $cfg @"
SELECT coalesce((SELECT holder || ' since ' || acquired_at::text FROM dmcr.deploy_lock WHERE lock_id = 1), '');
"@
                    Exec-PsqlScalar $cfg "DELETE FROM dmcr.deploy_lock WHERE lock_id = 1;" | Out-Null
                    if ($existing) {
                        Log-Done "Cleared DMCR database lock held by $existing"
                        try {
                            Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('repair', '*', 'success', :'dmcr_msg', :'dmcr_env', :'dmcr_actor');
"@ -Vars @{ dmcr_msg = "Lock cleared (was: $existing)"; dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor) } | Out-Null
                        } catch { Log-Debug "Could not log unlock event: $_" }
                    } else {
                        Log-Info "No DMCR database lock was held"
                    }
                    if ($jsonOut) {
                        Write-Output (@{ action = "unlock"; status = "ok"; cleared = [bool]$existing; previous_holder = $existing } | ConvertTo-Json -Compress)
                    }
                }
                "--mark-applied" {
                    if ([string]::IsNullOrWhiteSpace($arg2)) { throw "Usage: dmcr repair --mark-applied <change_id>" }
                    $id = $arg2
                    if (Is-Applied $cfg $id) { throw "'$id' is already marked as applied" }
                    $folderPath = Join-Path $cfg.ChangesDir $id
                    $deployFile = Join-Path $folderPath "deploy.sql"
                    $checksum = if (Test-Path $deployFile) { Get-FileChecksum $deployFile } else { "" }
                    $safeId = Escape-SqlLiteral $id
                    $safeChecksum = Escape-SqlLiteral $checksum
                    $safeEnv = Escape-SqlLiteral $cfg.EnvName
                    $safeActor = Escape-SqlLiteral (Get-DmcrActor)

                    Exec-PsqlScalar $cfg "INSERT INTO dmcr.change_log(change_id, deploy_checksum, environment, actor) VALUES ('$safeId', '$safeChecksum', '$safeEnv', '$safeActor');" | Out-Null
                    Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('repair', :'dmcr_id', 'success', 'Manually marked as applied', :'dmcr_env', :'dmcr_actor');
"@ -Vars @{ dmcr_id = $id; dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor) } | Out-Null
                    Log-Done "'$id' marked as applied"
                    if ($jsonOut) { (@{ change_id = $id; action = "mark-applied"; status = "ok" } | ConvertTo-Json -Compress) | Write-Output }
                }

                "--mark-reverted" {
                    if ([string]::IsNullOrWhiteSpace($arg2)) { throw "Usage: dmcr repair --mark-reverted <change_id>" }
                    $id = $arg2
                    if (-not (Is-Applied $cfg $id)) { throw "'$id' is not currently applied" }
                    $safeId = Escape-SqlLiteral $id
                    Exec-PsqlScalar $cfg "DELETE FROM dmcr.change_log WHERE change_id = '$safeId';" | Out-Null
                    Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('repair', :'dmcr_id', 'success', 'Manually marked as reverted', :'dmcr_env', :'dmcr_actor');
"@ -Vars @{ dmcr_id = $id; dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor) } | Out-Null
                    Log-Done "'$id' marked as reverted"
                    if ($jsonOut) { (@{ change_id = $id; action = "mark-reverted"; status = "ok" } | ConvertTo-Json -Compress) | Write-Output }
                }

                "--checksums" {
                    Log-Info "Reconciling checksums for all applied changes..."
                    $folders = @(Get-ChangeFolders $cfg.ChangesDir)
                    $repaired = @()
                    foreach ($f in $folders) {
                        $id = $f.Name
                        if (-not (Is-Applied $cfg $id)) { continue }

                        $deployFile = Join-Path $f.FullName "deploy.sql"
                        $verifyFile = Join-Path $f.FullName "verify.sql"
                        $revertFile = Join-Path $f.FullName "revert.sql"

                        $dChk = if (Test-Path $deployFile) { Get-FileChecksum $deployFile } else { "" }
                        $vChk = if (Test-Path $verifyFile) { Get-FileChecksum $verifyFile } else { "" }
                        $rChk = if (Test-Path $revertFile) { Get-FileChecksum $revertFile } else { "" }

                        $safeId = Escape-SqlLiteral $id
                        $safeDChk = Escape-SqlLiteral $dChk
                        $safeVChk = Escape-SqlLiteral $vChk
                        $safeRChk = Escape-SqlLiteral $rChk

                        Exec-PsqlScalar $cfg @"
UPDATE dmcr.change_log
SET deploy_checksum = '$safeDChk',
    verify_checksum = '$safeVChk',
    revert_checksum = '$safeRChk'
WHERE change_id = '$safeId';
"@ | Out-Null
                        $repaired += $id
                        Log-Done "$id checksums updated"
                    }
                    if ($jsonOut) {
                        (@{ action = "checksums"; repaired = @($repaired) } | ConvertTo-Json -Depth 5) | Write-Output
                    } else {
                        Log-Done "$($repaired.Count) change(s) checksums reconciled"
                    }
                }

                default {
                    throw "Unknown repair action: $arg1. Use --mark-applied, --mark-reverted, --checksums, or --unlock."
                }
            }
        }

        "revertLast" {
            $last = Last-Applied $cfg
            Log-Info "Resolving latest applied change: $last"

            if ([string]::IsNullOrWhiteSpace($last)) {
                Log-Info "nothing to revert"
                if ($jsonOut) {
                    (@{ status = "nothing_to_revert"; change_id = $null } | ConvertTo-Json -Compress) | Write-Output
                }
                return
            }
            Acquire-AdvisoryLock $cfg
            try { Revert-Change $cfg $last }
            finally { Release-AdvisoryLock $cfg }
            if ($jsonOut) {
                (@{ status = "ok"; change_id = $last; action = "revert" } | ConvertTo-Json -Compress) | Write-Output
            }
        }

        "revert" {
            if ($arg1 -eq "list") {
                Log-Info "Listing applied changes"
                if ($jsonOut) {
                    $sql = "SELECT change_id, applied_at FROM dmcr.change_log ORDER BY applied_at DESC, change_id DESC;"
                    $rawOut = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args @("-q","-v","ON_ERROR_STOP=1","-X","-t","-A","-F","|","-c","SET lock_timeout = '$($cfg.LockTimeout)'; $sql") -PsqlPath $cfg.PsqlPath 2>&1)
                    $text = ($rawOut | Out-String).Trim()
                    $result = @()
                    foreach ($line in ($text -split "`r?`n")) {
                        $line = $line.Trim()
                        if (-not $line -or $line -eq "SET") { continue }
                        $parts = $line -split '\|', -1
                        if ($parts.Count -ge 2) {
                            $result += @{ change_id = $parts[0].Trim(); applied_at = $parts[1].Trim() }
                        }
                    }
                    (ConvertTo-Json -InputObject @($result) -Depth 5) | Write-Output  # array even for 0 or 1 items
                } else {
                    Exec-Psql $cfg "
                        SELECT change_id, applied_at
                        FROM dmcr.change_log
                        ORDER BY applied_at DESC, change_id DESC;
                    "
                }
                return
            }

            if ($arg1 -eq "to") {
                # Support @tag syntax: dmcr revert to @v1.0
                $revertTarget = $arg2
                if ([string]::IsNullOrWhiteSpace($revertTarget)) {
                    throw "Usage: dmcr revert to <change_id|@tag>"
                }
                $keepTarget = $false
                if ($revertTarget.StartsWith("@")) {
                    $tagName = $revertTarget.Substring(1)
                    $resolved = Get-TagChangeId $cfg $tagName
                    if (-not $resolved) { throw "Tag '@$tagName' not found. Use 'dmcr tag list' to see available tags." }
                    Log-Info "Tag '@$tagName' resolves to change_id: $resolved"
                    $revertTarget = $resolved
                    # A tag marks a state to return TO: keep the tagged change applied.
                    $keepTarget = $true
                }
                if ($keepTarget) {
                    Log-Info "Reverting changes applied after $revertTarget (keeping $revertTarget)"
                } else {
                    Log-Info "Reverting down to and including: $revertTarget"
                }
                Acquire-AdvisoryLock $cfg
                try { Revert-To $cfg $revertTarget -KeepTarget:$keepTarget }
                finally { Release-AdvisoryLock $cfg }
                if ($jsonOut) {
                    (@{ status = "ok"; target = $revertTarget; action = "revert_to" } | ConvertTo-Json -Compress) | Write-Output
                }
                return
            }

            if ([string]::IsNullOrWhiteSpace($arg1)) {
                throw "Usage: dmcr revert <change_id>"
            }

            Log-Info "Reverting change: $arg1"
            Acquire-AdvisoryLock $cfg
            try { Revert-Change $cfg $arg1 }
            finally { Release-AdvisoryLock $cfg }
            if ($jsonOut) {
                (@{ status = "ok"; change_id = $arg1; action = "revert" } | ConvertTo-Json -Compress) | Write-Output
            }
        }

        "tag" {
            if ([string]::IsNullOrWhiteSpace($arg1) -or $arg1 -eq "list") {
                # List all tags
                if ($jsonOut) {
                    $sql = "SELECT tag_name, change_id, created_at, description FROM dmcr.tags ORDER BY created_at DESC;"
                    $rawOut = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args @("-q","-v","ON_ERROR_STOP=1","-X","-t","-A","-F","|","-c","SET lock_timeout = '$($cfg.LockTimeout)'; $sql") -PsqlPath $cfg.PsqlPath 2>&1)
                    $text = ($rawOut | Out-String).Trim()
                    $result = @()
                    foreach ($line in ($text -split "`r?`n")) {
                        $line = $line.Trim()
                        if (-not $line -or $line -eq "SET") { continue }
                        $parts = $line -split '\|', -1
                        if ($parts.Count -ge 3) {
                            $entry = @{
                                tag_name   = $parts[0].Trim()
                                change_id  = $parts[1].Trim()
                                created_at = $parts[2].Trim()
                            }
                            if ($parts.Count -ge 4 -and $parts[3].Trim()) { $entry.description = $parts[3].Trim() }
                            $result += $entry
                        }
                    }
                    (ConvertTo-Json -InputObject @($result) -Depth 5) | Write-Output  # array even for 0 or 1 items
                } else {
                    Log-Info "Release tags:"
                    Exec-Psql $cfg "SELECT tag_name, change_id, created_at, description FROM dmcr.tags ORDER BY created_at DESC;"
                }
                return
            }

            if ($arg1 -eq "create") {
                # dmcr tag create <name> [description]
                $tagName = $arg2
                if ([string]::IsNullOrWhiteSpace($tagName)) {
                    throw "Usage: dmcr tag create <tag_name> [description]`nExample: dmcr tag create v1.0 ""Sprint 42 release"""
                }
                # Validate tag name (alphanumeric, dots, dashes, underscores)
                if ($tagName -notmatch '^[a-zA-Z0-9._-]+$') {
                    throw "Invalid tag name '$tagName'. Use only letters, digits, dots, dashes, and underscores."
                }
                $description = if ($positional.Count -ge 4) { ($positional[3..($positional.Count-1)] -join " ") } else { $null }

                # Tag points to the last applied change
                $lastApplied = Last-Applied $cfg
                if ([string]::IsNullOrWhiteSpace($lastApplied)) {
                    throw "Cannot create tag — no changes are currently applied."
                }

                # Check tag doesn't already exist
                $existing = Get-TagChangeId $cfg $tagName
                if ($existing) {
                    throw "Tag '$tagName' already exists (points to '$existing'). Use 'dmcr tag delete $tagName' first."
                }

                $safeTag = Escape-SqlLiteral $tagName
                $safeChangeId = Escape-SqlLiteral $lastApplied
                $safeDesc = if ($description) { "'" + (Escape-SqlLiteral $description) + "'" } else { "NULL" }

                Exec-PsqlScalar $cfg "INSERT INTO dmcr.tags(tag_name, change_id, description) VALUES ('$safeTag', '$safeChangeId', $safeDesc);" | Out-Null

                Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('tag', :'dmcr_id', 'success', :'dmcr_msg', :'dmcr_env', :'dmcr_actor');
"@ -Vars @{ dmcr_id = $lastApplied; dmcr_msg = "Tagged as '$tagName'"; dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor) } | Out-Null

                if ($jsonOut) {
                    (@{ tag = $tagName; change_id = $lastApplied; status = "created" } | ConvertTo-Json -Compress) | Write-Output
                } else {
                    Log-Done "Tag '$tagName' created → $lastApplied"
                }
                return
            }

            if ($arg1 -eq "delete") {
                $tagName = $arg2
                if ([string]::IsNullOrWhiteSpace($tagName)) {
                    throw "Usage: dmcr tag delete <tag_name>"
                }
                $existing = Get-TagChangeId $cfg $tagName
                if (-not $existing) { throw "Tag '$tagName' does not exist." }

                $safeTag = Escape-SqlLiteral $tagName
                Exec-PsqlScalar $cfg "DELETE FROM dmcr.tags WHERE tag_name = '$safeTag';" | Out-Null
                if ($jsonOut) {
                    (@{ tag = $tagName; status = "deleted" } | ConvertTo-Json -Compress) | Write-Output
                } else {
                    Log-Done "Tag '$tagName' deleted"
                }
                return
            }

            throw "Unknown tag action '$arg1'. Use: dmcr tag [list|create|delete]"
        }

        "repeatable" {
            # dmcr repeatable — apply all repeatable migrations that have changed
            Log-Info "Checking repeatable migrations..."
            $rFolders = @(Get-RepeatableFolders $cfg.ChangesDir)

            if ($rFolders.Count -eq 0) {
                Log-Info "No repeatable migration folders (R__*) found"
                if ($jsonOut) { (@{ status = "ok"; applied = @() } | ConvertTo-Json -Depth 5) | Write-Output }
                return
            }

            Acquire-AdvisoryLock $cfg
            $results = @()
            try {
                foreach ($f in $rFolders) {
                    $id = $f.Name
                    $deployFile = Join-Path $f.FullName "deploy.sql"

                    if (-not (Test-Path $deployFile)) {
                        Log-Warn "$id — missing deploy.sql, skipping"
                        continue
                    }

                    if (-not (Test-RepeatableNeedsRun $cfg $f.FullName)) {
                        Log-Skip "$id — unchanged (checksum matches)"
                        $results += @{ change_id = $id; status = "unchanged" }
                        continue
                    }

                    $sw = [System.Diagnostics.Stopwatch]::StartNew()
                    $currentChecksum = Get-FileChecksum $deployFile
                    $actor = Get-DmcrActor

                    try {
                        Log-Apply "$id (repeatable)"

                        # Danger gate applies to repeatables too
                        Assert-SafeChange -FolderId $id -FolderPath $f.FullName -Mode 'deploy'

                        $verifyFile = Join-Path $f.FullName "verify.sql"
                        Assert-NoTxControl $id $deployFile
                        Assert-NoTxControl $id $verifyFile

                        # deploy.sql + repeatable_log checksum + verify.sql commit together, so a
                        # failed verify never records the new checksum.
                        $safeId = Escape-SqlLiteral $id
                        $safeChk = Escape-SqlLiteral $currentChecksum
                        $safeEnv = Escape-SqlLiteral $cfg.EnvName
                        $safeActor = Escape-SqlLiteral $actor
                        $upsertSql = @"
INSERT INTO dmcr.repeatable_log(change_id, last_checksum, applied_at, environment, actor)
VALUES ('$safeId', '$safeChk', now(), '$safeEnv', '$safeActor')
ON CONFLICT (change_id) DO UPDATE SET last_checksum = EXCLUDED.last_checksum, applied_at = EXCLUDED.applied_at, environment = EXCLUDED.environment, actor = EXCLUDED.actor;
"@
                        if (Test-Path $verifyFile) { Log-Verify "$id (inside the transaction)" }
                        Exec-PsqlFileTx $cfg $deployFile ($upsertSql + (Get-TxVerifySql $cfg $verifyFile))

                        $sw.Stop()

                        Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, environment, actor, duration_ms)
VALUES ('deploy', :'dmcr_id', 'success', :'dmcr_env', :'dmcr_actor', :dmcr_ms);
"@ -Vars @{ dmcr_id = $id; dmcr_env = $cfg.EnvName; dmcr_actor = $actor; dmcr_ms = "$($sw.ElapsedMilliseconds)" } | Out-Null

                        $results += @{ change_id = $id; status = "applied"; duration_ms = $sw.ElapsedMilliseconds }
                        Log-Done "$id applied ($($sw.ElapsedMilliseconds)ms)"
                    } catch {
                        $sw.Stop()
                        Log-Error "Failed to apply repeatable $id : $($_.Exception.Message)"
                        $results += @{ change_id = $id; status = "failed"; error = $_.Exception.Message }
                        throw
                    }
                }
            } finally {
                Release-AdvisoryLock $cfg
            }

            if ($jsonOut) {
                (@{ status = "ok"; applied = @($results) } | ConvertTo-Json -Depth 5) | Write-Output
            }
        }

        default {
            Show-Help
        }
    }
}

# =========================================================
# HELP
# =========================================================
function Show-Help {

    $titleColor   = "Cyan"
    $headingColor = "Green"
    $cmdColor     = "Yellow"
    $descColor    = "Gray"
    $exColor      = "DarkCyan"
    $noteColor    = "DarkYellow"
    $dimColor     = "DarkGray"

    function Write-Heading($text) { Write-Host "`n  $text" -ForegroundColor $headingColor }
    function Write-Cmd($c, $d) {
        Write-Host "    $c" -ForegroundColor $cmdColor -NoNewline
        Write-Host "  $d" -ForegroundColor $descColor
    }
    function Write-Ex($text) { Write-Host "    $text" -ForegroundColor $exColor }
    function Write-Note($text) { Write-Host "    $text" -ForegroundColor $noteColor }
    function Write-Para($text) { Write-Host "    $text" -ForegroundColor $descColor }

    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════════════════╗" -ForegroundColor $titleColor
    Write-Host "  ║                                                                      ║" -ForegroundColor $titleColor
    Write-Host "  ║   DMCR v1.1.0  ─  Database Management & Change Request Tracker       ║" -ForegroundColor $titleColor
    Write-Host "  ║                    for PostgreSQL                                     ║" -ForegroundColor $titleColor
    Write-Host "  ║                                                                      ║" -ForegroundColor $titleColor
    Write-Host "  ╚══════════════════════════════════════════════════════════════════════╝" -ForegroundColor $titleColor

    # ── OVERVIEW ──
    Write-Heading "OVERVIEW"
    Write-Para "DMCR is a lightweight, transactional database management & change request tracker for PostgreSQL."
    Write-Para "It executes versioned SQL changes from numbered folders, tracks applied state"
    Write-Para "in a registry (dmcr.change_log), and supports deploy, verify, and revert"
    Write-Para "workflows. All deploys and reverts are atomic — wrapped in a single transaction"
    Write-Para "so partial failures never leave the database in an inconsistent state."
    Write-Para "v1.0.0 adds advisory locking, dependency graphs, checksum policies, and JSON output."

    # ── USAGE ──
    Write-Heading "USAGE"
    Write-Ex "dmcr <command> [args] [--dry-run] [--json] [--debug] [-c|--config <path>]"

    # ── COMMANDS ──
    Write-Heading "COMMANDS"
    Write-Host ""
    Write-Host "    Core:" -ForegroundColor $headingColor
    Write-Cmd "init                   " "Create the DMCR registry schema and tables (run once per database)."
    Write-Cmd "deploy                 " "Apply all pending changes in order (with advisory locking)."
    Write-Cmd "deploy --to <id|@tag>  " "Deploy only up to the specified change or tag."
    Write-Cmd "test [--to <id|@tag>]   " "Round-trip pending changes (deploy, verify, revert, verify; schema and data must match) in one transaction, then roll back."
    Write-Cmd "status                 " "Show APPLIED / PENDING status for every change folder."
    Write-Cmd "verify                 " "Run verify.sql for the last applied change."
    Write-Cmd "verify all             " "Run verify.sql for every applied change in order."
    Write-Cmd "verify <change_id>     " "Run verify.sql for a specific applied change."
    Write-Cmd "parse [sql]            " "Validate SQL by executing inside a rolled-back transaction."
    Write-Cmd "repeatable             " "Apply all repeatable migrations (R__*) with changed checksums."
    Write-Host ""
    Write-Host "    Revert:" -ForegroundColor $headingColor
    Write-Cmd "revert <change_id>     " "Revert a specific change (must be the latest applied)."
    Write-Cmd "revert to <id|@tag>    " "Revert all changes down to and including the target (or tagged state)."
    Write-Cmd "revert list            " "List all applied changes in reverse chronological order."
    Write-Cmd "revertLast             " "Revert the single most-recently applied change."
    Write-Host ""
    Write-Host "    Inspect:" -ForegroundColor $headingColor
    Write-Cmd "history                " "Show applied changes with timestamps, checksums, actor, environment."
    Write-Cmd "info                   " "Summary of environment, pending/applied counts, registry health."
    Write-Cmd "plan                   " "Show dependency-aware execution order (reads meta.json)."
    Write-Cmd "check                  " "Run preflight validation without deploying."
    Write-Cmd "show config            " "Display the active configuration (connection redacted)."
    Write-Host ""
    Write-Host "    Tags:" -ForegroundColor $headingColor
    Write-Cmd "tag                    " "List all release tags."
    Write-Cmd "tag list               " "List all release tags (same as 'tag')."
    Write-Cmd "tag create <name>      " "Tag the current deployment state with a release name."
    Write-Cmd "tag delete <name>      " "Remove a tag."
    Write-Host ""
    Write-Host "    Repair:" -ForegroundColor $headingColor
    Write-Cmd "baseline <change_id>   " "Mark all changes up to and including <change_id> as applied."
    Write-Cmd "repair --mark-applied  " "Mark a specific change as applied without executing it."
    Write-Cmd "repair --mark-reverted " "Remove a change from the registry without executing revert."
    Write-Cmd "repair --checksums     " "Reconcile stored checksums with current files on disk."
    Write-Cmd "repair --unlock        " "Clear the deploy lock left behind by a crashed run."

    # ── GLOBAL OPTIONS ──
    Write-Heading "GLOBAL OPTIONS"
    Write-Host ""
    Write-Cmd "--dry-run              " "(deploy only) Print pending changes and their SQL without executing anything."
    Write-Cmd "--allow-prod           " "(test only) Allow 'test' against an environment named prod."
    Write-Cmd "--to <id|@tag>         " "(deploy/revert to) Stop at a specific change_id or release tag."
    Write-Cmd "--json                 " "Machine-readable JSON output (status, deploy, verify, history, info)."
    Write-Cmd "--debug                " "Enable verbose debug logging (or set DMCR_DEBUG=1)."
    Write-Cmd "-c, --config <path>    " "Path to config file (default: dmcr.cfg next to script,"
    Write-Para "                          or set DMCR_CONFIG env var)."
    Write-Cmd "-h, --help, /?         " "Show this documentation."

    # ── FOLDER STRUCTURE ──
    Write-Heading "CHANGE FOLDER STRUCTURE"
    Write-Para "Each change lives in a numbered subfolder under 'changes_dir':"
    Write-Host ""
    Write-Ex "changes_dir/"
    Write-Ex "├── 001_create_users/"
    Write-Ex "│   ├── deploy.sql          # DDL/DML to apply the change"
    Write-Ex "│   ├── verify.sql          # Assertions run after deploy (and after revert)"
    Write-Ex "│   ├── revert.sql          # SQL to undo the change"
    Write-Ex "│   └── meta.json           # Optional: dependencies, tags, ticket, author"
    Write-Ex "├── 002_add_email_index/"
    Write-Ex "│   ├── deploy.sql"
    Write-Ex "│   ├── verify.sql"
    Write-Ex "│   └── revert.sql"
    Write-Ex "├── R__user_summary_view/   # REPEATABLE: re-runs when checksum changes"
    Write-Ex "│   ├── deploy.sql          # Idempotent — CREATE OR REPLACE etc."
    Write-Ex "│   └── verify.sql          # Optional verification"
    Write-Ex "└── R__audit_triggers/"
    Write-Ex "    └── deploy.sql"
    Write-Host ""
    Write-Note "• Folder names MUST start with a 3-digit prefix: 001_, 002_, 003_, etc."
    Write-Note "• Repeatable folders start with R__ — they re-run when deploy.sql changes."
    Write-Note "• Folders are processed in alphabetical (numeric) order."
    Write-Note "• Each versioned folder MUST contain deploy.sql, verify.sql, and revert.sql."
    Write-Note "• Repeatable folders only require deploy.sql (verify.sql optional, no revert.sql needed)."
    Write-Note "• Optional meta.json declares dependencies, tags, ticket, and author."

    # ── META.JSON ──
    Write-Heading "META.JSON (optional)"
    Write-Para "Place a meta.json in any change folder to declare dependencies and metadata:"
    Write-Host ""
    Write-Ex '{ "requires": ["001_create_users"], "tags": ["schema"], "ticket": "JIRA-1234", "author": "jdoe" }'
    Write-Host ""
    Write-Note "• 'requires' declares dependency on other change_ids (used by 'plan' command)."
    Write-Note "• 'tags' are informational labels for filtering and documentation."
    Write-Note "• 'ticket' and 'author' are stored in the registry alongside the change."

    # ── CONFIG FILE ──
    Write-Heading "CONFIGURATION  (dmcr.cfg)"
    Write-Para "INI-style config with a [dmcr] section and one section per environment:"
    Write-Host ""
    Write-Ex "[dmcr]"
    Write-Ex "env               = dev                          # Active environment"
    Write-Ex "changes_dir       = C:\path\to\db\changes        # Folder containing change dirs"
    Write-Ex "psql_path         = C:\path\to\psql.exe          # Path to psql (optional)"
    Write-Ex "lock_timeout      = 30s                          # Max wait on locks"
    Write-Ex "statement_timeout = 5min                         # Max statement runtime"
    Write-Ex "checksum_policy   = warn                         # warn | block | repair"
    Write-Ex ""
    Write-Ex "[dev]"
    Write-Ex "conn = postgresql://user:pass@host:5432/mydb?sslmode=require"
    Write-Ex ""
    Write-Ex "[prod]"
    Write-Ex "conn =                                           # Use DMCR_CONN env var"
    Write-Ex ""
    Write-Ex "[placeholders]"
    Write-Ex "schema_name       = myapp                        # Substituted as `${schema_name}`"
    Write-Ex "default_tenant    = 1                            # Substituted as `${default_tenant}`"
    Write-Host ""
    Write-Note "• DMCR_CONN env var overrides the conn value in the active section."
    Write-Note "• DMCR_CONFIG env var overrides the default config file path."
    Write-Note "• DMCR_PSQL env var overrides psql_path."
    Write-Note "• DMCR_PLACEHOLDER_<name> env vars override [placeholders] values."
    Write-Note "• Placeholders use `${name}` syntax in SQL files and are substituted at runtime."

    # ── REGISTRY ──
    Write-Heading "REGISTRY TABLES"
    Write-Para "Created by 'dmcr init' in the 'dmcr' schema:"
    Write-Host ""
    Write-Ex "dmcr.change_log   change_id (PK), applied_at, applied_by, description,"
    Write-Ex "                  deploy_checksum, verify_checksum, revert_checksum,"
    Write-Ex "                  ticket_id, git_commit, app_name, environment, actor"
    Write-Ex "dmcr.event_log    id, event_ts, action, change_id, status, message,"
    Write-Ex "                  environment, actor, duration_ms"
    Write-Host ""
    Write-Note "• change_log tracks which changes are currently applied."
    Write-Note "• event_log is an append-only audit trail of deploy/revert actions."

    # ── HOW DEPLOY WORKS ──
    Write-Heading "HOW DEPLOY WORKS"
    Write-Para "For each pending change folder (in order):"
    Write-Host ""
    Write-Ex "  1. BEGIN transaction"
    Write-Ex "  2. Execute deploy.sql"
    Write-Ex "  3. INSERT into dmcr.change_log  (same transaction)"
    Write-Ex "  4. COMMIT"
    Write-Ex "  5. Run verify.sql  (separate call)"
    Write-Ex "       ├── If verify passes  →  log success to event_log  ✅"
    Write-Ex "       └── If verify FAILS   →  auto-revert (revert.sql + DELETE)  ⚠️"
    Write-Host ""
    Write-Note "• Deploy + record are atomic — if deploy.sql fails, nothing is recorded."
    Write-Note "• If verify fails, the change is automatically reverted."
    Write-Note "• lock_timeout and statement_timeout are enforced inside the transaction."

    # ── EXAMPLES ──
    Write-Heading "EXAMPLES"
    Write-Host ""

    Write-Host "    # First-time setup — create the DMCR registry" -ForegroundColor $dimColor
    Write-Ex "dmcr init"
    Write-Host ""

    Write-Host "    # Deploy all pending changes" -ForegroundColor $dimColor
    Write-Ex "dmcr deploy"
    Write-Host ""

    Write-Host "    # Deploy with JSON output for CI pipelines" -ForegroundColor $dimColor
    Write-Ex "dmcr deploy --json"
    Write-Host ""

    Write-Host "    # Deploy only up to a specific change (partial deploy)" -ForegroundColor $dimColor
    Write-Ex "dmcr deploy --to 003_seed_roles"
    Write-Host ""

    Write-Host "    # Deploy up to a tagged release" -ForegroundColor $dimColor
    Write-Ex "dmcr deploy --to @v1.0"
    Write-Host ""

    Write-Host "    # Deploy with debug output" -ForegroundColor $dimColor
    Write-Ex "dmcr deploy --debug"
    Write-Host ""

    Write-Host "    # Check which changes are applied vs pending" -ForegroundColor $dimColor
    Write-Ex "dmcr status"
    Write-Ex "dmcr status --json"
    Write-Host ""

    Write-Host "    # Verify the last applied change" -ForegroundColor $dimColor
    Write-Ex "dmcr verify"
    Write-Host ""

    Write-Host "    # Verify all applied changes" -ForegroundColor $dimColor
    Write-Ex "dmcr verify all"
    Write-Host ""

    Write-Host "    # Verify a specific change" -ForegroundColor $dimColor
    Write-Ex "dmcr verify 002_add_email_index"
    Write-Host ""

    Write-Host "    # View change history" -ForegroundColor $dimColor
    Write-Ex "dmcr history"
    Write-Ex "dmcr history --json"
    Write-Host ""

    Write-Host "    # Environment info and health" -ForegroundColor $dimColor
    Write-Ex "dmcr info"
    Write-Host ""

    Write-Host "    # Show dependency-aware execution plan" -ForegroundColor $dimColor
    Write-Ex "dmcr plan"
    Write-Host ""

    Write-Host "    # Run preflight checks without deploying" -ForegroundColor $dimColor
    Write-Ex "dmcr check"
    Write-Host ""

    Write-Host "    # Baseline existing database (mark changes as already applied)" -ForegroundColor $dimColor
    Write-Ex "dmcr baseline 003_seed_roles"
    Write-Host ""

    Write-Host "    # Repair: manually mark a change" -ForegroundColor $dimColor
    Write-Ex "dmcr repair --mark-applied 005_add_index"
    Write-Ex "dmcr repair --mark-reverted 005_add_index"
    Write-Ex "dmcr repair --checksums"
    Write-Host ""

    Write-Host "    # Validate a SQL snippet without persisting" -ForegroundColor $dimColor
    Write-Ex "dmcr parse ""SELECT 1 FROM users;"""
    Write-Host ""

    Write-Host "    # Revert the most recent change" -ForegroundColor $dimColor
    Write-Ex "dmcr revertLast"
    Write-Host ""

    Write-Host "    # Revert a specific change (must be latest)" -ForegroundColor $dimColor
    Write-Ex "dmcr revert 003_seed_roles"
    Write-Host ""

    Write-Host "    # Revert everything back to (and including) a target" -ForegroundColor $dimColor
    Write-Ex "dmcr revert to 001_create_users"
    Write-Host ""

    Write-Host "    # List all applied changes" -ForegroundColor $dimColor
    Write-Ex "dmcr revert list"
    Write-Host ""

    Write-Host "    # Revert to a tagged release state" -ForegroundColor $dimColor
    Write-Ex "dmcr revert to @v1.0"
    Write-Host ""

    Write-Host "    # Tag the current deployment state" -ForegroundColor $dimColor
    Write-Ex "dmcr tag create v1.0 ""Sprint 42 release"""
    Write-Ex "dmcr tag create hotfix-2026-05 ""Post-release fix"""
    Write-Host ""

    Write-Host "    # List and delete tags" -ForegroundColor $dimColor
    Write-Ex "dmcr tag list"
    Write-Ex "dmcr tag delete v1.0"
    Write-Host ""

    Write-Host "    # Apply repeatable migrations (views, functions, triggers)" -ForegroundColor $dimColor
    Write-Ex "dmcr repeatable"
    Write-Host ""

    Write-Host "    # Show active configuration" -ForegroundColor $dimColor
    Write-Ex "dmcr show config"
    Write-Host ""

    Write-Host "    # Use a custom config file" -ForegroundColor $dimColor
    Write-Ex "dmcr deploy -c C:\configs\prod.cfg"
    Write-Host ""

    Write-Host "    # Override connection via environment variable" -ForegroundColor $dimColor
    Write-Ex "`$env:DMCR_CONN = ""postgresql://admin:secret@prod:5432/app"""
    Write-Ex "dmcr deploy"
    Write-Host ""

    # ── SAFETY ──
    Write-Heading "SAFETY & DESIGN NOTES"
    Write-Note "• The registry is NOT auto-created. You must run 'dmcr init' explicitly."
    Write-Note "• Deploy and revert acquire a PostgreSQL advisory lock to prevent concurrent runs."
    Write-Note "• Deploy and revert are fully transactional (single psql call)."
    Write-Note "• Verify failure after deploy triggers automatic rollback."
    Write-Note "• 'revert' only allows reverting the latest change (stack order)."
    Write-Note "• 'revert to' peels back changes one-at-a-time from the top."
    Write-Note "• 'parse' runs SQL in a BEGIN/ROLLBACK block — nothing is persisted."
    Write-Note "• Passwords in connection strings are redacted in all log output."
    Write-Note "• lock_timeout and statement_timeout prevent runaway operations."
    Write-Note "• checksum_policy controls mismatch behavior: warn (default), block, or repair."
    Write-Note "• Placeholders (`${name}`) are substituted from [placeholders] config before execution."
    Write-Note "• Unresolved placeholders cause an immediate error (fail-fast)."

    Write-Heading "DANGEROUS OPERATIONS (danger_ prefix)"
    Write-Para "Folders with 'danger_' in the name are NEVER executed by DMCR."
    Write-Para "The DBA connects directly and runs deploy.sql / revert.sql by hand."
    Write-Host ""
    Write-Note "• 'dmcr deploy' SKIPs any danger_ folder — no error, nothing recorded in change_log."
    Write-Note "• 'dmcr revert' HARD BLOCKS if asked to revert a danger_ change_id."
    Write-Note "• danger_ folders ARE git-tracked; SQL files are generated/versioned as normal."
    Write-Note "• Normal folders are scanned for: TRUNCATE, DROP TABLE/SCHEMA/DATABASE/FUNCTION/"
    Write-Note "  PROCEDURE/VIEW/TRIGGER/INDEX/SEQUENCE/TYPE/EXTENSION, DELETE/UPDATE without WHERE."
    Write-Note "  If found, DMCR blocks and tells you to rename the folder with danger_."
    Write-Note "• SQL inside -- comments and /* */ blocks is ignored by the scanner."
    Write-Host ""
    Write-Ex   "  # Normal — DMCR deploys and reverts automatically:"
    Write-Ex   "  001_add_users_table/"
    Write-Host ""
    Write-Ex   "  # Manual-only — DMCR skips/blocks; DBA runs the SQL directly:"
    Write-Ex   "  003_danger_truncate_audit_log/"
    Write-Host ""
    Write-Ex   "  DBA manually:  psql `$conn -f changes/003_danger_truncate_audit_log/deploy.sql"

    Write-Host ""
    Write-Host "  ─────────────────────────────────────────────────────────────────" -ForegroundColor $dimColor
    Write-Host "  DMCR v1.1.0  •  PostgreSQL Management & Change Request  •  Transactional Changes" -ForegroundColor $dimColor
    Write-Host ""
}

# =========================================================
# CONFIG (INI)
# =========================================================
function Read-Ini($Path) {
    if (-not (Test-Path $Path)) {
        throw "Config file not found: $Path"
    }

    $ini = @{}
    $section = ""

    foreach ($raw in Get-Content $Path -Encoding UTF8) {
        $line = $raw.Trim()
        if ($line -eq "" -or $line.StartsWith("#") -or $line.StartsWith(";")) {
            continue
        }

        if ($line -match '^\[(.+)\]$') {
            $section = $Matches[1]
            if (-not $ini.ContainsKey($section)) {
                $ini[$section] = @{}
            }
            continue
        }

        $idx = $line.IndexOf("=")
        if ($idx -lt 0) { continue }

        $key = $line.Substring(0, $idx).Trim()
        $val = $line.Substring($idx + 1).Trim()
        $ini[$section][$key] = $val
    }

    return $ini
}

function Get-Cfg($ConfigPath) {
    $ini = Read-Ini $ConfigPath

    if (-not $ini.ContainsKey("dmcr")) {
        throw "Missing [dmcr] section in config"
    }

    $env = $ini["dmcr"]["env"]
    if ([string]::IsNullOrWhiteSpace($env)) {
        $env = "dev"
    }

    if (-not $ini.ContainsKey($env)) {
        throw "Missing [$env] section in config"
    }

    $lockTimeout = $ini["dmcr"]["lock_timeout"]
    if ([string]::IsNullOrWhiteSpace($lockTimeout)) {
        $lockTimeout = "5s"
    }

    $stmtTimeout = $ini["dmcr"]["statement_timeout"]
    if ([string]::IsNullOrWhiteSpace($stmtTimeout)) {
        $stmtTimeout = "5min"
    }

    # Resolve connection string: DMCR_CONN env var wins over the cfg [env] conn
    # (the VS Code extension injects the URL + keychain password via DMCR_CONN).
    $conn = $env:DMCR_CONN
    if ([string]::IsNullOrWhiteSpace($conn)) {
        $conn = $ini[$env]["conn"]
    }
    if ([string]::IsNullOrWhiteSpace($conn)) {
        throw "No connection string found in [$env] section or DMCR_CONN env var"
    }

    # Normalize changes_dir to an absolute path so the script works correctly
    # regardless of the working directory from which it is invoked.
    $rawChangesDir = $ini["dmcr"]["changes_dir"]
    $changesDir = $rawChangesDir
    if (-not [string]::IsNullOrWhiteSpace($rawChangesDir) -and -not [System.IO.Path]::IsPathRooted($rawChangesDir)) {
        # Relative paths resolve against DMCR_BASE_DIR (the workspace root, set by the extension),
        # otherwise against the config file's folder.
        $baseDir = if ($env:DMCR_BASE_DIR) { $env:DMCR_BASE_DIR } else { Split-Path $ConfigPath -Parent }
        $changesDir = [System.IO.Path]::GetFullPath((Join-Path $baseDir $rawChangesDir))
        Log-Debug "changes_dir resolved: '$rawChangesDir' -> '$changesDir'"
    }

    # checksum_policy: warn (default) | block | repair
    $checksumPolicy = $ini["dmcr"]["checksum_policy"]
    if ([string]::IsNullOrWhiteSpace($checksumPolicy)) { $checksumPolicy = "warn" }
    if ($checksumPolicy -notin @("warn","block","repair")) {
        Log-Warn "Invalid checksum_policy='$checksumPolicy' in config — defaulting to 'warn'"
        $checksumPolicy = "warn"
    }

    # Placeholders from [placeholders] section + DMCR_PLACEHOLDER_* env vars
    $placeholders = Build-Placeholders $ini

    return [pscustomobject]@{
        EnvName         = $env
        Conn            = $conn
        ChangesDir      = $changesDir
        PsqlPath        = $ini["dmcr"]["psql_path"]
        LockTimeout     = $lockTimeout
        StmtTimeout     = $stmtTimeout
        ChecksumPolicy  = $checksumPolicy
        Placeholders    = $placeholders
    }
}

function Print-Config($cfg, $Path) {
    $columns = @(
        @{ Name = "Key";   hasEmoji = $false },
        @{ Name = "Value"; hasEmoji = $false }
    )

    $data = @(
        @{ Key = "path";            Key_Color = "DarkCyan"; Value = $Path;                          Value_Color = "Gray" }
        @{ Key = "env";             Key_Color = "DarkCyan"; Value = "$($cfg.EnvName)";              Value_Color = "Gray" }
        @{ Key = "changes_dir";     Key_Color = "DarkCyan"; Value = "$($cfg.ChangesDir)";           Value_Color = "Gray" }
        @{ Key = "psql_path";       Key_Color = "DarkCyan"; Value = "$($cfg.PsqlPath)";             Value_Color = "Gray" }
        @{ Key = "lock_timeout";    Key_Color = "DarkCyan"; Value = "$($cfg.LockTimeout)";          Value_Color = "Gray" }
        @{ Key = "stmt_timeout";    Key_Color = "DarkCyan"; Value = "$($cfg.StmtTimeout)";          Value_Color = "Gray" }
        @{ Key = "checksum_policy"; Key_Color = "DarkCyan"; Value = "$($cfg.ChecksumPolicy)";       Value_Color = "Gray" }
        @{ Key = "placeholders";    Key_Color = "DarkCyan"; Value = $(if ($cfg.Placeholders.Count -gt 0) { "$($cfg.Placeholders.Count) defined" } else { "none" }); Value_Color = "Gray" }
        @{ Key = "conn";            Key_Color = "DarkCyan"; Value = (Redact-Conn "$($cfg.Conn)");   Value_Color = "Gray" }
    )
    BoxedColorTableWithTitle -Title "Config" -columns $columns -data $data
}

# =========================================================
# REGISTRY GUARD
# =========================================================
function Require-Registry($cfg) {
    Log-Debug "Checking DMCR registry exists (dmcr.change_log)"

    $sql = @"
SELECT 1
FROM information_schema.tables
WHERE table_schema = 'dmcr'
  AND table_name   = 'change_log';
"@

    $ok = Exec-PsqlScalar $cfg $sql
    Log-Debug "Registry check result: '$ok'"

    if ($ok -ne "1") {
        throw @"
ERROR  DMCR registry not found.
       Please run: dmcr init
       This will execute: dmcr_change_log_ddl.sql
"@
    }

    # Ensure v1.1.0 tables exist (repeatable_log, tags)
    $v11 = Exec-PsqlScalarSafe $cfg "SELECT 1 FROM information_schema.tables WHERE table_schema='dmcr' AND table_name='repeatable_log';" -Vars @{}
    if ($v11 -ne "1") {
        Log-Info "Upgrading registry: creating dmcr.repeatable_log and dmcr.tags..."
        $upgradeSql = @"
CREATE TABLE IF NOT EXISTS dmcr.tags (
    tag_name    TEXT        PRIMARY KEY,
    change_id   TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  TEXT,
    description TEXT
);
CREATE TABLE IF NOT EXISTS dmcr.repeatable_log (
    change_id      TEXT        PRIMARY KEY,
    last_checksum  TEXT        NOT NULL,
    applied_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by     TEXT,
    environment    TEXT,
    actor          TEXT
);
"@
        Exec-Psql $cfg $upgradeSql | Out-Null
        Log-Info "Registry upgraded to v1.1.0"
    }
}

# =========================================================
# PSQL HELPERS
# =========================================================
# Split the password out of a connection string so psql gets it through PGPASSWORD instead
# of the command line (process arguments are visible to every user on the machine).
function Split-ConnPassword([string]$Conn) {
    $m = [regex]::Match($Conn, '^([A-Za-z][A-Za-z0-9+.-]*://[^:/@\s]+):([^@\s]*)@(.*)$')
    if ($m.Success) {
        return @{ Conn = "$($m.Groups[1].Value)@$($m.Groups[3].Value)"; Password = [Uri]::UnescapeDataString($m.Groups[2].Value) }
    }
    $k = [regex]::Match($Conn, "(^|\s)password\s*=\s*('(?:[^'\\]|\\.)*'|\S+)", 'IgnoreCase')
    if ($k.Success) {
        $pw = $k.Groups[2].Value
        if ($pw.StartsWith("'")) { $pw = [regex]::Replace($pw.Substring(1, $pw.Length - 2), '\\(.)', '$1') }
        return @{ Conn = $Conn.Remove($k.Index, $k.Length).Trim(); Password = $pw }
    }
    return @{ Conn = $Conn; Password = $null }
}

function Invoke-DmcrPsql {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$Conn,
        [Parameter(Mandatory=$true)][string[]]$Args,
        [Parameter(Mandatory=$false)][string]$PsqlPath
    )

    $exe = $null

    if (-not [string]::IsNullOrWhiteSpace($PsqlPath)) {
        $exe = $PsqlPath
    } elseif (-not [string]::IsNullOrWhiteSpace($env:DMCR_PSQL)) {
        $exe = $env:DMCR_PSQL
    } else {
        $exe = "psql"
    }

    if ($exe -ne "psql" -and -not (Test-Path $exe)) {
        throw "psql.exe not found at: $exe (set [dmcr].psql_path or DMCR_PSQL or install psql)"
    }

    if ($script:DmcrDebug) {
        Write-Color -m1 "DEBUG   " -m2 "------------------------------------------------------------------------------------------------------------------------------------------" -c1 DarkMagenta -c2 Cyan
        Write-Color -m1 "DEBUG   " -m2 " Connecting with: $(Redact-Conn $Conn)" -c1 DarkMagenta -c2 Cyan
        Write-Color -m1 "DEBUG   " -m2 " Using psql executable: $exe" -c1 DarkMagenta -c2 Cyan
        Write-Color -m1 "DEBUG   " -m2 " Invoking psql with args: $(Format-Args $Args)" -c1 DarkMagenta -c2 Cyan
        Write-Color -m1 "DEBUG   " -m2 "------------------------------------------------------------------------------------------------------------------------------------------" -c1 DarkMagenta -c2 Cyan
    }

    # psql writes NOTICEs to stderr. Under Windows PowerShell 5.1 with ErrorActionPreference=Stop,
    # any native stderr line throws. Callers check $LASTEXITCODE, so relax it for this call only.
    $ErrorActionPreference = "Continue"
    $connParts = Split-ConnPassword $Conn
    $prevPgPassword = $env:PGPASSWORD
    if ($connParts.Password) { $env:PGPASSWORD = $connParts.Password }
    try {
        & $exe $connParts.Conn @Args
    } finally {
        $env:PGPASSWORD = $prevPgPassword
    }
}

# ---- SQL-safe literal escaping (doubles single quotes + escapes backslashes) ----
function Escape-SqlLiteral([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return $Value }
    # PostgreSQL standard_conforming_strings is ON by default;
    # doubling single-quotes is the only escaping needed.
    return $Value.Replace("'", "''")
}

# ---- SHA-256 checksum of a file (hex string, lowercase) ----
# Used to detect if deploy.sql has been tampered with after a change was applied.
function Get-FileChecksum([string]$File) {
    return (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Exec-PsqlScalar($cfg, $Sql) {
    $timedSql = "SET lock_timeout = '$($cfg.LockTimeout)'; SET statement_timeout = '$($cfg.StmtTimeout)'; $Sql"
    Log-Debug "PSQL scalar SQL: $Sql"

    $out = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args @("-q","-v","ON_ERROR_STOP=1","-X","-t","-A","-c",$timedSql) -PsqlPath $cfg.PsqlPath 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $errDetail = ($out | Out-String).Trim()
        $m = [regex]::Match($errDetail, '(?m)(ERROR|FATAL|PANIC):\s*(.+)')
        if ($m.Success) { $errDetail = "$($m.Groups[1].Value): $($m.Groups[2].Value.Trim())" }
        throw "psql failed: $errDetail"
    }

    $text = ($out | Out-String).Trim()
    $lines = @(
        $text -split "`r?`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and $_ -ne "SET" }
    )

    if ($lines.Length -gt 0) {
        $result = $lines[-1]
        Log-Debug "PSQL scalar result: '$result'"
        return $result
    }

    Log-Debug "PSQL scalar result: '' (empty)"
    return ""
}

# Execute a scalar query that uses psql :'var' binding instead of string interpolation.
# $Vars is a hashtable, e.g. @{ id = "001_init" }.  The SQL should reference :'id'.
function Exec-PsqlScalarSafe($cfg, $Sql, [hashtable]$Vars) {
    $timedSql = "SET lock_timeout = '$($cfg.LockTimeout)'; SET statement_timeout = '$($cfg.StmtTimeout)'; $Sql"
    Log-Debug "PSQL scalar-safe SQL: $Sql"

    $argList = [System.Collections.Generic.List[string]]::new()
    $argList.AddRange([string[]]@("-q","-v","ON_ERROR_STOP=1","-X","-t","-A"))

    if ($Vars) {
        foreach ($kv in $Vars.GetEnumerator()) {
            $argList.Add("-v")
            $argList.Add("$($kv.Key)=$($kv.Value)")
        }
    }

    # psql only interpolates :'var' in scripts it reads itself (-f / stdin), never in -c strings,
    # so the SQL goes through a temp file. UTF-8 without BOM so psql parses line 1 cleanly.
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dmcr_scalar_" + [guid]::NewGuid().ToString("N") + ".sql")
    [System.IO.File]::WriteAllText($tmp, $timedSql, (New-Object System.Text.UTF8Encoding($false)))
    $argList.AddRange([string[]]@("-f", $tmp))

    try {
        $out = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args $argList.ToArray() -PsqlPath $cfg.PsqlPath 2>&1)
    } finally {
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0) {
        $errDetail = ($out | Out-String).Trim()
        $m = [regex]::Match($errDetail, '(?m)(ERROR|FATAL|PANIC):\s*(.+)')
        if ($m.Success) { $errDetail = "$($m.Groups[1].Value): $($m.Groups[2].Value.Trim())" }
        throw "psql failed: $errDetail"
    }

    $text = ($out | Out-String).Trim()
    $lines = @(
        $text -split "`r?`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and $_ -ne "SET" }
    )

    if ($lines.Length -gt 0) {
        $result = $lines[-1]
        Log-Debug "PSQL scalar-safe result: '$result'"
        return $result
    }
    return ""
}

# Run a .sql file inside BEGIN/ROLLBACK (read-only verification, no side effects persisted).
function Exec-PsqlFileTx-Rollback($cfg, $File) {
    if (-not (Test-Path $File)) { throw "Missing file: $File" }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dmcr_verify_" + [Guid]::NewGuid().ToString("N") + ".sql")
    try {
        $fileContent = Get-Content -Path $File -Raw -Encoding UTF8

        # Apply placeholder substitution if placeholders are configured
        if ($cfg.Placeholders -and $cfg.Placeholders.Count -gt 0) {
            $fileContent = Resolve-Placeholders $fileContent $cfg.Placeholders
        }

        $content = @"
BEGIN;
SET LOCAL lock_timeout = '$($cfg.LockTimeout)';
SET LOCAL statement_timeout = '$($cfg.StmtTimeout)';
$fileContent
ROLLBACK;
"@
        Set-Content -Path $tmp -Value $content -Encoding UTF8
        Log-Debug "PSQL verify-tx (rollback): $File (wrapper: $tmp)"

        $psqlOut = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args @("-q","-v","ON_ERROR_STOP=1","-X","-f",$tmp) -PsqlPath $cfg.PsqlPath 2>&1)
        $psqlText = ($psqlOut | Out-String).Trim()
        if ($psqlText) { Log-Debug "PSQL verify output: $psqlText" }
        if ($LASTEXITCODE -ne 0) {
            $errDetail = $psqlText
            $m = [regex]::Match($psqlText, '(?m)(ERROR|FATAL|PANIC):\s*(.+)')
            if ($m.Success) { $errDetail = "$($m.Groups[1].Value): $($m.Groups[2].Value.Trim())" }
            throw "verify.sql failed: $File`n$errDetail"
        }
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    }
}

# Run a .sql file + additional SQL in a SINGLE psql call (one transaction).
# This ensures the file and the follow-up SQL either both commit or both roll back.
function Exec-PsqlFileTx($cfg, $File, [string]$PostSql, [hashtable]$Vars) {
    if (-not (Test-Path $File)) { throw "Missing file: $File" }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dmcr_tx_" + [Guid]::NewGuid().ToString("N") + ".sql")
    try {
        $fileContent = Get-Content -Path $File -Raw -Encoding UTF8

        # Apply placeholder substitution if placeholders are configured
        if ($cfg.Placeholders -and $cfg.Placeholders.Count -gt 0) {
            $fileContent = Resolve-Placeholders $fileContent $cfg.Placeholders
        }

        $content = @"
BEGIN;
SET LOCAL lock_timeout = '$($cfg.LockTimeout)';
SET LOCAL statement_timeout = '$($cfg.StmtTimeout)';
$fileContent
$PostSql
COMMIT;
"@
        Set-Content -Path $tmp -Value $content -Encoding UTF8
        Log-Debug "PSQL file-tx: $File (wrapper: $tmp)"

        $argList = [System.Collections.Generic.List[string]]::new()
        $argList.AddRange([string[]]@("-q","-v","ON_ERROR_STOP=1","-X"))
        if ($Vars) {
            foreach ($kv in $Vars.GetEnumerator()) {
                $argList.Add("-v")
                $argList.Add("$($kv.Key)=$($kv.Value)")
            }
        }
        $argList.AddRange([string[]]@("-f", $tmp))

        $psqlOut = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args $argList.ToArray() -PsqlPath $cfg.PsqlPath 2>&1)
        $psqlText = ($psqlOut | Out-String).Trim()
        if ($psqlText) { Log-Debug "PSQL file-tx output: $psqlText" }
        if ($LASTEXITCODE -ne 0) {
            # Extract the most useful part of the error for the exception message
            $errDetail = $psqlText
            $m = [regex]::Match($psqlText, '(?m)(ERROR|FATAL|PANIC):\s*(.+)')
            if ($m.Success) { $errDetail = "$($m.Groups[1].Value): $($m.Groups[2].Value.Trim())" }
            throw "psql transaction failed for file: $File`n$errDetail"
        }
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    }
}

# Run a .sql file WITHOUT a transaction: each statement commits on its own (psql autocommit).
# Only for changes that opt in with meta.json "transaction": false (e.g. CREATE INDEX CONCURRENTLY).
function Exec-PsqlFileNoTx($cfg, $File) {
    if (-not (Test-Path $File)) { throw "Missing file: $File" }
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dmcr_notx_" + [Guid]::NewGuid().ToString("N") + ".sql")
    try {
        $fileContent = Get-Content -Path $File -Raw -Encoding UTF8
        if ($cfg.Placeholders -and $cfg.Placeholders.Count -gt 0) {
            $fileContent = Resolve-Placeholders $fileContent $cfg.Placeholders
        }
        $content = @"
SET lock_timeout = '$($cfg.LockTimeout)';
SET statement_timeout = '$($cfg.StmtTimeout)';
$fileContent
"@
        Set-Content -Path $tmp -Value $content -Encoding UTF8
        Log-Debug "PSQL file (no transaction): $File (wrapper: $tmp)"
        $psqlOut = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args ([string[]]@("-q","-v","ON_ERROR_STOP=1","-X","-f",$tmp)) -PsqlPath $cfg.PsqlPath 2>&1)
        $psqlText = ($psqlOut | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            $errDetail = $psqlText
            $m = [regex]::Match($psqlText, '(?m)(ERROR|FATAL|PANIC):\s*(.+)')
            if ($m.Success) { $errDetail = "$($m.Groups[1].Value): $($m.Groups[2].Value.Trim())" }
            throw "psql failed for file: $File`n$errDetail"
        }
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    }
}

# Run only SQL text in a transaction (registry row + verify for a non-transactional change)
function Exec-PsqlSqlTx($cfg, [string]$Sql) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dmcr_reg_" + [Guid]::NewGuid().ToString("N") + ".sql")
    try {
        Set-Content -Path $tmp -Value "-- DMCR registry update" -Encoding UTF8
        Exec-PsqlFileTx $cfg $tmp $Sql
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    }
}

# meta.json "transaction": false
function Test-NoTxChange($meta) {
    return ($null -ne $meta -and $null -ne $meta.PSObject.Properties['transaction'] -and $meta.transaction -eq $false)
}

# Applied changes whose deploy.sql no longer matches the checksum recorded at deploy time.
# Applied changes whose deploy.sql, verify.sql or revert.sql no longer match the checksums
# recorded at deploy time. Returns "<id>/<file>" per edited file. (Empty stored checksums —
# older rows — are not compared.)
function Get-DriftedChanges($cfg) {
    $drifted = @()
    try {
        $rows = Exec-PsqlScalar $cfg "SELECT string_agg(change_id || ':' || coalesce(deploy_checksum, '') || ':' || coalesce(verify_checksum, '') || ':' || coalesce(revert_checksum, ''), ' ' ORDER BY change_id) FROM dmcr.change_log;"
    } catch { return @() }
    if ([string]::IsNullOrWhiteSpace("$rows")) { return @() }
    foreach ($row in ("$rows" -split '\s+')) {
        $parts = $row.Split(':')
        if ($parts.Count -lt 4 -or -not $parts[0]) { continue }
        $cid = $parts[0]
        $names = @('deploy', 'verify', 'revert')
        for ($k = 0; $k -lt 3; $k++) {
            $chk = $parts[$k + 1]
            if (-not $chk) { continue }
            $f = Join-Path (Join-Path $cfg.ChangesDir $cid) "$($names[$k]).sql"
            if (-not (Test-Path $f)) { continue }
            if ((Get-FileChecksum $f) -ne $chk) { $drifted += "$cid/$($names[$k]).sql" }
        }
    }
    return $drifted
}

# checksum_policy=repair: accept the edited files of one applied change and log it.
function Accept-ChangeChecksums($cfg, [string]$Id, [string]$Files) {
    $dir = Join-Path $cfg.ChangesDir $Id
    $chk = @{}
    foreach ($n in 'deploy', 'verify', 'revert') {
        $p = Join-Path $dir "$n.sql"
        $chk[$n] = if (Test-Path $p) { Get-FileChecksum $p } else { '' }
    }
    Exec-PsqlScalarSafe $cfg "UPDATE dmcr.change_log SET deploy_checksum = :'d', verify_checksum = :'v', revert_checksum = :'r' WHERE change_id = :'dmcr_id';" `
        -Vars @{ d = $chk['deploy']; v = $chk['verify']; r = $chk['revert']; dmcr_id = $Id } | Out-Null
    try {
        Exec-PsqlScalarSafe $cfg "INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor) VALUES ('repair', :'dmcr_id', 'success', :'dmcr_msg', :'dmcr_env', :'dmcr_actor');" `
            -Vars @{ dmcr_id = $Id; dmcr_msg = "Accepted edited $Files (checksum_policy=repair)"; dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor) } | Out-Null
    } catch { Log-Warn "Could not log the accepted edit: $($_.Exception.Message)" }
}

# A non-transactional change can stop part-way, so it must be safe to run again:
# CREATE INDEX CONCURRENTLY needs IF NOT EXISTS, DROP INDEX CONCURRENTLY needs IF EXISTS.
function Assert-RerunnableNoTx([string]$Id, [string]$FolderPath) {
    $problems = @()
    foreach ($name in 'deploy.sql', 'revert.sql') {
        $p = Join-Path $FolderPath $name
        if (-not (Test-Path $p)) { continue }
        $t = Get-Content $p -Raw -Encoding UTF8
        $t = [regex]::Replace($t, '(?s)/\*.*?\*/', ' ')
        $t = [regex]::Replace($t, '--[^\n]*', ' ')
        foreach ($st in $t.Split(';')) {
            if ($st -match '(?i)\bCREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b' -and $st -notmatch '(?i)\bIF\s+NOT\s+EXISTS\b') { $problems += "${name}: CREATE INDEX CONCURRENTLY without IF NOT EXISTS" }
            if ($st -match '(?i)\bDROP\s+INDEX\s+CONCURRENTLY\b' -and $st -notmatch '(?i)\bIF\s+EXISTS\b') { $problems += "${name}: DROP INDEX CONCURRENTLY without IF EXISTS" }
        }
    }
    if ($problems.Count -gt 0) {
        throw "BLOCKED: $Id runs outside a transaction, so it must be safe to run again after a partial failure: $($problems -join '; ')"
    }
}

# ---------------------------------------------------------------------------
# ROUND-TRIP TEST (dmcr test)
# Every pending change, in order, inside ONE transaction that always ends in ROLLBACK:
# deploy → verify (applied) → revert → verify (reverted) → schema and data must match the
# state before deploy → deploy again so the next change builds on it. Nothing is kept.
# ---------------------------------------------------------------------------
function Get-RtFileSql($cfg, [string]$File) {
    $c = Get-Content $File -Raw -Encoding UTF8
    if ($cfg.Placeholders -and $cfg.Placeholders.Count -gt 0) { $c = Resolve-Placeholders $c $cfg.Placeholders }
    return $c
}

# Prints results; returns $true if every tested change passed.
function Invoke-RoundTripTest($cfg, [string]$StopAtId, [bool]$JsonOut) {
    $helpers = Join-Path $PSScriptRoot 'dmcr_roundtrip.sql'
    if (-not (Test-Path $helpers)) { throw "Missing $helpers" }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('BEGIN;')
    [void]$sb.AppendLine("SET LOCAL lock_timeout = '$($cfg.LockTimeout)';")
    [void]$sb.AppendLine("SET LOCAL statement_timeout = '$($cfg.StmtTimeout)';")
    [void]$sb.AppendLine((Get-Content $helpers -Raw -Encoding UTF8))
    $tested = New-Object System.Collections.Generic.List[string]
    $stoppedId = $null; $stoppedReason = $null
    foreach ($f in @(Get-ChangeFolders $cfg.ChangesDir)) {
        $id = $f.Name
        if (Is-Applied $cfg $id) { continue }
        if ($id -match '(?i)(^|_)danger_') { $stoppedId = $id; $stoppedReason = "manual-only (danger_) change — later changes were not tested"; break }
        if (Test-NoTxChange (Read-MetaJson $f.FullName)) { $stoppedId = $id; $stoppedReason = 'runs outside a transaction ("transaction": false), so it can''t be tested and rolled back — later changes were not tested'; break }
        $guardOk = $true
        try {
            Assert-SafeChange -FolderId $id -FolderPath $f.FullName -Mode 'deploy' *> $null
            foreach ($n in 'deploy.sql', 'revert.sql', 'verify.sql') { Assert-NoTxControl $id (Join-Path $f.FullName $n) *> $null }
        } catch { $guardOk = $false }
        if (-not $guardOk) { $stoppedId = $id; $stoppedReason = 'blocked by the deploy guards (danger rules or transaction control) — run deploy to see why'; break }
        $revertPath = Join-Path $f.FullName 'revert.sql'
        if (-not (Test-Path $revertPath)) { $stoppedId = $id; $stoppedReason = 'has no revert.sql'; break }
        $sid = Escape-SqlLiteral $id
        $deploy = Get-RtFileSql $cfg (Join-Path $f.FullName 'deploy.sql')
        $revert = Get-RtFileSql $cfg $revertPath
        $record = "INSERT INTO dmcr.change_log(change_id, deploy_checksum, environment, actor) VALUES ('$sid', '$(Escape-SqlLiteral (Get-FileChecksum (Join-Path $f.FullName 'deploy.sql')))', '$(Escape-SqlLiteral $cfg.EnvName)', 'dmcr test');"
        $verify = Get-TxVerifySql $cfg (Join-Path $f.FullName 'verify.sql')
        [void]$sb.AppendLine("`n-- ===== $id =====")
        [void]$sb.AppendLine("SELECT pg_temp.dmcr_rt_start('$sid');")
        [void]$sb.AppendLine("SAVEPOINT dmcr_rt_probe;`n$deploy`n;`n$revert`n;`nROLLBACK TO SAVEPOINT dmcr_rt_probe;`nRELEASE SAVEPOINT dmcr_rt_probe;")
        [void]$sb.AppendLine("SELECT pg_temp.dmcr_rt_before('$sid');")
        [void]$sb.AppendLine("$deploy`n;`n$record`n$verify")
        [void]$sb.AppendLine("$revert`n;`nDELETE FROM dmcr.change_log WHERE change_id = '$sid';`n$verify")
        [void]$sb.AppendLine("SELECT pg_temp.dmcr_rt_after('$sid');")
        [void]$sb.AppendLine("$deploy`n;`n$record")
        $tested.Add($id)
        if ($StopAtId -and $id -eq $StopAtId) { break }
    }
    [void]$sb.AppendLine("`nROLLBACK;")

    $status = @{}; $details = @{}; $lastStarted = $null; $rc = 0; $outText = ''
    if ($tested.Count -gt 0) {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dmcr_rt_" + [Guid]::NewGuid().ToString("N") + ".sql")
        try {
            Set-Content -Path $tmp -Value $sb.ToString() -Encoding UTF8
            $out = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args ([string[]]@("-q", "-v", "ON_ERROR_STOP=1", "-X", "-f", $tmp)) -PsqlPath $cfg.PsqlPath 2>&1)
            $rc = $LASTEXITCODE
            $outText = ($out | ForEach-Object { "$_" }) -join "`n"
        } finally {
            if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
        }
    }
    foreach ($line in ($outText -split "`r?`n")) {
        $m = [regex]::Match($line, 'DMCR_RT\|([^|]*)\|([^|]*)\|(.*)$')
        if (-not $m.Success) { continue }
        $rid = $m.Groups[1].Value; $kind = $m.Groups[2].Value; $detail = $m.Groups[3].Value.Trim()
        if (-not $details.ContainsKey($rid)) { $details[$rid] = New-Object System.Collections.Generic.List[string] }
        switch ($kind) {
            'start' { $lastStarted = $rid; $status[$rid] = 'running' }
            'pass'  { $status[$rid] = 'pass'; $details[$rid].Add($detail) }
            'fail'  { $status[$rid] = 'fail'; $details[$rid].Add($detail) }
            'note'  { $details[$rid].Add("note: $detail") }
        }
    }
    if ($rc -ne 0) {
        $em = [regex]::Match($outText, '(?m)(ERROR|FATAL):\s*(.+)$')
        $err = if ($em.Success) { "$($em.Groups[1].Value): $($em.Groups[2].Value.Trim())" } else { 'psql failed' }
        if ($lastStarted) {
            $status[$lastStarted] = 'fail'
            if (-not $details.ContainsKey($lastStarted)) { $details[$lastStarted] = New-Object System.Collections.Generic.List[string] }
            $details[$lastStarted].Add($err)
        } else {
            throw "Round-trip test could not start: $err"
        }
    }

    $allOk = $true
    $results = @()
    foreach ($rid in $tested) {
        $st = if ($status.ContainsKey($rid)) { $status[$rid] } else { 'not_run' }
        if ($st -eq 'running') { $st = 'fail' }
        if ($st -ne 'pass') { $allOk = $false }
        $d = if ($details.ContainsKey($rid)) { @($details[$rid]) } else { @() }
        $results += [ordered]@{ change_id = $rid; status = $st; details = ($d -join "`n") }
    }
    if ($JsonOut) {
        $o = [ordered]@{ status = $(if ($allOk) { 'passed' } else { 'failed' }); changes = @($results) }
        if ($stoppedId) { $o.stopped_at = [ordered]@{ change_id = $stoppedId; reason = $stoppedReason } }
        # Straight to stdout: Write-Output here would become part of this function's return value
        [Console]::Out.WriteLine(($o | ConvertTo-Json -Depth 5))
    } else {
        if ($tested.Count -eq 0) { Log-Info "No pending changes to test" }
        foreach ($r in $results) {
            $lines = @($r.details -split "`n" | Where-Object { $_ })
            if ($r.status -eq 'pass') {
                Log-Done "$($r.change_id) — $(@($lines | Where-Object { $_ -notlike 'note:*' })[0])"
                foreach ($l in ($lines | Where-Object { $_ -like 'note:*' })) { Write-Host "       $l" }
            } else {
                Log-Error "$($r.change_id) — round trip FAILED"
                foreach ($l in $lines) { Write-Host "       $l" }
            }
        }
        if ($stoppedId) { Log-Warn "Stopped at ${stoppedId}: $stoppedReason" }
        Log-Info "Everything above ran in one transaction that was rolled back — the database is unchanged."
    }
    return $allOk
}

function Exec-Psql($cfg, $Sql) {
    Log-Debug "PSQL SQL: $Sql"
    Invoke-DmcrPsql -Conn $cfg.Conn -PsqlPath $cfg.PsqlPath -Args @(
        "-q",
        "-v","ON_ERROR_STOP=1",
        "-X","-P","pager=off",
        "-c","SET lock_timeout = '$($cfg.LockTimeout)'; SET statement_timeout = '$($cfg.StmtTimeout)'; $Sql"
    )
}

function Invoke-DmcrParseSql {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]$cfg,
        [Parameter(Mandatory=$true)][string]$SqlText
    )

    $sql = [string]$SqlText
    $trimmed = $sql.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return @{ ok = $false; msg = "SQL is empty." }
    }
    if ($trimmed.Length -gt 200000) {
        return @{ ok = $false; msg = "SQL is too large (> 200k chars). Split it." }
    }

    # ── Safety: reject SQL that contains explicit transaction control ──────────
    # COMMIT/ROLLBACK/BEGIN inside user SQL would escape or corrupt the wrapper
    # transaction, yielding false-positive "OK" or unhandled errors — exactly
    # the same guard that DBeaver applies before running validation queries.
    $strippedForGuard = Strip-SqlComments $trimmed
    foreach ($guardStmt in ($strippedForGuard -split ';')) {
        $g = $guardStmt.Trim()
        if ([string]::IsNullOrWhiteSpace($g)) { continue }
        if ($g -match '(?i)^\s*(COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION|END)\s*$') {
            $found = ([regex]::Match($g, '(?i)(COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION|END)')).Value.ToUpper()
            return @{ ok = $false; msg = "SQL contains '$found' which would escape the validation transaction. Remove explicit transaction control before validating." }
        }
    }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dmcr_parse_" + [Guid]::NewGuid().ToString("N") + ".sql")
    try {
        $sqlToRun = $trimmed.TrimEnd()

        # Ensure the final SQL statement is terminated before we append ROLLBACK.
        # Without this, input like: "select * from t" becomes "select * from t ROLLBACK".
        # We generally want plain SQL here, but avoid breaking common psql meta endings.
        $endsWithSemicolon = $sqlToRun.EndsWith(";")
        $endsWithPsqlMeta = ($sqlToRun -match '(?im)\\g(exec|set)?\s*$') -or ($sqlToRun -match '(?im)\\\.\s*$')
        if (-not $endsWithSemicolon -and -not $endsWithPsqlMeta) {
            # Put the terminator on its own line so trailing "-- comment" lines don't swallow it.
            $sqlToRun = $sqlToRun + "`r`n;"
        }

        # Run inside a transaction and rollback to avoid persisting changes.
        # Note: sequence increments from nextval() are not rolled back.
        $content = @"
BEGIN;
SET LOCAL lock_timeout = '$($cfg.LockTimeout)';
SET LOCAL statement_timeout = '60s';
$sqlToRun
ROLLBACK;
"@
        Set-Content -Path $tmp -Value $content -Encoding UTF8

        $out = @(Invoke-DmcrPsql -Conn $cfg.Conn -Args @("-X","-q","-v","ON_ERROR_STOP=1","-f",$tmp) -PsqlPath $cfg.PsqlPath 2>&1)
        $text = ($out | Out-String).Trim()

		Log-Debug "parse: LASTEXITCODE=$LASTEXITCODE"
        Log-Debug "parse: raw output start >>>"
        Log-Debug $text
        Log-Debug "parse: raw output end <<<"

        if ($LASTEXITCODE -eq 0) {
            return @{ ok = $true; msg = "Parsed OK." }
        }

        # Best-effort error parsing (ERROR + LINE + caret)
        $msg = $text
        $m1 = [regex]::Match($text, '(?m)^ERROR:\s*(.+)$')
        if ($m1.Success) { $msg = $m1.Groups[1].Value.Trim() }

        $line = $null
        $col  = $null
        $m2 = [regex]::Match($text, '(?m)^LINE\s+(\d+):')
        if ($m2.Success) { $line = [int]$m2.Groups[1].Value }

        $m3 = [regex]::Match($text, '(?m)^\s*(\^)\s*$')
        if ($m3.Success) {
            # column = count of leading whitespace before caret + 1
            $caretLine = ($text -split "`r?`n" | Where-Object { $_ -match '^\s*\^\s*$' } | Select-Object -First 1)
            if ($caretLine -ne $null) {
                $leading = ([regex]::Match($caretLine, '^\s*')).Value
                $col = ($leading.Length + 1)
            }
        }

        if ($line -and $col) {
            return @{ ok = $false; msg = "$msg (line $line, col $col)"; line = $line; column = $col }
        }
        if ($line) {
            return @{ ok = $false; msg = "$msg (line $line)"; line = $line }
        }

        return @{ ok = $false; msg = $msg }
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    }
}

# =========================================================
# DANGEROUS SQL GATE
# =========================================================

# Patterns blocked in deploy.sql (structural destruction or unintended data loss)
$script:DangerDeployOnlyPatterns = @(
    @{ Regex = '(?i)\bDROP\s+TABLE\b';      Label = 'DROP TABLE'      },
    @{ Regex = '(?i)\bDROP\s+SCHEMA\b';     Label = 'DROP SCHEMA'     },
    @{ Regex = '(?i)\bDROP\s+DATABASE\b';   Label = 'DROP DATABASE'   },
    @{ Regex = '(?i)\bDROP\s+FUNCTION\b';   Label = 'DROP FUNCTION'   },
    @{ Regex = '(?i)\bDROP\s+PROCEDURE\b';  Label = 'DROP PROCEDURE'  },
    @{ Regex = '(?i)\bDROP\s+VIEW\b';       Label = 'DROP VIEW'       },
    @{ Regex = '(?i)\bDROP\s+TRIGGER\b';    Label = 'DROP TRIGGER'    },
    @{ Regex = '(?i)\bDROP\s+INDEX\b';      Label = 'DROP INDEX'      },
    @{ Regex = '(?i)\bDROP\s+SEQUENCE\b';   Label = 'DROP SEQUENCE'   },
    @{ Regex = '(?i)\bDROP\s+TYPE\b';       Label = 'DROP TYPE'       },
    @{ Regex = '(?i)\bDROP\s+EXTENSION\b';  Label = 'DROP EXTENSION'  }
)

# Patterns blocked in BOTH deploy.sql and revert.sql (pure irreversible data loss)
$script:DangerAlwaysPatterns = @(
    @{ Regex = '(?i)\bTRUNCATE\b';           Label = 'TRUNCATE'        }
)

# Extra check flags (can be overridden by dmcr_danger.json)
$script:DangerDeleteWithoutWhereEnabled = $true
$script:DangerUpdateWithoutWhereEnabled = $false

# ── Load custom rules from dmcr_danger.json if present in working directory ──
function Load-DangerRulesFromJson {
    # DMCR_DANGER_RULES (set by the VS Code extension) wins, then current directory, then script root
    $candidates = @()
    if ($env:DMCR_DANGER_RULES) { $candidates += $env:DMCR_DANGER_RULES }
    $candidates += (Join-Path (Get-Location) 'dmcr_danger.json')
    $candidates += (Join-Path $PSScriptRoot 'dmcr_danger.json')
    $jsonPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $jsonPath) { return }

    try {
        $json = Get-Content $jsonPath -Raw | ConvertFrom-Json

        if ($null -ne $json.deployOnlyPatterns) {
            $script:DangerDeployOnlyPatterns = @(
                $json.deployOnlyPatterns | Where-Object { $_.enabled -ne $false } | ForEach-Object {
                    @{ Regex = $_.regex; Label = $_.label }
                }
            )
        }

        if ($null -ne $json.alwaysPatterns) {
            $script:DangerAlwaysPatterns = @(
                $json.alwaysPatterns | Where-Object { $_.enabled -ne $false } | ForEach-Object {
                    @{ Regex = $_.regex; Label = $_.label }
                }
            )
        }

        if ($null -ne $json.deleteWithoutWhereEnabled) {
            $script:DangerDeleteWithoutWhereEnabled = [bool]$json.deleteWithoutWhereEnabled
        }
        if ($null -ne $json.updateWithoutWhereEnabled) {
            $script:DangerUpdateWithoutWhereEnabled = [bool]$json.updateWithoutWhereEnabled
        }

        Log-Debug "Loaded danger rules from: $jsonPath"
    } catch {
        Log-Warn "Could not parse dmcr_danger.json at '$jsonPath': $_"
    }
}

# Invoke at startup
Load-DangerRulesFromJson

# Strip SQL comments so patterns inside -- or /* */ don't trigger false positives
# ── verify.sql inside the change transaction ──
# Wrapped in a savepoint that is rolled back, so verify side effects are never kept,
# while an error in verify aborts (and rolls back) the whole deploy / revert.
function Get-TxVerifySql($cfg, [string]$VerifyFile) {
    if (-not (Test-Path $VerifyFile)) { return "" }
    $v = Get-Content -Path $VerifyFile -Raw -Encoding UTF8
    if ($cfg.Placeholders -and $cfg.Placeholders.Count -gt 0) {
        $v = Resolve-Placeholders $v $cfg.Placeholders
    }
    return "`nSAVEPOINT dmcr_verify;`n-- verify.sql`n$v`n;`nROLLBACK TO SAVEPOINT dmcr_verify;`nRELEASE SAVEPOINT dmcr_verify;`n"
}

# ── Refuse change files that would escape the runner's transaction wrapper ──
# COMMIT / BEGIN / END / ROLLBACK (not ROLLBACK TO) / ABORT / START TRANSACTION, or psql
# meta-commands such as \c or \i. Comments, quoted strings and $$-bodies are ignored.
function Assert-NoTxControl([string]$Id, [string]$File) {
    if (-not (Test-Path $File)) { return }
    $sql = Get-Content -Path $File -Raw -Encoding UTF8
    $sql = Strip-SqlComments $sql
    $sql = [regex]::Replace($sql, '\$([A-Za-z_][A-Za-z_0-9]*|)\$[\s\S]*?\$\1\$', ' ')
    $sql = [regex]::Replace($sql, "'(?:[^']|'')*'", "''")
    $name = Split-Path $File -Leaf
    foreach ($line in ($sql -split "`r?`n")) {
        if ($line.TrimStart().StartsWith('\')) {
            throw "BLOCKED: $Id/$name contains the psql meta-command '$($line.Trim())'. Change files run inside a transaction and cannot use psql backslash commands."
        }
    }
    foreach ($stmt in ($sql -split ';')) {
        $t = $stmt.Trim()
        if ($t -match '(?i)^(BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+TO\b))\b') {
            throw "BLOCKED: $Id/$name contains '$($Matches[1].ToUpper())'. DMCR wraps each change in its own transaction; remove explicit transaction control."
        }
    }
}

function Strip-SqlComments([string]$Sql) {
    $s = [regex]::Replace($Sql, '/\*[\s\S]*?\*/', ' ',
             [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $s = [regex]::Replace($s, '--[^\r\n]*', ' ')
    return $s
}

# Returns a list of dangerous operation labels found in the SQL.
# Mode: 'deploy'  -> checks DROP DDL + data-loss patterns
#       'revert'  -> checks data-loss only (DROP TABLE/etc. are expected in reverts)
function Get-DangerousOps([string]$Sql, [string]$Mode) {
    $stripped = Strip-SqlComments $Sql
    $findings = [System.Collections.Generic.List[string]]::new()

    $patterns = $script:DangerAlwaysPatterns
    if ($Mode -eq 'deploy') {
        $patterns = $script:DangerAlwaysPatterns + $script:DangerDeployOnlyPatterns
    }

    foreach ($p in $patterns) {
        if ([regex]::IsMatch($stripped, $p.Regex) -and -not $findings.Contains($p.Label)) {
            $findings.Add($p.Label)
        }
    }

    # DELETE without WHERE  (split on semicolon boundaries for per-statement check)
    foreach ($stmt in ($stripped -split ';')) {
        $s = $stmt.Trim()
        if ($script:DangerDeleteWithoutWhereEnabled -and
            $s -match '(?i)\bDELETE\b' -and $s -match '(?i)\bFROM\b' -and
            $s -notmatch '(?i)\bWHERE\b' -and -not $findings.Contains('DELETE without WHERE')) {
            $findings.Add('DELETE without WHERE')
        }
        if ($script:DangerUpdateWithoutWhereEnabled -and
            $s -match '(?i)\bUPDATE\b' -and $s -match '(?i)\bSET\b' -and
            $s -notmatch '(?i)\bWHERE\b' -and -not $findings.Contains('UPDATE without WHERE')) {
            $findings.Add('UPDATE without WHERE')
        }
    }

    return @($findings)
}

# Gate called before executing any change.
# Throws (blocking execution) if dangerous SQL is found and the folder name does
# Scans for dangerous ops in normal (non-danger_) folders.
# danger_ folders are NEVER executed by DMCR — they are skipped in deploy
# and hard-blocked in revert. The DBA runs them manually against the DB.
#
# Convention:
#   NORMAL:      001_add_users_table        — DMCR deploys/reverts as usual
#   MANUAL-ONLY: 003_danger_truncate_audit  — DMCR skips/blocks; DBA runs by hand
function Assert-SafeChange([string]$FolderId, [string]$FolderPath, [string]$Mode) {
    # danger_ folders are handled upstream (skip in deploy, hard-block in revert).
    if ($FolderId -match '(?i)(^|_)danger_') { return }

    $deploySql = Join-Path $FolderPath 'deploy.sql'
    $revertSql = Join-Path $FolderPath 'revert.sql'

    $allFindings = [System.Collections.Generic.List[string]]::new()

    if ($Mode -eq 'deploy' -and (Test-Path $deploySql)) {
        $sql = Get-Content $deploySql -Raw -Encoding UTF8
        foreach ($op in (Get-DangerousOps $sql -Mode 'deploy')) {
            $allFindings.Add("deploy.sql: $op")
        }
    }

    if ($Mode -eq 'revert' -and (Test-Path $revertSql)) {
        $sql = Get-Content $revertSql -Raw -Encoding UTF8
        foreach ($op in (Get-DangerousOps $sql -Mode 'revert')) {
            $allFindings.Add("revert.sql: $op")
        }
    }

    if ($allFindings.Count -eq 0) { return }

    $findingLines = ($allFindings | ForEach-Object { "  >> $_" }) -join "`n"
    $suggested    = $FolderId -replace '^(\d+_)', '$1danger_'
    throw @"
BLOCKED: Dangerous SQL detected in '$FolderId':
$findingLines

Rename the folder so a DBA can run it manually — DMCR will never execute it:
  Current : $FolderId
  Renamed : $suggested
"@
}

# =========================================================
# LOCKING (file lock + database lock row)
# =========================================================
# The file lock prevents concurrent dmcr runs on the SAME machine.
# A row in dmcr.deploy_lock prevents concurrent runs across machines and users. It is a
# committed row rather than pg_advisory_lock because every psql call is its own session.
# A crashed run leaves the row behind; clear it with `dmcr repair --unlock`.
$script:DbLockHolder   = $null
$script:LockFileStream = $null
$script:LockFilePath   = $null

function Ensure-DeployLockTable($cfg) {
    # Registries created before v1.1.1 have no dmcr.deploy_lock. Create it only when missing,
    # so routine deploys never need CREATE rights on schema dmcr.
    $missing = Exec-PsqlScalar $cfg "SELECT to_regclass('dmcr.deploy_lock') IS NULL;"
    if ($missing -eq 't') {
        Exec-PsqlScalar $cfg "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS dmcr.deploy_lock (lock_id integer PRIMARY KEY DEFAULT 1 CHECK (lock_id = 1), holder text NOT NULL, environment text, acquired_at timestamptz NOT NULL DEFAULT now());" | Out-Null
        Log-Info "Registry upgraded: created dmcr.deploy_lock"
    }
}

function Acquire-AdvisoryLock($cfg) {
    Log-Info "Acquiring lock..."
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # ── File-based lock (same-machine mutual exclusion) ──
    $lockDir = Join-Path ([System.IO.Path]::GetTempPath()) "dmcr_locks"
    if (-not (Test-Path $lockDir)) { New-Item -ItemType Directory -Path $lockDir -Force | Out-Null }
    # Use a hash of the connection string so different databases get different locks
    $connHash = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($cfg.Conn))) -Algorithm SHA256).Hash.Substring(0, 16)
    $lockFile = Join-Path $lockDir "dmcr_$connHash.lock"
    $script:LockFilePath = $lockFile

    try {
        $script:LockFileStream = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        # Write PID + timestamp for diagnostics
        $info = [System.Text.Encoding]::UTF8.GetBytes("PID=$PID at $(Get-Date -Format o)")
        $script:LockFileStream.Write($info, 0, $info.Length)
        $script:LockFileStream.Flush()
    } catch {
        # Before failing, check whether the lock is stale (locking process has exited)
        $stalePid = $null
        try {
            $fileBytes = [System.IO.File]::ReadAllText($lockFile)
            if ($fileBytes -match 'PID=(\d+)') { $stalePid = [int]$Matches[1] }
        } catch { }

        $processStillAlive = $stalePid -and (Get-Process -Id $stalePid -ErrorAction SilentlyContinue)
        if ($stalePid -and (-not $processStillAlive)) {
            Log-Warn "Clearing stale DMCR lock (PID $stalePid no longer running)"
            Remove-Item -Force $lockFile -ErrorAction SilentlyContinue
            try {
                $script:LockFileStream = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
                $info = [System.Text.Encoding]::UTF8.GetBytes("PID=$PID at $(Get-Date -Format o)")
                $script:LockFileStream.Write($info, 0, $info.Length)
                $script:LockFileStream.Flush()
                Log-Info "Lock acquired after clearing stale lock"
            } catch {
                throw "Another DMCR process is running on this machine (lock file: $lockFile). Wait for it to finish or delete the lock file if the process crashed."
            }
        } else {
            throw "Another DMCR process is running on this machine (lock file: $lockFile). Wait for it to finish or delete the lock file if the process crashed."
        }
    }

    # ── Database lock (cross-machine, cross-user) ──
    # A single row in dmcr.deploy_lock. Each psql call is its own session, so a session-level
    # pg advisory lock would be released immediately; a committed row survives between calls.
    $holder = "$(Get-DmcrActor) pid=$PID run=$([guid]::NewGuid().ToString('N').Substring(0, 12))"
    $holderSql = Escape-SqlLiteral $holder
    $envSql = Escape-SqlLiteral $cfg.EnvName
    try {
        Ensure-DeployLockTable $cfg
        $current = Exec-PsqlScalar $cfg @"
INSERT INTO dmcr.deploy_lock(lock_id, holder, environment) VALUES (1, '$holderSql', '$envSql') ON CONFLICT (lock_id) DO NOTHING;
SELECT holder || ' @@ ' || acquired_at::text || ' @@ ' || coalesce(environment, '') FROM dmcr.deploy_lock WHERE lock_id = 1;
"@
    } catch {
        Release-FileLock
        throw "Could not take the DMCR database lock: $($_.Exception.Message)"
    }
    $parts = "$current" -split ' @@ '
    if ($parts[0] -ne $holder) {
        Release-FileLock
        $since = if ($parts.Length -gt 1) { $parts[1] } else { 'unknown time' }
        throw "Another DMCR run holds the database lock ($($parts[0]), since $since). Wait for it to finish. If that run crashed, clear the lock with: dmcr repair --unlock"
    }
    $script:DbLockHolder = $holder

    $sw.Stop()
    Log-Info "Lock acquired in $($sw.ElapsedMilliseconds)ms"

    try {
        Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor, duration_ms)
VALUES ('lock', '*', 'success', 'Lock acquired (file + database)', :'dmcr_env', :'dmcr_actor', :dmcr_ms);
"@ -Vars @{ dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor); dmcr_ms = "$($sw.ElapsedMilliseconds)" } | Out-Null
    } catch { Log-Debug "Could not log lock event: $_" }
}

function Release-FileLock {
    if ($script:LockFileStream) {
        try {
            $script:LockFileStream.Close()
            $script:LockFileStream.Dispose()
        } catch { }
        $script:LockFileStream = $null
        # Delete the lock file so future runs don't find a stale file
        if ($script:LockFilePath) {
            Remove-Item -Force $script:LockFilePath -ErrorAction SilentlyContinue
            $script:LockFilePath = $null
        }
        Log-Debug "File lock released"
    }
}

function Release-AdvisoryLock($cfg) {
    Release-FileLock

    # ── Release the database lock (only if this run holds it) ──
    if (-not $script:DbLockHolder) { return }
    try {
        $holderSql = Escape-SqlLiteral $script:DbLockHolder
        Exec-PsqlScalar $cfg "DELETE FROM dmcr.deploy_lock WHERE lock_id = 1 AND holder = '$holderSql';" | Out-Null
        $script:DbLockHolder = $null
        Log-Debug "Database lock released"

        try {
            Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor)
VALUES ('unlock', '*', 'success', 'Lock released', :'dmcr_env', :'dmcr_actor');
"@ -Vars @{ dmcr_env = $cfg.EnvName; dmcr_actor = (Get-DmcrActor) } | Out-Null
        } catch { Log-Debug "Could not log unlock event: $_" }
    } catch {
        Log-Warn "Could not release the database lock: $($_.Exception.Message). If the next run reports the lock as held, run: dmcr repair --unlock"
    }
}

# =========================================================
# ACTOR / METADATA AUTO-POPULATION
# =========================================================
function Get-DmcrActor {
    if ($env:DMCR_ACTOR) { return $env:DMCR_ACTOR }
    try { return "$([System.Environment]::UserName)@$([System.Environment]::MachineName)" } catch { return "unknown" }
}

function Get-GitCommit($Dir) {
    try {
        Push-Location $Dir
        $sha = (git rev-parse --short HEAD 2>$null)
        if ($LASTEXITCODE -eq 0 -and $sha) { return $sha.Trim() }
    } catch { }
    finally { Pop-Location }
    return $null
}

# =========================================================
# META.JSON SUPPORT
# =========================================================
# Each change folder may contain an optional meta.json:
# {
#   "id": "001_create_users",
#   "requires": ["000_init"],
#   "tags": ["schema", "users"],
#   "ticket": "JIRA-1234",
#   "commit": "abc1234",
#   "author": "jdoe"
# }
function Read-MetaJson($FolderPath) {
    $metaPath = Join-Path $FolderPath "meta.json"
    if (-not (Test-Path $metaPath)) { return $null }
    try {
        $raw = Get-Content $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
        return $raw
    } catch {
        Log-Warn "Could not parse meta.json in $(Split-Path $FolderPath -Leaf): $($_.Exception.Message)"
        return $null
    }
}

# =========================================================
# PLACEHOLDER SUBSTITUTION
# =========================================================
# Replaces ${placeholder_name} tokens in SQL content with values from config [placeholders] section
# and DMCR_PLACEHOLDER_* environment variables.
# Unresolved placeholders cause an error (fail-fast, no silent corruption).
function Resolve-Placeholders([string]$Sql, [hashtable]$Placeholders) {
    if (-not $Placeholders -or $Placeholders.Count -eq 0) { return $Sql }
    $result = $Sql
    foreach ($kv in $Placeholders.GetEnumerator()) {
        $token = '${' + $kv.Key + '}'
        $result = $result.Replace($token, $kv.Value)
    }
    # Check for unresolved placeholders
    $unresolved = [regex]::Matches($result, '\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}')
    if ($unresolved.Count -gt 0) {
        $names = @($unresolved | ForEach-Object { $_.Groups[1].Value }) | Select-Object -Unique
        throw "Unresolved placeholder(s): $($names -join ', '). Define them in [placeholders] section or set DMCR_PLACEHOLDER_<name> env vars."
    }
    return $result
}

# Builds the placeholder dictionary from config [placeholders] section + DMCR_PLACEHOLDER_* env vars.
# Env vars override config values (allow per-environment overrides without editing config).
function Build-Placeholders([hashtable]$Ini) {
    $placeholders = @{}
    # From config [placeholders] section
    if ($Ini.ContainsKey("placeholders")) {
        foreach ($kv in $Ini["placeholders"].GetEnumerator()) {
            $placeholders[$kv.Key] = $kv.Value
        }
    }
    # Override/extend with DMCR_PLACEHOLDER_* environment variables
    foreach ($envVar in (Get-ChildItem Env: | Where-Object { $_.Name -match '^DMCR_PLACEHOLDER_(.+)$' })) {
        $key = $envVar.Name -replace '^DMCR_PLACEHOLDER_', ''
        $placeholders[$key.ToLower()] = $envVar.Value
    }
    return $placeholders
}

# =========================================================
# REPEATABLE MIGRATIONS (R__ prefix)
# =========================================================
# Repeatable migrations are folders starting with R__ (case-insensitive).
# They re-run every time their deploy.sql checksum changes.
# They have NO revert.sql requirement — they are idempotent by design.
# Example: R__user_summary_view, R__audit_triggers
function Get-RepeatableFolders($Dir) {
    if ([string]::IsNullOrWhiteSpace($Dir) -or -not (Test-Path $Dir)) { return @() }
    @(Get-ChildItem $Dir -Directory |
        Where-Object { $_.Name -match '^R__' } |
        Sort-Object Name)
}

# Check if a repeatable migration needs re-running (checksum differs from stored)
function Test-RepeatableNeedsRun($cfg, $FolderPath) {
    $id = Split-Path $FolderPath -Leaf
    $deployFile = Join-Path $FolderPath "deploy.sql"
    if (-not (Test-Path $deployFile)) { return $false }
    $currentChecksum = Get-FileChecksum $deployFile
    $stored = Exec-PsqlScalarSafe $cfg "SELECT last_checksum FROM dmcr.repeatable_log WHERE change_id = :'dmcr_id' LIMIT 1;" -Vars @{ dmcr_id = $id }
    if ([string]::IsNullOrWhiteSpace($stored)) { return $true }  # never applied
    return ($stored -ne $currentChecksum)
}

# =========================================================
# TAG MANAGEMENT
# =========================================================
function Get-TagChangeId($cfg, [string]$TagName) {
    $result = Exec-PsqlScalarSafe $cfg "SELECT change_id FROM dmcr.tags WHERE tag_name = :'dmcr_tag' LIMIT 1;" -Vars @{ dmcr_tag = $TagName }
    if ([string]::IsNullOrWhiteSpace($result)) { return $null }
    return $result
}

# =========================================================
# DEPENDENCY-AWARE PLANNER (TOPOLOGICAL SORT)
# =========================================================
# Reads all change folders and their meta.json to build a dependency graph.
# Falls back to numeric prefix order when no dependencies are declared.
function Build-DependencyPlan($cfg) {
    $folders = @(Get-ChangeFolders $cfg.ChangesDir)
    $graph   = @{}   # id -> @{ Folder; Meta; Requires }
    $order   = [System.Collections.Generic.List[string]]::new()

    foreach ($f in $folders) {
        $id = $f.Name
        $meta = Read-MetaJson $f.FullName
        $requires = @()
        if ($meta -and $meta.requires) { $requires = @($meta.requires) }
        $graph[$id] = @{ Folder = $f; Meta = $meta; Requires = $requires }
    }

    # Kahn's algorithm (topological sort)
    $inDegree = @{}
    $adj      = @{}
    foreach ($id in $graph.Keys) {
        if (-not $inDegree.ContainsKey($id)) { $inDegree[$id] = 0 }
        if (-not $adj.ContainsKey($id)) { $adj[$id] = [System.Collections.Generic.List[string]]::new() }
        foreach ($dep in $graph[$id].Requires) {
            if (-not $graph.ContainsKey($dep)) {
                Log-Warn "Change '$id' requires '$dep' which does not exist as a folder"
                continue
            }
            if (-not $adj.ContainsKey($dep)) { $adj[$dep] = [System.Collections.Generic.List[string]]::new() }
            $adj[$dep].Add($id)
            if (-not $inDegree.ContainsKey($id)) { $inDegree[$id] = 0 }
            $inDegree[$id]++
        }
    }

    $queue = [System.Collections.Queue]::new()
    # Seed with nodes that have no incoming edges, sorted by prefix for determinism
    $seeds = @($inDegree.GetEnumerator() | Where-Object { $_.Value -eq 0 } | ForEach-Object { $_.Key } | Sort-Object)
    foreach ($s in $seeds) { $queue.Enqueue($s) }

    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $order.Add($current)
        if ($adj.ContainsKey($current)) {
            # Sort neighbors for determinism within same dependency level
            $neighbors = @($adj[$current] | Sort-Object)
            foreach ($n in $neighbors) {
                $inDegree[$n]--
                if ($inDegree[$n] -eq 0) { $queue.Enqueue($n) }
            }
        }
    }

    if ($order.Count -ne $graph.Count) {
        $missing = @($graph.Keys | Where-Object { $_ -notin $order }) -join ", "
        throw "Circular dependency detected in change folders: $missing"
    }

    return @{
        Order = $order
        Graph = $graph
    }
}

# =========================================================
# ENHANCED PREFLIGHT CHECKS
# =========================================================
function Invoke-EnhancedPreflight($cfg, $folders) {
    $issues = [System.Collections.Generic.List[string]]::new()

    # 1. Basic file presence check (existing)
    foreach ($f in $folders) {
        $id = $f.Name
        if ($id -match '(?i)(^|_)danger_') { continue }
        foreach ($required in @('deploy.sql', 'verify.sql', 'revert.sql')) {
            $p = Join-Path $f.FullName $required
            if (-not (Test-Path $p)) {
                $issues.Add("MISSING  $id/$required")
            }
        }
    }

    # 2. Duplicate prefix detection
    $prefixes = @{}
    foreach ($f in $folders) {
        $m = [regex]::Match($f.Name, '^(\d{3})_')
        if ($m.Success) {
            $prefix = $m.Groups[1].Value
            if (-not $prefixes.ContainsKey($prefix)) { $prefixes[$prefix] = [System.Collections.Generic.List[string]]::new() }
            $prefixes[$prefix].Add($f.Name)
        }
    }
    foreach ($kv in $prefixes.GetEnumerator()) {
        if ($kv.Value.Count -gt 1) {
            $dupes = $kv.Value -join ", "
            $issues.Add("DUPLICATE PREFIX  $($kv.Key): $dupes")
        }
    }

    # 3. Malformed folder names
    foreach ($f in $folders) {
        if ($f.Name -notmatch '^\d{3}_\w') {
            $issues.Add("MALFORMED  $($f.Name) — expected format: 001_descriptive_name")
        }
    }

    # 4. Prefix gaps
    $nums = @($folders | ForEach-Object {
        $m = [regex]::Match($_.Name, '^(\d{3})_')
        if ($m.Success) { [int]$m.Groups[1].Value }
    } | Sort-Object)
    if ($nums.Count -ge 2) {
        for ($i = 1; $i -lt $nums.Count; $i++) {
            $gap = $nums[$i] - $nums[$i-1]
            if ($gap -gt 1) {
                $issues.Add("GAP  prefix gap between $($nums[$i-1].ToString('000')) and $($nums[$i].ToString('000'))")
            }
        }
    }

    # 5. Dependency validation (meta.json)
    foreach ($f in $folders) {
        $meta = Read-MetaJson $f.FullName
        if ($meta -and $meta.requires) {
            foreach ($dep in $meta.requires) {
                $depExists = $folders | Where-Object { $_.Name -eq $dep }
                if (-not $depExists) {
                    $issues.Add("DEPENDENCY  $($f.Name) requires '$dep' which does not exist")
                }
            }
        }
    }

    return @($issues)
}

# =========================================================
# CORE LOGIC
# =========================================================
function Get-ChangeFolders($Dir) {
    if ([string]::IsNullOrWhiteSpace($Dir)) {
        throw "changes_dir is empty in config"
    }
    if (-not (Test-Path $Dir)) {
        throw "changes_dir not found: $Dir"
    }

    Get-ChildItem $Dir -Directory |
        Where-Object { $_.Name -match '^\d{3}_' } |
        Sort-Object Name
}

# Pre-flight: verify every non-danger_ change folder has the 3 required SQL files.
# Called at the start of `deploy` so structural problems fail fast before any DB writes.
function Invoke-DeployPreflight($folders) {
    $missing = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $folders) {
        $id = $f.Name
        if ($id -match '(?i)(^|_)danger_') { continue }
        foreach ($required in @('deploy.sql', 'verify.sql', 'revert.sql')) {
            $p = Join-Path $f.FullName $required
            if (-not (Test-Path $p)) {
                $missing.Add("  $id/$required")
            }
        }
    }
    if ($missing.Count -gt 0) {
        $list = $missing -join "`n"
        throw "Pre-flight failed — missing required files in change folders:`n$list`n`nAdd these files before deploying."
    }
    Log-Info "Pre-flight OK — all change folders have required files (deploy.sql, verify.sql, revert.sql)"
}

function Is-Applied($cfg, $Id) {
    Log-Debug "CHECK  $Id"
    (Exec-PsqlScalarSafe $cfg "SELECT 1 FROM dmcr.change_log WHERE change_id = :'dmcr_id' LIMIT 1;" -Vars @{ dmcr_id = $Id }) -eq "1"
}

function Last-Applied($cfg) {
    Log-Debug "Resolving last applied change_id"
    Exec-PsqlScalar $cfg "
        SELECT change_id
        FROM dmcr.change_log
        ORDER BY applied_at DESC, change_id DESC
        LIMIT 1;
    "
}

# Record-Applied is no longer a separate function.
# The INSERT into dmcr.change_log is now done inside the same transaction
# as deploy.sql via Exec-PsqlFileTx to guarantee atomicity.

function Verify-Change($cfg, $Id, $Label) {
    $verifyPath = Join-Path (Join-Path $cfg.ChangesDir $Id) "verify.sql"
    Log-Debug "Verify script: $verifyPath (label: $Label)"
    # Verify runs in a BEGIN/ROLLBACK so accidental side effects are never persisted
    Exec-PsqlFileTx-Rollback $cfg $verifyPath
}

function Revert-Change($cfg, $Id) {
    $latest = Last-Applied $cfg
    Log-Debug "Latest applied (from DB): '$latest'"

    if ($latest -ne $Id) {
        throw "Refusing to revert non-latest change. Latest is '$latest'"
    }

    # --- danger_ folders: DMCR never reverts them — DBA must do it manually ---
    if ($Id -match '(?i)(^|_)danger_') {
        throw "BLOCKED: '$Id' is a manual-only (danger_) change. DMCR will not revert it. The DBA must run revert.sql directly against the database."
    }

    $revertSw = [System.Diagnostics.Stopwatch]::StartNew()
    Log-Revert "$Id (revert)"
    $revertPath = Join-Path (Join-Path $cfg.ChangesDir $Id) "revert.sql"
    Log-Debug "Revert script: $revertPath"
    $folderPath = Join-Path $cfg.ChangesDir $Id
    $actor = Get-DmcrActor

    # --- CHECKSUM GUARD: enforce checksum_policy ---
    $deployFile = Join-Path $folderPath "deploy.sql"
    if (Test-Path $deployFile) {
        $storedChecksum = Exec-PsqlScalarSafe $cfg `
            "SELECT deploy_checksum FROM dmcr.change_log WHERE change_id = :'dmcr_id';" `
            -Vars @{ dmcr_id = $Id }
        if (-not [string]::IsNullOrWhiteSpace($storedChecksum)) {
            $currentChecksum = Get-FileChecksum $deployFile
            if ($currentChecksum -ne $storedChecksum) {
                $policy = $cfg.ChecksumPolicy
                switch ($policy) {
                    "block" {
                        throw "BLOCKED: deploy.sql for '$Id' has changed since it was applied (checksum mismatch). Policy='block'. Use 'dmcr repair --checksums' to reconcile."
                    }
                    "repair" {
                        Accept-ChangeChecksums $cfg $Id 'deploy.sql'
                        Log-Warn "deploy.sql for '$Id' was edited after it was applied — accepted (checksum_policy=repair, recorded in dmcr.event_log)"
                    }
                    default {
                        # warn (default)
                        Log-Warn "deploy.sql for '$Id' has changed since it was applied (checksum mismatch). Proceeding with revert — verify the SQL manually."
                    }
                }
            } else {
                Log-Debug "Checksum verified OK for $Id"
            }
        } else {
            Log-Debug "No stored checksum for $Id (deployed before checksum tracking was enabled)"
        }
    }

    try {
        # --- DANGER GATE: block dangerous SQL in normal revert scripts ---
        Assert-SafeChange -FolderId $Id -FolderPath $folderPath -Mode 'revert'
        foreach ($fileName in @('revert.sql', 'verify.sql')) {
            Assert-NoTxControl $Id (Join-Path $folderPath $fileName)
        }

        # --- TRANSACTIONAL: revert.sql + DELETE + verify.sql in ONE transaction ---
        # verify.sql (DMCR guard pattern) asserts the reverted state once the registry row is
        # gone. If it fails, the revert is rolled back instead of being half-reported.
        $safeId = Escape-SqlLiteral $Id
        $deleteSql = "DELETE FROM dmcr.change_log WHERE change_id = '$safeId';"
        if (Test-NoTxChange (Read-MetaJson $folderPath)) {
            Assert-RerunnableNoTx $Id $folderPath
            Log-Warn "$Id reverts OUTSIDE a transaction (meta.json `"transaction`": false)"
            try {
                Exec-PsqlFileNoTx $cfg $revertPath
            }
            catch {
                throw "revert.sql failed. It ran outside a transaction, so earlier statements may have been applied; '$Id' is still recorded as applied. Fix the database or revert.sql and try again. $($_.Exception.Message)"
            }
            try {
                Exec-PsqlSqlTx $cfg ($deleteSql + (Get-TxVerifySql $cfg (Join-Path $folderPath 'verify.sql')))
            }
            catch {
                throw "revert.sql ran, but verify.sql failed, so '$Id' is still recorded as applied. Check the database. $($_.Exception.Message)"
            }
        } else {
        Log-Info "Executing revert.sql + removing record (single transaction)"
        Log-Verify "$Id (inside the revert transaction)"
        try {
            Exec-PsqlFileTx $cfg $revertPath ($deleteSql + (Get-TxVerifySql $cfg (Join-Path $folderPath 'verify.sql')))
        }
        catch {
            throw "revert.sql or verify.sql failed — the revert was rolled back, '$Id' is still applied. $($_.Exception.Message)"
        }
        }

        $revertSw.Stop()

        # --- EVENT LOG (enriched) ---
        Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, environment, actor, duration_ms)
VALUES ('revert', :'dmcr_id', 'success', :'dmcr_env', :'dmcr_actor', :dmcr_ms);
"@ -Vars @{ dmcr_id = $Id; dmcr_env = $cfg.EnvName; dmcr_actor = $actor; dmcr_ms = "$($revertSw.ElapsedMilliseconds)" } | Out-Null

        Log-Done "$Id reverted successfully ($($revertSw.ElapsedMilliseconds)ms)"
    }
    catch {
        $revertSw.Stop()
        Log-Error "Failed to revert ${Id}: $($_.Exception.Message)"

        try {
            Exec-PsqlScalarSafe $cfg @"
INSERT INTO dmcr.event_log(action, change_id, status, message, environment, actor, duration_ms)
VALUES ('revert', :'dmcr_id', 'failure', :'dmcr_msg', :'dmcr_env', :'dmcr_actor', :dmcr_ms);
"@ -Vars @{ dmcr_id = $Id; dmcr_msg = $_.Exception.Message; dmcr_env = $cfg.EnvName; dmcr_actor = $actor; dmcr_ms = "$($revertSw.ElapsedMilliseconds)" } | Out-Null
        } catch {
            Log-Warn "Could not log revert failure event: $($_.Exception.Message)"
        }

        throw
    }
}

function Revert-To($cfg, $Target, [switch]$KeepTarget) {
    if (-not (Is-Applied $cfg $Target)) {
        throw "Target change '$Target' is not applied"
    }

    $maxIterations = 500
    $iteration = 0
    $prevLast = $null

    while ($true) {
        $iteration++
        if ($iteration -gt $maxIterations) {
            throw "Revert-To safety limit reached ($maxIterations iterations). Aborting."
        }

        $last = Last-Applied $cfg
        Log-Debug "Revert-To loop [$iteration]: last='$last' target='$Target'"

        if ([string]::IsNullOrWhiteSpace($last)) {
            throw "No applied changes remain but target '$Target' was not reached."
        }
        if ($KeepTarget -and $last -eq $Target) { break }

        if ($last -eq $prevLast) {
            throw "Revert-To is stuck: last applied is still '$last' after revert attempt. Aborting."
        }
        $prevLast = $last

        Revert-Change $cfg $last
        if ($last -eq $Target) { break }
    }

    if ($KeepTarget) { Log-Done "reverted to $Target (kept applied)" } else { Log-Done "reverted to $Target" }
}

# =========================================================
# SHARED DISPLAY-WIDTH HELPERS  (used by both table renderers)
# =========================================================
function Script:Get-TextElements([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return @() }
    $e = [System.Globalization.StringInfo]::GetTextElementEnumerator($s)
    $elems = @()
    while ($e.MoveNext()) { $elems += $e.Current }
    return $elems
}

function Script:Test-DoubleWidth([string]$elem) {
    foreach ($ch in $elem.ToCharArray()) {
        $code = [int][char]$ch
        if (
            ($code -ge 0x1100 -and $code -le 0x115F) -or
            ($code -ge 0x2329 -and $code -le 0x232A) -or
            ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
            ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
            ($code -ge 0xF900 -and $code -le 0xFAFF) -or
            ($code -ge 0xFE10 -and $code -le 0xFE19) -or
            ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
            ($code -ge 0xFF00 -and $code -le 0xFF60) -or
            ($code -ge 0xFFE0 -and $code -le 0xFFE6) -or
            ($code -ge 0x2600 -and $code -le 0x27BF) -or # misc symbols/dingbats/emoji
            ($code -ge 0xD800 -and $code -le 0xDBFF)     # surrogate => supplementary
        ) { return $true }
    }
    return $false
}

function Script:Get-DisplayWidth([string]$s) {
    if ($null -eq $s) { return 0 }
    $w = 0
    foreach ($elem in (Script:Get-TextElements $s)) {
        # Ignore pure variation selectors / zero-width joiners
        $onlyVsOrZw = $true
        foreach ($ch in $elem.ToCharArray()) {
            $code = [int][char]$ch
            if (-not (($code -ge 0xFE00 -and $code -le 0xFE0F) -or $code -eq 0x200D)) { $onlyVsOrZw = $false; break }
        }
        if ($onlyVsOrZw) { continue }
        if (Script:Test-DoubleWidth $elem) { $w += 2 } else { $w += 1 }
    }
    return $w
}

function BoxedColorTable {
    param (
        [Parameter(Mandatory=$true)]
        [array]$columns,  # Array of @{ Name = "..."; hasEmoji = $true/$false }
        [Parameter(Mandatory=$true)]
        [array]$data      # Array of hashtables/objects where optional colors are provided as <ColumnName>_Color
    )

    # $rows = $data | ForEach-Object { [PSCustomObject]$_ }
    $rows = @($data | ForEach-Object { [PSCustomObject]$_ })
    if (-not $rows -or $rows.Count -eq 0) { return }

    function Resolve-Color([string]$c) {
        if ([string]::IsNullOrWhiteSpace($c)) { return 'Green' }
        $valid = [Enum]::GetNames([System.ConsoleColor])
        if ($valid -contains $c) { return $c } else { return 'Green' }
    }

    # Compute column widths (content display width + 2 padding)
    $widths = @{}
    foreach ($col in $columns) {
        $name = $col.Name
        $max = Script:Get-DisplayWidth $name
        foreach ($row in $rows) {
            $val = $row.$name
            $dw = Script:Get-DisplayWidth ($val -as [string])
            if ($dw -gt $max) { $max = $dw }
        }
        $widths[$name] = $max + 2
    }

    # Borders
    $top = "┌"; $sep = "├"; $bottom = "└"
    for ($i=0; $i -lt $columns.Count; $i++) {
        $w = $widths[$columns[$i].Name]
        $top += ("─" * $w)
        $sep += ("─" * $w)
        $bottom += ("─" * $w)
        if ($i -lt $columns.Count-1) { $top += "┬"; $sep += "┼"; $bottom += "┴" } else { $top += "┐"; $sep += "┤"; $bottom += "┘" }
    }
    Ensure-ConsoleBufferWidth $top.Length
    Write-Host $top -ForegroundColor Yellow

    function Write-HeaderRow() {
        for ($i=0; $i -lt $columns.Count; $i++) {
            $name = $columns[$i].Name
            $cellInner = $widths[$name] - 2
            $disp = Script:Get-DisplayWidth $name
            $pad = $cellInner - $disp
            if ($pad -lt 0) { $pad = 0 }

            Write-Host "│" -NoNewline -ForegroundColor Yellow
            Write-Host " " -NoNewline -ForegroundColor Yellow
            Write-Host $name -NoNewline -ForegroundColor Yellow
            if ($pad -gt 0) { Write-Host (" " * $pad) -NoNewline -ForegroundColor Yellow }
            Write-Host " " -NoNewline -ForegroundColor Yellow
        }
        Write-Host "│" -ForegroundColor Yellow
    }

    function Write-DataRow($row) {
        for ($i=0; $i -lt $columns.Count; $i++) {
            $name = $columns[$i].Name
            $text = ($row.$name -as [string])
            $colorKey = "{0}_Color" -f $name
            $fg = Resolve-Color ($row.$colorKey)

            $cellInner = $widths[$name] - 2
            $disp = Script:Get-DisplayWidth $text
            $pad = $cellInner - $disp
            if ($pad -lt 0) { $pad = 0 }

            Write-Host "│" -NoNewline -ForegroundColor Yellow
            Write-Host " " -NoNewline -ForegroundColor $fg
            Write-Host $text -NoNewline -ForegroundColor $fg
            if ($pad -gt 0) { Write-Host (" " * $pad) -NoNewline -ForegroundColor $fg }
            Write-Host " " -NoNewline -ForegroundColor $fg
        }
        Write-Host "│" -ForegroundColor Yellow
    }

    # Header
    Write-HeaderRow
    Write-Host $sep -ForegroundColor Yellow

    # Data
    for ($r=0; $r -lt $rows.Count; $r++) {
        Write-DataRow -row $rows[$r]
        if ($r -lt $rows.Count - 1) { Write-Host $sep -ForegroundColor Yellow }
    }

    Write-Host $bottom -ForegroundColor Yellow
}

function BoxedColorTableWithTitle {
    param (
        [Parameter(Mandatory=$true)]
        [string]$Title,

        [Parameter(Mandatory=$true)]
        [array]$columns,  # Array of @{ Name = "..."; hasEmoji = $true/$false }

        [Parameter(Mandatory=$true)]
        [array]$data,     # Array of hashtables/objects where optional colors are provided as <ColumnName>_Color

        [string]$TitleColor = "Green",
        [string]$BorderColor = "Yellow",
        [string]$HeaderColor = "Yellow"
    )

    # $rows = $data | ForEach-Object { [PSCustomObject]$_ }
    $rows = @($data | ForEach-Object { [PSCustomObject]$_ })
    if (-not $rows -or $rows.Count -eq 0) { return }

    function Resolve-Color([string]$c, [string]$fallback) {
        if ([string]::IsNullOrWhiteSpace($c)) { return $fallback }
        $valid = [Enum]::GetNames([System.ConsoleColor])
        if ($valid -contains $c) { return $c } else { return $fallback }
    }

    $borderFg = Resolve-Color $BorderColor "Yellow"
    $headerFg = Resolve-Color $HeaderColor "Yellow"
    $titleFg  = Resolve-Color $TitleColor  "Green"

    # Compute column widths (content display width + 2 padding)
    $widths = @{}
    foreach ($col in $columns) {
        $name = $col.Name
        $max = Script:Get-DisplayWidth $name
        foreach ($row in $rows) {
            $val = $row.$name
            $dw = Script:Get-DisplayWidth ($val -as [string])
            if ($dw -gt $max) { $max = $dw }
        }
        $widths[$name] = $max + 2
    }

    # Total inner width for merged title row: sum(widths) + (colCount-1) for the internal separators
    $totalInner = 0
    for ($i=0; $i -lt $columns.Count; $i++) {
        $totalInner += $widths[$columns[$i].Name]
        if ($i -lt $columns.Count-1) { $totalInner += 1 }
    }

    # Borders for merged title row
    $topMerged = "┌" + ("─" * $totalInner) + "┐"
    
    Ensure-ConsoleBufferWidth $topMerged.Length
    # Separator between title row and header row (has column splits)
    $titleToHeader = "├"
    for ($i=0; $i -lt $columns.Count; $i++) {
        $w = $widths[$columns[$i].Name]
        $titleToHeader += ("─" * $w)
        if ($i -lt $columns.Count-1) { $titleToHeader += "┬" } else { $titleToHeader += "┤" }
    }

    # Standard borders (header/data separators)
    $sep = "├"
    $bottom = "└"
    for ($i=0; $i -lt $columns.Count; $i++) {
        $w = $widths[$columns[$i].Name]
        $sep += ("─" * $w)
        $bottom += ("─" * $w)
        if ($i -lt $columns.Count-1) { $sep += "┼"; $bottom += "┴" } else { $sep += "┤"; $bottom += "┘" }
    }

    function Write-TitleRow() {
        $innerTotal = $totalInner

        # Keep 1 space on each side when possible (like your other rows)
        $sideSpaces = 2
        if ($innerTotal -lt 2) { $sideSpaces = 0 }
        $available = $innerTotal - $sideSpaces

        $t = $Title
        if ($available -le 0) {
            $t = ""
        } else {
            $disp = Script:Get-DisplayWidth $t
            if ($disp -gt $available) {
                if ($available -eq 1) {
                    $t = "…"
                } else {
                    while (Script:Get-DisplayWidth $t -gt ($available - 1) -and $t.Length -gt 0) {
                        $t = $t.Substring(0, $t.Length - 1)
                    }
                    $t = $t + "…"
                }
            }
        }

        $disp2 = Script:Get-DisplayWidth $t
        $padTotal = $available - $disp2
        if ($padTotal -lt 0) { $padTotal = 0 }

        $leftPad  = [math]::Floor($padTotal / 2)
        $rightPad = $padTotal - $leftPad

        Write-Host "│" -NoNewline -ForegroundColor $borderFg

        if ($sideSpaces -eq 2) { Write-Host " " -NoNewline -ForegroundColor $titleFg }
        if ($leftPad -gt 0) { Write-Host (" " * $leftPad) -NoNewline -ForegroundColor $titleFg }
        if (-not [string]::IsNullOrEmpty($t)) { Write-Host $t -NoNewline -ForegroundColor $titleFg }
        if ($rightPad -gt 0) { Write-Host (" " * $rightPad) -NoNewline -ForegroundColor $titleFg }
        if ($sideSpaces -eq 2) { Write-Host " " -NoNewline -ForegroundColor $titleFg }

        Write-Host "│" -ForegroundColor $borderFg
    }

    function Write-HeaderRow() {
        for ($i=0; $i -lt $columns.Count; $i++) {
            $name = $columns[$i].Name
            $cellInner = $widths[$name] - 2
            $disp = Script:Get-DisplayWidth $name
            $pad = $cellInner - $disp
            if ($pad -lt 0) { $pad = 0 }

            Write-Host "│" -NoNewline -ForegroundColor $borderFg
            Write-Host " " -NoNewline -ForegroundColor $headerFg
            Write-Host $name -NoNewline -ForegroundColor $headerFg
            if ($pad -gt 0) { Write-Host (" " * $pad) -NoNewline -ForegroundColor $headerFg }
            Write-Host " " -NoNewline -ForegroundColor $headerFg
        }
        Write-Host "│" -ForegroundColor $borderFg
    }

    function Write-DataRow($row) {
        for ($i=0; $i -lt $columns.Count; $i++) {
            $name = $columns[$i].Name
            $text = ($row.$name -as [string])
            $colorKey = "{0}_Color" -f $name
            $fg = Resolve-Color ($row.$colorKey) "Gray"

            $cellInner = $widths[$name] - 2
            $disp = Script:Get-DisplayWidth $text
            $pad = $cellInner - $disp
            if ($pad -lt 0) { $pad = 0 }

            Write-Host "│" -NoNewline -ForegroundColor $borderFg
            Write-Host " " -NoNewline -ForegroundColor $fg
            Write-Host $text -NoNewline -ForegroundColor $fg
            if ($pad -gt 0) { Write-Host (" " * $pad) -NoNewline -ForegroundColor $fg }
            Write-Host " " -NoNewline -ForegroundColor $fg
        }
        Write-Host "│" -ForegroundColor $borderFg
    }

    Write-Host $topMerged -ForegroundColor $borderFg
    Write-TitleRow
    Write-Host $titleToHeader -ForegroundColor $borderFg

    Write-HeaderRow
    Write-Host $sep -ForegroundColor $borderFg

    for ($r=0; $r -lt $rows.Count; $r++) {
        Write-DataRow -row $rows[$r]
        if ($r -lt $rows.Count - 1) { Write-Host $sep -ForegroundColor $borderFg }
    }

    Write-Host $bottom -ForegroundColor $borderFg
}


function Write-Color {
    param (
        [string]$m1,
        [string]$m2,
        [string]$c1,
        [string]$c2
    )

    if ($script:UseAnsi) {
        $esc = $script:ESC
        $a1  = if ($script:AnsiMap.ContainsKey($c1)) { $script:AnsiMap[$c1] } else { '37' }
        $a2  = if ($script:AnsiMap.ContainsKey($c2)) { $script:AnsiMap[$c2] } else { '37' }
        $line = "${esc}[${a1}m${m1}${esc}[0m${esc}[${a2}m${m2}${esc}[0m"
        # In JSON mode stdout must stay clean for JSON.parse() — send logs to stderr instead.
        # stderr is streamed as ANSI progress to the runner terminal, so the user still sees them.
        if ($script:DmcrJsonMode) {
            [Console]::Error.WriteLine($line)
        } else {
            [Console]::WriteLine($line)
        }
    } else {
        Write-Host "$m1" -ForegroundColor $c1 -NoNewline
        Write-Host "$m2" -ForegroundColor $c2
    }
}

function Ensure-ConsoleBufferWidth([int]$Width) {
    try {
        $raw = $Host.UI.RawUI
        if ($null -eq $raw) { return }
        $buf = $raw.BufferSize
        if ($buf.Width -lt $Width) {
            $raw.BufferSize = [Management.Automation.Host.Size]::new($Width, $buf.Height)
        }
    } catch { }
}
# =========================================================
# ENTRY POINT
# =========================================================
# function dmcr {} above defines all command handling but was never invoked at
# script scope — this call (and the surrounding catch) is what actually runs it.
# $ErrorActionPreference = "Stop" (top of file) converts non-terminating cmdlet
# errors into terminating ones; psql (native exe) failures are converted to
# terminating `throw`s explicitly inside Exec-Psql*/Invoke-DmcrPsql call sites,
# so both paths land here on failure. Always write to stderr — never stdout,
# so JSON-mode callers parsing stdout as JSON are never polluted.
try {
    dmcr @args
} catch {
    $errMsg = $_.Exception.Message
    $pos    = $_.InvocationInfo.PositionMessage
    $stk    = $_.ScriptStackTrace
    if ($script:UseAnsi) {
        $esc = $script:ESC
        [Console]::Error.WriteLine("${esc}[91m✗  ${errMsg}${esc}[0m")
        if ($pos) { [Console]::Error.WriteLine("${esc}[93m${pos}${esc}[0m") }
        if ($stk) { [Console]::Error.WriteLine("${esc}[90mStack trace:`n${stk}${esc}[0m") }
    } else {
        [Console]::Error.WriteLine("✗  $errMsg")
        if ($pos) { [Console]::Error.WriteLine($pos) }
        if ($stk) { [Console]::Error.WriteLine("Stack trace:`n$stk") }
    }
    exit 1
}
# =========================================================
# END OF FILE
# =========================================================