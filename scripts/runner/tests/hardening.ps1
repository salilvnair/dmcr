# Hardening tests for dmcr.ps1 (Windows PowerShell 5.1): psql meta-commands and transaction control in change
# files, verify.sql and parse; change folder names and ids; dropped / not-for-this-environment changes;
# danger rules; schema and shared-registry checks; credentials and connections; config values; the conflict check
# before a deploy (dmcr_conflicts.cjs, run with the node on PATH).
# psql runs in the test container through psql-shim.ps1, on its own database (dmcrhard). Where a file could make
# psql run a shell command, the test proves the marker file it would create does NOT exist.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'xwork'; $cfgDir = Join-Path $tmp 'xcfg'; $cwdDir = Join-Path $tmp 'xcwd'
Remove-Item -Recurse -Force $work, $cfgDir, $cwdDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir, $cwdDir | Out-Null
$admin = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$conn  = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrhard'
$c     = $env:DMCR_TEST_PG
$shim  = Join-Path $here 'psql-shim.ps1'
Remove-Item Env:DMCR_CONN_ENV, Env:DMCR_PROMOTE_FROM_CONN, Env:DMCR_PLACEHOLDER_SCHEMA, Env:PGSSLMODE, Env:PGPASSWORD -ErrorAction SilentlyContinue
$env:DMCR_PSQL = $shim; $env:DMCR_CONN = $conn; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
$rulesOpen = '{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}'
$rulesOpen | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$cfg = Join-Path $cfgDir 'dmcr.cfg'
function Write-Cfg([string]$envName = 'dev', [string]$extra = '', [string]$dmcrExtra = '') {
    "[dmcr]`nround_trip_check = off`nenv = $envName`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n$dmcrExtra`n`n[$envName]`nconn =`n$extra" | Set-Content -Encoding ASCII $cfg
}
Write-Cfg
$script:pass = 0; $script:fail = 0
function Q([string]$sql, [string]$on = $conn) { (docker exec -i $c psql $on -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ } }
function Run([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }; return $LASTEXITCODE }
# stdout only (JSON)
function RunOut([string[]]$a) { $script:out = (& powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>$null | Out-String); return $LASTEXITCODE }
function Has([string]$text) { [bool](@($script:last | Where-Object { $_.Contains($text) }).Count) }   # literal text
function Json { try { return ($script:out | ConvertFrom-Json) } catch { return $null } }
# A file psql would create through the shell (\! or backticks) inside the container: it must not be there
function Marker([string]$name) {
    docker exec $c sh -c "test -e /tmp/$name || test -e /$name || test -e /var/lib/postgresql/$name" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { 'present' } else { 'absent' }
}
function Mk($id, $deploy, $verify, $revert, $meta) {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $d 'deploy.sql'), $deploy)
    [System.IO.File]::WriteAllText((Join-Path $d 'verify.sql'), $(if ($verify) { $verify } else { 'SELECT 1;' }))
    [System.IO.File]::WriteAllText((Join-Path $d 'revert.sql'), $(if ($revert) { $revert } else { 'SELECT 1;' }))
    if ($meta) { [System.IO.File]::WriteAllText((Join-Path $d 'meta.json'), $meta) }
}
function RmChange($id) { Remove-Item -LiteralPath (Join-Path $work "changes\$id") -Recurse -Force }

docker exec $c sh -c 'rm -f /tmp/hmark_* /hmark_* /var/lib/postgresql/hmark_*' 2>$null | Out-Null
Q 'DROP DATABASE IF EXISTS dmcrhard WITH (FORCE);' $admin | Out-Null
Q 'CREATE DATABASE dmcrhard;' $admin | Out-Null
Run @('init') | Out-Null

"== A1: a psql meta-command anywhere on a line is blocked (nothing reaches psql)"
Mk '001_ok' 'CREATE TABLE public.h_ok (id int);' 'SELECT 1;' 'DROP TABLE public.h_ok;'
Ok (Run @('deploy')) 0 'a plain change deploys'
Mk '002_midline' 'CREATE TABLE public.h2 (id int); \! touch /tmp/hmark_mid'
Ok (Run @('deploy')) 1 'SELECT ...; \! cmd (mid-line) is blocked'
Ok (Has 'contains the psql meta-command') 'True' '  ...with the meta-command message'
Ok (Marker 'hmark_mid') 'absent' '  ...and the shell command never ran'
Ok (Q "SELECT to_regclass('public.h2') IS NULL;") 't' '  ...and nothing of the change ran'
RmChange '002_midline'
Mk '002_backtick' 'SELECT 1; \echo 002_x`touch /tmp/hmark_bt`'
Ok (Run @('deploy')) 1 '\echo with `backticks` is blocked'
Ok (Marker 'hmark_bt') 'absent' '  ...and the backtick command never ran'
RmChange '002_backtick'
Mk '002_ident' 'CREATE TABLE public.h3 (a$x$ int); \! touch /tmp/hmark_id -- $x$'
Ok (Run @('deploy')) 1 'a$x$ (an identifier, not a dollar quote) does not hide \! after it'
Ok (Marker 'hmark_id') 'absent' '  ...and the shell command never ran'
RmChange '002_ident'
Mk '002_estr' "SELECT E'it\'s'; \! touch /tmp/hmark_es -- '"
Ok (Run @('deploy')) 1 "E'it\'s' (escape string) does not hide \! after it"
Ok (Marker 'hmark_es') 'absent' '  ...and the shell command never ran'
RmChange '002_estr'
Mk '002_strings' "CREATE TABLE public.h_str (v text); INSERT INTO public.h_str VALUES ('C:\path\'), (E'a\\b\'c'); CREATE TABLE public.`"we\ird`" (id int);`nDO `$f`$ BEGIN PERFORM 'x\y'; END `$f`$;`nSAVEPOINT s1; ROLLBACK TRANSACTION TO SAVEPOINT s1;" 'SELECT 1;' 'DROP TABLE public.h_str; DROP TABLE public."we\ird";'
Ok (Run @('deploy')) 0 'backslashes inside strings, E-strings, quoted names and dollar bodies (and ROLLBACK TRANSACTION TO) are allowed'

"== A2: transaction control in every spelling"
foreach ($t in @(@('COMMIT WORK;', 'COMMIT'), @('END TRANSACTION;', 'END'), @('ABORT;', 'ABORT'), @("PREPARE TRANSACTION 'h';", 'PREPARE TRANSACTION'), @("COMMIT PREPARED 'h';", 'COMMIT'), @("ROLLBACK PREPARED 'h';", 'ROLLBACK'), @('BEGIN; SELECT 1;', 'BEGIN'))) {
    Mk '003_tx' "CREATE TABLE public.h4 (id int);`n$($t[0])"
    Ok (Run @('deploy')) 1 "$($t[0]) is blocked"
    Ok (Has "contains '$($t[1])'") 'True' "  ...named as $($t[1])"
    RmChange '003_tx'
}
Ok (Q "SELECT to_regclass('public.h4') IS NULL;") 't' 'none of them ran'

"== A3: verify.sql gets the same guard before every verify"
$v1 = Join-Path $work 'changes\001_ok\verify.sql'
[System.IO.File]::WriteAllText($v1, "SELECT 1;`n\! touch /tmp/hmark_v1")
Ok (Run @('verify', '001_ok')) 1 'verify <id> with \! in verify.sql fails'
Ok (Has 'BLOCKED: 001_ok/verify.sql') 'True' '  ...with the BLOCKED message'
Ok (RunOut @('verify', 'all', '--json')) 1 'verify all fails'
$j = Json
Ok ([bool]$j) 'True' '  ...its JSON is valid'
Ok (@($j | Where-Object { $_.change_id -eq '001_ok' -and $_.status -eq 'failed' -and $_.error -like 'BLOCKED*' }).Count) 1 '  ...001_ok failed with BLOCKED'
Ok (@($j | Where-Object { $_.change_id -eq '002_strings' -and $_.status -eq 'ok' }).Count) 1 '  ...the others still verified'
Ok (Run @('verify')) 0 'verify (the last deployment, 002_strings) still passes'
Ok (Marker 'hmark_v1') 'absent' 'the verify shell command never ran'
[System.IO.File]::WriteAllText($v1, "SELECT 1;`nCOMMIT;")
Ok (Run @('verify', '001_ok')) 1 'verify <id> with COMMIT in verify.sql fails'
Ok (Has "contains 'COMMIT'") 'True' '  ...named as COMMIT'
[System.IO.File]::WriteAllText($v1, 'SELECT 1;')
Ok (Run @('verify', '001_ok')) 0 'verify <id> passes again once verify.sql is clean'

"== A4: parse refuses meta-commands and transaction control"
Ok (RunOut @('parse', 'SELECT 1; \! touch /tmp/hmark_p1')) 0 'parse with \! returns a result'
Ok ((Json).ok) 'False' '  ...ok = false'
Ok ([bool]("$((Json).msg)" -like '*psql meta-command*')) 'True' '  ...it names the meta-command'
Ok (Marker 'hmark_p1') 'absent' '  ...and the shell command never ran'
RunOut @('parse', 'SELECT 1 \g') | Out-Null
Ok ((Json).ok) 'False' 'parse refuses a trailing \g'
RunOut @('parse', 'SELECT 1; COMMIT WORK') | Out-Null
Ok ((Json).ok) 'False' 'parse refuses COMMIT WORK'
RunOut @('parse', "SELECT 'a\b' AS x") | Out-Null
Ok ((Json).ok) 'True' 'parse accepts a backslash inside a string'

"== A5: a failed non-transactional deploy never runs a blocked revert.sql"
Mk '003_notx' 'CREATE TABLE public.h5 (id int); SELECT 1/0;' 'SELECT 1;' "DROP TABLE IF EXISTS public.h5;`n\! touch /tmp/hmark_a5" '{"transaction": false}'
Ok (Run @('deploy')) 1 'deploy fails'
Ok (Has 'revert.sql was NOT run') 'True' '  ...and says the cleanup was not run'
Ok (Has 'partially applied') 'True' '  ...that the change may be partially applied'
Ok (Marker 'hmark_a5') 'absent' '  ...and revert.sql never reached psql'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id = '003_notx';") 0 '  ...nothing recorded'
RmChange '003_notx'; Q 'DROP TABLE IF EXISTS public.h5;' | Out-Null

"== A6 / B1: unsafe change folder names are skipped and block deploy, check and plan"
foreach ($n in @('003_x`touch hmark_f1`', '003_$(touch hmark_f2)', "R__bad name")) {
    $d = [System.IO.Path]::Combine($work, 'changes', $n); [void][System.IO.Directory]::CreateDirectory($d)
    [System.IO.File]::WriteAllText((Join-Path $d 'deploy.sql'), 'CREATE TABLE public.h_bad (id int);')
    [System.IO.File]::WriteAllText((Join-Path $d 'verify.sql'), 'SELECT 1;')
    [System.IO.File]::WriteAllText((Join-Path $d 'revert.sql'), 'DROP TABLE public.h_bad;')
}
Ok (Run @('status')) 0 'status still runs'
Ok (Has 'Skipping unsafe change folder name ''003_x`touch hmark_f1`''') 'True' '  ...and warns about the backtick folder'
Ok (@($script:last | Where-Object { $_.Contains('Skipping unsafe change folder name ''003_$(touch hmark_f2)''') }).Count) 1 '  ...about the $(...) folder, once'
Ok (Has "Skipping unsafe change folder name 'R__bad name'") 'True' '  ...and about the R__ folder'
Ok (RunOut @('status', '--json')) 0 'status --json'
Ok (@((Json) | Where-Object { $_.change_id -like '003_*' }).Count) 0 '  ...valid JSON without the unsafe folders'
Ok (Run @('deploy')) 1 'deploy is blocked'
Ok (Has 'BLOCKED: unsafe change folder name') 'True' '  ...with the BLOCKED message'
Ok (Run @('deploy', '--dry-run')) 1 'deploy --dry-run is blocked'
Ok (Run @('check')) 1 'check is blocked'
Ok (Run @('plan')) 1 'plan is blocked'
Ok (Run @('verify', 'all')) 0 'verify all leaves them out'
Ok (Run @('repeatable')) 0 'repeatable leaves the unsafe R__ out'
Ok (Q "SELECT count(*) FROM dmcr.repeatable_log;") 0 '  ...it did not run'
Ok (Marker 'hmark_f1') 'absent' 'the backtick folder name never ran a shell'
Ok (Marker 'hmark_f2') 'absent' 'the $(...) folder name never ran a shell'
Ok (Q "SELECT to_regclass('public.h_bad') IS NULL;") 't' 'no unsafe change ran'
foreach ($n in @('003_x`touch hmark_f1`', '003_$(touch hmark_f2)', "R__bad name")) { RmChange $n }

"== B2: a change id from the command line must be a change folder name"
foreach ($a in @(@('show', '../x'), @('show', '..\001_ok'), @('diff', '../x'), @('manual-script', '../x'), @('verify', '../../etc'), @('revert', '..\x'), @('repair', '--mark-applied', '../x'), @('approve', '../x'), @('test', '--only', '../x'), @('revert', 'to', '../x'))) {
    Ok (Run $a) 1 "$($a -join ' ') is refused"
    Ok (Has 'Not a change id') 'True' '  ...as not a change id'
}

"== C1: repeatables honour dropped and meta.json environments without --release/--project/--kind"
Mk 'R__h_view' 'CREATE OR REPLACE VIEW public.h_v AS SELECT 1 AS x;' 'SELECT 1;' 'DROP VIEW IF EXISTS public.h_v;' '{"environments":["test"]}'
Ok (RunOut @('deploy', '--dry-run', '--json')) 0 'deploy --dry-run'
Ok (@((Json).repeatable | Where-Object { $_ }).Count) 0 '  ...lists no repeatable for dev'
Ok (Run @('deploy')) 0 'plain deploy on dev'
Ok (Has 'R__h_view') 'True' '  ...names the skipped repeatable'
Ok (Q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id = 'R__h_view';") 0 '  ...and does not apply it'
Ok (Run @('repeatable')) 0 'dmcr repeatable'
Ok (Q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id = 'R__h_view';") 0 '  ...does not apply it either'
[System.IO.File]::WriteAllText((Join-Path $work 'changes\R__h_view\meta.json'), '{"status":"dropped"}')
Ok (Run @('repeatable')) 0 'a dropped repeatable'
Ok (Q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id = 'R__h_view';") 0 '  ...is not applied'
[System.IO.File]::WriteAllText((Join-Path $work 'changes\R__h_view\meta.json'), '{"environments":["dev"]}')
Ok (Run @('repeatable')) 0 'once it is for dev'
Ok (Q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id = 'R__h_view';") 1 '  ...repeatable applies it'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE change_id = 'R__h_view' AND action = 'deploy' AND status = 'success';") 1 '  ...with its success event (same transaction)'

"== C2: the round trip leaves out dropped and not-for-this-environment changes"
Mk '003_dropped' 'SELECT 1/0;' 'SELECT 1;' 'SELECT 1;' '{"status":"dropped"}'
Mk '004_elsewhere' 'SELECT 1/0;' 'SELECT 1;' 'SELECT 1;' '{"environments":["test"]}'
Mk '005_rt' 'CREATE TABLE public.h_rt (id int);' "DO `$`$ BEGIN IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '005_rt') <> (to_regclass('public.h_rt') IS NOT NULL) THEN RAISE EXCEPTION 'mismatch'; END IF; END `$`$;" 'DROP TABLE public.h_rt;'
Ok (Run @('test')) 0 'dmcr test passes'
Ok (Has '003_dropped') 'True' '  ...naming the dropped change it left out'
Ok (Has '004_elsewhere') 'True' '  ...and the change for test only'
Ok (RunOut @('test', '--json')) 0 'dmcr test --json'
Ok (@((Json).changes | ForEach-Object { $_.change_id }) -join ',') '005_rt' '  ...tested only 005_rt'
Ok (Run @('deploy')) 0 'deploy skips them too'

"== C3: manual-script and repair --mark-applied refuse a change that does not go here"
Mk '006_danger_drop' 'DROP TABLE public.h_ok;' 'SELECT 1;' 'SELECT 1;' '{"status":"dropped","dropped_reason":"not needed"}'
Ok (Run @('manual-script', '006_danger_drop')) 1 'manual-script of a dropped change'
Ok (Has 'BLOCKED: 006_danger_drop is not going (change not going: not needed)') 'True' '  ...is refused as not going'
Ok (Run @('repair', '--mark-applied', '006_danger_drop')) 1 'repair --mark-applied of a dropped change is refused'
[System.IO.File]::WriteAllText((Join-Path $work 'changes\006_danger_drop\meta.json'), '{"environments":["test"]}')
Ok (Run @('manual-script', '006_danger_drop')) 1 'manual-script of a change for test only'
Ok (Has 'BLOCKED: 006_danger_drop is not for dev (only for test, not dev)') 'True' '  ...is refused as not for dev'
Ok (Run @('repair', '--mark-applied', '006_danger_drop')) 1 'repair --mark-applied of it is refused'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id = '006_danger_drop';") 0 '  ...nothing recorded'

"== H6: duplicate change numbers compare the number (006 and 0006)"
Mk '0006_dup' 'SELECT 1;'
Ok (RunOut @('check', '--json')) 0 'check --json'
Ok (@((Json).issues | Where-Object { $_ -like 'DUPLICATE PREFIX  6:*' }).Count) 1 '  ...reports 006 and 0006 as the same number'
Ok (Run @('deploy')) 1 'deploy refuses them'
RmChange '0006_dup'

"== D1: a dmcr_danger.json in the current directory is ignored"
Remove-Item Env:DMCR_DANGER_RULES
$rulesOpen | Set-Content -Encoding ASCII (Join-Path $cwdDir 'dmcr_danger.json')
Mk '007_drop' 'DROP TABLE public.h_ok;'
Push-Location $cwdDir
Ok (Run @('deploy')) 1 'deploy from a folder with a permissive dmcr_danger.json is still blocked'
Pop-Location
Ok (Has 'DROP TABLE') 'True' '  ...by the DROP TABLE rule next to the script'
Ok (Q "SELECT to_regclass('public.h_ok') IS NOT NULL;") 't' '  ...the table is still there'
RmChange '007_drop'

"== D2: a rule regex that runs too long counts as a match"
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'
'{"deployOnlyPatterns":[{"label":"slow","regex":"(a+)+$"}],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
Mk '007_slow' "SELECT 1 AS $('a' * 40)b;"
Ok (Run @('deploy')) 1 'the deploy is blocked'
Ok (Has 'blocked: rule slow timed out') 'True' '  ...because the rule timed out'
RmChange '007_slow'
$rulesOpen | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES

"== G2: an actor with `$dmcr`$ cannot close the lock's dollar quote"
$env:DMCR_ACTOR = 'evil$dmcr$ x'
Mk '007_actor' 'CREATE TABLE public.h_actor (id int);' 'SELECT 1;' 'DROP TABLE public.h_actor;'
Ok (Run @('deploy')) 0 'deploy with that actor works'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'lock' AND actor = 'evil`$dmcr`$ x';") 1 '  ...and the lock event names it'
Ok (Q 'SELECT count(*) FROM dmcr.deploy_lock;') 0 '  ...the lock is released'
$env:DMCR_ACTOR = 'tester'

"== H4 / H5: revert of a deployment with a missing folder is an error; a revert's event commits with it"
Mk '008_a' 'CREATE TABLE public.h8a (id int);' 'SELECT 1;' 'DROP TABLE public.h8a;'
Mk '009_b' 'CREATE TABLE public.h9b (id int);' 'SELECT 1;' 'DROP TABLE public.h9b;'
Ok (Run @('deploy')) 0 'deploy 008 and 009 in one deployment'
$did = Q "SELECT deploy_id FROM dmcr.change_log WHERE change_id = '009_b';"
Move-Item -LiteralPath (Join-Path $work 'changes\009_b') (Join-Path $tmp 'x009_b_moved') -Force
Ok (Run @('revert', $did)) 1 'revert <deployment> with 009_b''s folder missing'
Ok (Has 'no folder') 'True' '  ...is an error naming the missing folder'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('008_a', '009_b');") 2 '  ...nothing was reverted'
Move-Item -LiteralPath (Join-Path $tmp 'x009_b_moved') (Join-Path $work 'changes\009_b') -Force
Ok (Run @('revert', $did)) 0 'with the folder back, the revert runs'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'revert' AND status = 'success' AND change_id IN ('008_a', '009_b') AND deploy_id IS NOT NULL;") 2 '  ...with one success event per change'
Ok (Run @('deploy')) 0 'deploy 008 and 009 again'

"== F7: a deployment id read back from dmcr.event_log is checked before it goes into SQL"
Q "INSERT INTO dmcr.event_log(action, change_id, status, deploy_id) VALUES ('deploy', 'x', 'success', 'abcdzz'' OR ''1''=''1');" | Out-Null
Ok (Run @('log', 'abcd')) 1 'log <id> with a bad id in the registry'
Ok (Has 'is not one') 'True' '  ...is refused'
Q "DELETE FROM dmcr.event_log WHERE deploy_id LIKE 'abcd%';" | Out-Null

"== I4: a placeholder value with & is put in literally"
Write-Cfg 'dev' '' "`n[placeholders]`ntag = a&b\1"
Mk '010_ph' "CREATE TABLE public.h_ph (v text); INSERT INTO public.h_ph VALUES ('`${tag}');" 'SELECT 1;' 'DROP TABLE public.h_ph;'
Ok (Run @('deploy')) 0 'deploy with the placeholder'
Ok (Q 'SELECT v FROM public.h_ph;') 'a&b\1' '  ...stored exactly'
Write-Cfg

"== G1: lock_timeout / statement_timeout must be durations"
Write-Cfg 'dev' '' ''
(Get-Content $cfg) -replace '^lock_timeout = 5s$', "lock_timeout = 5s'; SELECT pg_sleep(1); --" | Set-Content -Encoding ASCII $cfg
Ok (Run @('status')) 1 "lock_timeout = 5s'; ... is refused"
Ok (Has "Invalid lock_timeout") 'True' '  ...with the message'
Write-Cfg
(Get-Content $cfg) -replace '^statement_timeout = 1min$', 'statement_timeout = forever' | Set-Content -Encoding ASCII $cfg
Ok (Run @('status')) 1 'statement_timeout = forever is refused'
Ok (Has "Invalid statement_timeout 'forever' in dmcr.cfg: use a number with ms, s, min, h or d (like 5s).") 'True' '  ...with the message'
Write-Cfg
(Get-Content $cfg) -replace '^statement_timeout = 1min$', 'statement_timeout = 90 s' | Set-Content -Encoding ASCII $cfg
Ok (Run @('status')) 0 'statement_timeout = 90 s is fine'
Write-Cfg

"== E1 / E2: the schema is lowercased; a missing schema is an error"
Write-Cfg 'dev' 'schema = Hard_Upper'
Ok (Run @('init')) 0 'init with schema Hard_Upper'
Ok (Has "Schema 'Hard_Upper' lowercased to 'hard_upper' (PostgreSQL folds unquoted names)") 'True' '  ...warns that it is lowercased'
Ok (Q "SELECT count(*) FROM pg_namespace WHERE nspname = 'hard_upper';") 1 '  ...and creates hard_upper'
Ok (Run @('status')) 0 'status with the schema'
Write-Cfg 'dev' 'schema = hard_missing'
Ok (Run @('status')) 1 'status with a schema that does not exist'
Ok (Has "Schema 'hard_missing' does not exist on dev. Run dmcr init (DMCR Web: Set up in DMCR Config).") 'True' '  ...says to run init'
Write-Cfg

"== E4: two environments on one database"
Remove-Item Env:DMCR_CONN
"[dmcr]`nround_trip_check = off`nenv = dev`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n`n[dev]`nconn = $conn`n`n[qa]`nconn = $conn" | Set-Content -Encoding ASCII $cfg
Mk '011_e4' 'CREATE TABLE public.h_e4 (id int);' 'SELECT 1;' 'DROP TABLE public.h_e4;'
foreach ($a in @(@('deploy', '--env', 'qa'), @('baseline', '011_e4', '--env', 'qa'), @('revertLast', '--env', 'qa'), @('repeatable', '--env', 'qa'))) {
    Ok (Run $a) 1 "$($a -join ' ') is refused"
    Ok (Has "BLOCKED: this database's DMCR registry already has changes recorded for environment 'dev'. Two environments must not share one database: point 'qa' at its own database.") 'True' '  ...with the shared-registry message'
}
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE environment = 'qa';") 0 '  ...nothing recorded for qa'
Ok (Run @('deploy')) 0 'dev itself still deploys'
$env:DMCR_CONN = $conn; Write-Cfg

"== F3 / F4: DMCR_CONN must be a connection string, and for this environment"
$env:DMCR_CONN = 'hunter2secret'
Ok (Run @('status')) 1 'a bare word as DMCR_CONN is refused'
Ok (Has 'DMCR_CONN is not a connection string (expected postgresql://... or key=value).') 'True' '  ...with the message'
Ok (Has 'hunter2secret') 'False' '  ...without printing it'
$env:DMCR_CONN = $conn; $env:DMCR_CONN_ENV = 'prod'
Ok (Run @('status')) 1 'DMCR_CONN built for prod, run for dev'
Ok (Has "DMCR_CONN was built for environment 'prod', not 'dev'.") 'True' '  ...is refused'
$env:DMCR_CONN_ENV = 'dev'
Ok (Run @('status')) 0 'DMCR_CONN built for dev, run for dev'
Remove-Item Env:DMCR_CONN_ENV

"== F5 / E3: sslmode from dmcr.cfg, standard_conforming_strings on every session"
$envLog = Join-Path $tmp 'xpsql-env.log'; Remove-Item $envLog -ErrorAction SilentlyContinue
$envShim = Join-Path $tmp 'xpsql-env-shim.ps1'
"Add-Content -Path '$envLog' -Value (`"SSL=`$(`$env:PGSSLMODE)|OPTS=`$(`$env:PGOPTIONS)`")`n& '$shim' @args`nexit `$LASTEXITCODE" | Set-Content -Encoding ASCII $envShim
$env:DMCR_PSQL = $envShim
Write-Cfg 'dev' 'sslmode = disable'
Ok (Run @('status')) 0 '[dev] sslmode = disable'
Ok (@(Get-Content $envLog | Where-Object { $_ -like 'SSL=disable|*' }).Count -gt 0) 'True' '  ...psql runs with PGSSLMODE=disable'
Ok (@(Get-Content $envLog | Where-Object { $_ -notlike '*standard_conforming_strings=on*' }).Count) 0 '  ...and every session has standard_conforming_strings=on'
Remove-Item $envLog
$env:DMCR_CONN = "$conn`?sslmode=disable"
Write-Cfg 'dev' 'sslmode = require'
Ok (Run @('status')) 0 'sslmode in the connection string wins'
Ok (@(Get-Content $envLog | Where-Object { $_ -notlike 'SSL=|*' }).Count) 0 '  ...PGSSLMODE is not set'
$env:DMCR_CONN = $conn
Write-Cfg 'prod'
Run @('status') | Out-Null
Ok (@($script:last | Where-Object { $_.Contains("Connection to production environment 'prod' does not require TLS: set sslmode = verify-full (or require) for [prod] in dmcr.cfg.") }).Count) 1 'production without sslmode warns once'
Write-Cfg 'prod' 'sslmode = require'
$env:PGSSLMODE = 'disable'   # the container's server has no TLS; PGSSLMODE set by the caller wins
Run @('status') | Out-Null
Ok (Has 'does not require TLS') 'False' '  ...not when sslmode is set'
Remove-Item Env:PGSSLMODE
$env:DMCR_PSQL = $shim; Write-Cfg

"== F1 / F6: passwords in a URL query or with an empty user, non-ASCII values: never in psql's argv"
docker exec $c psql -U postgres -d dmcrtest -X -q -c 'DROP ROLE IF EXISTS hard_user;' -c "CREATE ROLE hard_user LOGIN SUPERUSER PASSWORD 'p@ss:w rd!';" 2>$null | Out-Null
$ip = (docker exec $c hostname -i).Trim().Split(' ')[0]
$argv = Join-Path $tmp 'xpsql-argv.log'; Remove-Item $argv -ErrorAction SilentlyContinue
$env:DMCR_PSQL_ARGV_LOG = $argv; $env:DMCR_PSQL = Join-Path $here 'psql-shim-spy.ps1'
$env:DMCR_CONN = "postgresql://hard_user@${ip}:5432/dmcrhard?password=p%40ss%3Aw%20rd%21&connect_timeout=5"
Ok (Run @('status')) 0 '?password= in the URL query authenticates'
$env:DMCR_CONN = "postgresql://hard_user@${ip}:5432/dmcrhard?connect_timeout=5&password=p%40ss%3Aw%20rd%21"
Ok (Run @('status')) 0 '&password= in the URL query authenticates'
$env:DMCR_CONN = "postgresql://:p%40ss%3Aw%20rd%21@${ip}:5432/dmcrhard?user=hard_user"
Ok (Run @('status')) 0 'a URL with an empty user (://:pw@host) authenticates'
$lines = @(Get-Content $argv)
Ok (@($lines | Select-String -SimpleMatch -Pattern 'p@ss', 'p%40ss', 'w rd', 'w%20rd', 'password').Count) 0 "the password is never in psql's argv ($($lines.Count) calls)"
Ok ([bool](@($lines | Select-String -SimpleMatch 'connect_timeout=5').Count)) 'True' '  ...the rest of the query is kept'
Remove-Item $argv
$env:DMCR_CONN = $conn
Ok (Run @('tag', 'create', 'hv1', "Caf$([char]0xE9) $([char]0x2713)")) 0 'tag create with a non-ASCII description'
# case-sensitive: a random temp-file name in the log can hold 'caf'
Ok (@(Get-Content $argv -Encoding UTF8 | Select-String -SimpleMatch -CaseSensitive 'Caf').Count) 0 "  ...the value is not on psql's command line"
Ok (Q "SELECT description = 'Caf' || chr(233) || ' ' || chr(10003) FROM dmcr.tags WHERE tag_name = 'hv1';") 't' '  ...and is stored exactly'
Remove-Item Env:DMCR_PSQL_ARGV_LOG; $env:DMCR_PSQL = $shim

docker exec $c psql -U postgres -d dmcrtest -X -q -c 'DROP ROLE IF EXISTS hard_user;' 2>$null | Out-Null

"== J. conflict check: two changes that define the same function, not merged, refuse the deploy (real dmcr_conflicts.cjs)"
# the runner writes UTF-8 when redirected (the message has a U+203A): read it as such
$prevOutEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Remove-Item Env:DMCR_NODE, Env:DMCR_CONFLICTS_JS, Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Cfg
@'
{
  "releases": [ { "id": "R1", "name": "November", "date": "2026-11-20", "status": "planned" } ],
  "projects": [
    { "id": "A", "name": "Project A", "type": "new", "release": "R1", "status": "active" },
    { "id": "B", "name": "Project B", "type": "cr", "release": "R1", "status": "active" }
  ]
}
'@ | Set-Content -Encoding ASCII (Join-Path $work 'changes\releases.json')
$fnA = "CREATE OR REPLACE FUNCTION price_label(p numeric) RETURNS text LANGUAGE sql AS `$`$`n  SELECT p::text || ' EUR'`n`$`$;"
$fnB = "CREATE OR REPLACE FUNCTION price_label(p numeric) RETURNS text LANGUAGE sql AS `$`$`n  SELECT 'EUR ' || p::text`n`$`$;"
$c1 = '012_b_price_label'; $c2 = '013_b_price_label_currency_first'
Mk $c1 $fnA 'SELECT 1;' 'DROP FUNCTION IF EXISTS price_label(numeric);' '{"project":"B","created_by":"anika.rao"}'
Mk $c2 $fnB 'SELECT 1;' 'DROP FUNCTION IF EXISTS price_label(numeric);' '{"project":"B","created_by":"leo.martin"}'
$jMsg = "BLOCKED: 1 conflict between changes not resolved: price_label(numeric) (both added): $c1 (anika.rao) vs $c2 (leo.martin). Merge them in DMCR Web (Releases $([char]0x203A) Conflicts), or add a merge change, then deploy again."
$lockEvents = Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'lock';"
Ok (Run @('deploy')) 1 'deploy is refused'
Ok (Has $jMsg) 'True' '  ...with the conflict message'
Ok (Run @('deploy', '--dry-run')) 1 'deploy --dry-run is refused'
Ok (Has $jMsg) 'True' '  ...with the same message'
Ok (RunOut @('deploy', '--json')) 1 'deploy --json is refused'
$j = Json
Ok ([bool]$j) 'True' '  ...its JSON is valid'
Ok "$($j.status)|$($j.code)|$($j.env)|$(@($j.missing).Count)" 'error|conflicts_unresolved|dev|0' '  ...status error, code conflicts_unresolved, env dev, missing []'
Ok $j.message $jMsg '  ...the message'
Ok (@($j.conflicts).Count) 1 '  ...one conflict'
Ok "$($j.conflicts[0].object)|$($j.conflicts[0].label)|$($j.conflicts[0].ours.change_id)|$($j.conflicts[0].ours.project)|$($j.conflicts[0].ours.created_by)|$($j.conflicts[0].theirs.change_id)|$($j.conflicts[0].theirs.created_by)" "price_label(numeric)|both added|$c1|B|anika.rao|$c2|leo.martin" '  ...the helper''s conflict, as is'
Ok (RunOut @('deploy', '--dry-run', '--json')) 1 'deploy --dry-run --json is refused'
Ok "$((Json).code)" 'conflicts_unresolved' '  ...code conflicts_unresolved'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('$c1', '$c2');") 0 'nothing was recorded'
Ok (Q "SELECT to_regprocedure('public.price_label(numeric)') IS NULL;") 't' '  ...nor applied'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'lock';") $lockEvents '  ...and the lock was never taken'

"== J2: a deploy that applies neither side is not refused"
Mk '014_a_other' 'CREATE TABLE public.h_j14 (id int);' 'SELECT 1;' 'DROP TABLE public.h_j14;' '{"project":"A","created_by":"anika.rao"}'
Ok (Run @('deploy', '--project', 'A')) 0 'deploy --project A goes through'
Ok (Has 'conflict') 'False' '  ...without a conflict message'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('014_a_other', '$c1', '$c2');") 1 '  ...014_a_other only'

"== J3: what the runner passes to the helper (ids in plan order, no R__, ELECTRON_RUN_AS_NODE=1)"
$spyLog = Join-Path $tmp 'xconflicts-spy.log'; Remove-Item $spyLog -ErrorAction SilentlyContinue
$spy = Join-Path $tmp 'xconflicts-spy.cjs'
"require('fs').writeFileSync(process.argv[2] === '--changes' ? $(ConvertTo-Json $spyLog) : 'x', JSON.stringify({ argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE || '', creds: ['PGPASSWORD', 'DMCR_CONN', 'DMCR_PROMOTE_FROM_CONN'].filter(k => k in process.env).join(',') })); process.stdout.write('{`"conflicts`":[]}\n');" | Set-Content -Encoding ASCII $spy
$env:DMCR_CONFLICTS_JS = $spy
$env:PGPASSWORD = 'notforthehelper'; $env:DMCR_PROMOTE_FROM_CONN = 'postgresql://x:notforthehelper@nowhere/x'
Ok (Run @('deploy', '--dry-run')) 0 'with a helper that finds nothing, deploy --dry-run passes'
Remove-Item Env:PGPASSWORD, Env:DMCR_PROMOTE_FROM_CONN
$spyJ = try { Get-Content $spyLog -Raw | ConvertFrom-Json } catch { $null }
Ok "$(@($spyJ.argv) -join ' ')" "--changes $((Get-Item -LiteralPath (Join-Path $work 'changes')).FullName) --ids $c1,$c2" '  ...it got the changes folder and the pending ids in plan order'
Ok "$($spyJ.electron)" '1' '  ...with ELECTRON_RUN_AS_NODE=1'
Ok "$env:ELECTRON_RUN_AS_NODE" '' '  ...for that call only'
Ok "$($spyJ.creds)" '' '  ...and without PGPASSWORD, DMCR_CONN or DMCR_PROMOTE_FROM_CONN'

"== J4: the helper fails, Node.js or the helper is missing"
$bad = Join-Path $tmp 'xconflicts-bad.cjs'
"process.stderr.write('cannot read the changes\nsecond line\n'); process.exit(2);" | Set-Content -Encoding ASCII $bad
$env:DMCR_CONFLICTS_JS = $bad
Ok (Run @('deploy', '--dry-run')) 1 'a helper that exits 2 refuses the deploy (block)'
Ok (Has 'BLOCKED: the conflict check failed: cannot read the changes') 'True' '  ...with its first stderr line'
Ok (Has 'second line') 'False' '  ...only the first'
Ok (RunOut @('deploy', '--json')) 1 'deploy --json with that helper is refused'
$j = Json
Ok "$($j.status)|$($j.code)|$($j.env)|$(@($j.missing).Count)|$(@($j.conflicts).Count)" 'error|conflict_check_failed|dev|0|0' '  ...code conflict_check_failed, missing [], conflicts []'
Ok "$($j.message)" 'BLOCKED: the conflict check failed: cannot read the changes. To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg.' '  ...the message'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('$c1', '$c2');") 0 '  ...nothing applied'
"process.stdout.write('not json');" | Set-Content -Encoding ASCII $bad
Ok (Run @('deploy', '--dry-run')) 1 'a helper that prints no JSON refuses the deploy'
Ok (Has 'BLOCKED: the conflict check failed: no result') 'True' '  ...with no result'
Write-Cfg 'dev' '' 'conflict_check = warn'
Ok (Run @('deploy', '--dry-run')) 0 'with conflict_check = warn the failure only warns'
Ok (Has 'WARNING: the conflict check failed: no result. conflict_check = warn: deploying anyway.') 'True' '  ...with the warning'
Ok (Has 'BLOCKED') 'False' '  ...never BLOCKED'
Ok (RunOut @('deploy', '--dry-run', '--json')) 0 'deploy --dry-run --json in warn mode'
Ok "$((Json).status)" 'dry_run' '  ...stdout is only the dry-run JSON (the warning goes to stderr)'
Write-Cfg
$env:DMCR_CONFLICTS_JS = Join-Path $tmp 'xno-such-helper.cjs'
Ok (Run @('deploy', '--dry-run')) 1 'DMCR_CONFLICTS_JS pointing at a missing file: the deploy is refused'
Ok (@($script:last | Where-Object { $_.Contains('BLOCKED: the conflict check failed: dmcr_conflicts.cjs not found next to the runner (or set DMCR_CONFLICTS_JS). To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg.') }).Count) 1 '  ...with the message, once'
Remove-Item Env:DMCR_CONFLICTS_JS
$noNode = "BLOCKED: the conflict check failed: Node.js not found (put node on PATH or set DMCR_NODE). To deploy without the check, set conflict_check = warn (or off) under [dmcr] in dmcr.cfg."
$env:DMCR_NODE = Join-Path $tmp 'xno-such-node.exe'
Ok (Run @('deploy', '--dry-run')) 1 'DMCR_NODE pointing at a missing file: the dry run is refused'
Ok (@($script:last | Where-Object { $_.Contains($noNode) }).Count) 1 '  ...with the message, once'
$lockEvents = Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'lock';"
Ok (Run @('deploy')) 1 'deploy is refused'
Ok (Has $noNode) 'True' '  ...with the message'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('$c1', '$c2');") 0 '  ...nothing applied'
Ok (Q "SELECT count(*) FROM dmcr.event_log WHERE action = 'lock';") $lockEvents '  ...and the lock was never taken'
Ok (RunOut @('deploy', '--dry-run', '--json')) 1 'deploy --dry-run --json is refused'
$j = Json
Ok "$($j.status)|$($j.code)|$($j.env)|$(@($j.missing).Count)|$(@($j.conflicts).Count)" 'error|conflict_check_failed|dev|0|0' '  ...code conflict_check_failed, missing [], conflicts []'
Ok "$($j.message)" $noNode '  ...the message'
Write-Cfg 'dev' '' 'conflict_check = warn'
Ok (Run @('deploy', '--dry-run')) 0 'conflict_check = warn: the dry run goes on'
Ok (Has 'WARNING: the conflict check failed: Node.js not found (put node on PATH or set DMCR_NODE). conflict_check = warn: deploying anyway.') 'True' '  ...with the warning'
Ok (Has 'BLOCKED') 'False' '  ...never BLOCKED'
Write-Cfg 'dev' '' 'conflict_check = off'
Ok (Run @('deploy', '--dry-run')) 0 'conflict_check = off: no Node.js needed'
Ok (Has 'onflict') 'False' '  ...no output'
Write-Cfg
Remove-Item Env:DMCR_NODE
# no DMCR_NODE and no node on PATH
$prevPath = $env:PATH
$env:PATH = (@($env:PATH -split ';' | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $_ 'node.exe') -PathType Leaf) }) -join ';')
Ok ([bool](Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) 'False' '(no node on that PATH)'
Ok (Run @('deploy', '--dry-run')) 1 'no DMCR_NODE and no node on PATH: refused'
Ok (Has $noNode) 'True' '  ...with the message'
$env:PATH = $prevPath
$env:DMCR_NODE = (Get-Command node -CommandType Application | Select-Object -First 1).Source
Ok (Run @('deploy', '--dry-run')) 1 'DMCR_NODE pointing at node: refused for the conflict again'
Ok (Has $jMsg) 'True' '  ...the conflict message'
Remove-Item Env:DMCR_NODE

"== J5: conflict_check = off / warn / an invalid value"
Write-Cfg 'dev' '' 'conflict_check = maybe'
Ok (Run @('deploy', '--dry-run')) 1 'conflict_check = maybe is refused'
Ok (Has "Invalid conflict_check 'maybe' in dmcr.cfg: use block, warn or off.") 'True' '  ...with the message'
Write-Cfg 'dev' '' 'conflict_check =  WARN '
Ok (Run @('deploy', '--dry-run')) 0 'conflict_check = " WARN " (trimmed, any case) is warn'
Ok (Has 'conflict_check = warn: deploying anyway.') 'True' '  ...it warns'
Write-Cfg 'dev' '' 'conflict_check ='
Ok (Run @('deploy', '--dry-run')) 1 'an empty conflict_check counts as unset (block)'
Write-Cfg 'dev' '' 'conflict_check = off'
Ok (Run @('deploy', '--dry-run')) 0 'conflict_check = off: deploy --dry-run passes'
Ok (Has 'conflict') 'False' '  ...silently'
Write-Cfg 'dev' '' 'conflict_check = warn'
Ok (RunOut @('deploy', '--dry-run', '--json')) 0 'conflict_check = warn: deploy --dry-run --json passes'
Ok "$((Json).status)" 'dry_run' '  ...with the dry-run JSON'
Write-Cfg

"== J6: a merge change resolves it"
$merged = "CREATE OR REPLACE FUNCTION price_label(p numeric) RETURNS text LANGUAGE sql AS `$`$`n  SELECT 'EUR ' || p::text || ' (merged)'`n`$`$;"
Mk '015_b_price_label_merge' $merged "DO `$`$ BEGIN IF price_label(1) <> 'EUR 1 (merged)' THEN RAISE EXCEPTION 'not merged'; END IF; END `$`$;" 'SELECT 1;' "{`"project`":`"B`",`"created_by`":`"anika.rao`",`"requires`":[`"$c1`",`"$c2`"],`"merges`":[{`"key`":`"function:price_label(numeric)`",`"changes`":[`"$c1`",`"$c2`"]}]}"
Ok (Run @('deploy')) 0 'with the merge change the deploy goes through'
Ok (Has 'conflict') 'False' '  ...without a conflict message'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('$c1', '$c2', '015_b_price_label_merge');") 3 '  ...all three applied'
Ok (Q 'SELECT price_label(1);') 'EUR 1 (merged)' '  ...the merged definition is in place'

"== J7: conflict_check = warn deploys a conflict anyway"
$t1 = '016_a_price_tag'; $t2 = '017_b_price_tag'
Mk $t1 "CREATE OR REPLACE FUNCTION price_tag(p numeric) RETURNS text LANGUAGE sql AS `$`$ SELECT 'A' `$`$;" 'SELECT 1;' 'DROP FUNCTION IF EXISTS price_tag(numeric);' '{"project":"A"}'
Mk $t2 "CREATE OR REPLACE FUNCTION price_tag(p numeric) RETURNS text LANGUAGE sql AS `$`$ SELECT 'B' `$`$;" 'SELECT 1;' 'DROP FUNCTION IF EXISTS price_tag(numeric);' '{"project":"B"}'
Ok (Run @('deploy', '--dry-run')) 1 'block (default): refused'
Ok (Has "BLOCKED: 1 conflict between changes not resolved: price_tag(numeric) (both added): $t1 vs $t2. Merge") 'True' '  ...no " (<by>)" without created_by'
Write-Cfg 'dev' '' 'conflict_check = warn'
Ok (Run @('deploy')) 0 'conflict_check = warn: the deploy goes through'
Ok (Has "WARNING: 1 conflict between changes not resolved: price_tag(numeric) (both added): $t1 vs $t2. conflict_check = warn: deploying anyway.") 'True' '  ...with the warning'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('$t1', '$t2');") 2 '  ...both applied'
Write-Cfg
Ok (Run @('deploy')) 0 'once both are applied, block mode has nothing to check'
Write-Cfg 'dev' '' 'conflict_check = maybe'
Ok (Run @('deploy')) 1 'with nothing pending, an invalid conflict_check still refuses the deploy'
Ok (Has "Invalid conflict_check 'maybe' in dmcr.cfg: use block, warn or off.") 'True' '  ...with the message'
Write-Cfg

"== J8: a long id list (over 8000 characters) reaches the helper on stdin"
$longIds = @(for ($n = 100; $n -lt 350; $n++) { "{0}_a_long_change_name_for_the_stdin_check" -f $n })
foreach ($id in $longIds) { Mk $id 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"project":"A","created_by":"anika.rao"}' }
$l1 = '350_b_price_badge'; $l2 = '351_b_price_badge_currency_first'
Mk $l1 "CREATE OR REPLACE FUNCTION price_badge(p numeric) RETURNS text LANGUAGE sql AS `$`$ SELECT 'A' `$`$;" 'SELECT 1;' 'DROP FUNCTION IF EXISTS price_badge(numeric);' '{"project":"B","created_by":"anika.rao"}'
Mk $l2 "CREATE OR REPLACE FUNCTION price_badge(p numeric) RETURNS text LANGUAGE sql AS `$`$ SELECT 'B' `$`$;" 'SELECT 1;' 'DROP FUNCTION IF EXISTS price_badge(numeric);' '{"project":"B","created_by":"leo.martin"}'
Ok ((($longIds + @($l1, $l2)) -join ',').Length -gt 8000) 'True' 'the pending ids are longer than 8000 characters'
Ok (Run @('deploy', '--dry-run')) 1 'deploy --dry-run is refused'
Ok (Has "price_badge(numeric) (both added): $l1 (anika.rao) vs $l2 (leo.martin)") 'True' '  ...the helper saw the last ids of the long list'
foreach ($id in ($longIds + @($l1, $l2))) { Remove-Item -Recurse -Force (Join-Path $work "changes\$id") }
Write-Cfg
try { [Console]::OutputEncoding = $prevOutEnc } catch { }

""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
