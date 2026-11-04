# Tests for ${app_role} per environment and the deploy check for SQL that names one environment's schema or role, in dmcr.ps1.
# Two databases in the dmcr-test-pg container stand in for test and prod. Same scenarios as envnames.sh.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'ework'; $cfgDir = Join-Path $tmp 'ecfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$test = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrenvt'
$prod = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrenvp'
$admin = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
Remove-Item Env:DMCR_CONN, Env:DMCR_PROMOTE_FROM_CONN, Env:DMCR_PLACEHOLDER_APP_ROLE -ErrorAction SilentlyContinue
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
$cfg = Join-Path $cfgDir 'dmcr.cfg'
function Cfg($roleT, $roleP) { "[dmcr]`nenv = test`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n`n[test]`nconn = $test`nschema = zt`n$roleT`n`n[prod]`nconn = $prod`nschema = zr`n$roleP`npromote_from = test`n" | Set-Content -Encoding ASCII $cfg }
Cfg 'app_role = rt' 'app_role = rp'
'{"deployOnlyPatterns":[],"alwaysPatterns":[],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' | Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$script:pass = 0; $script:fail = 0
function Q($conn, [string]$sql) { (docker exec -i $env:DMCR_TEST_PG psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ } }
function Run([string[]]$a) { $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }; return $LASTEXITCODE }
function Has([string]$text) { [bool](@($script:last | Where-Object { $_ -like "*$text*" }).Count) }
function Mk($id, $deploy, $revert, $verify = 'SELECT 1;') {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding UTF8 (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding UTF8 (Join-Path $d 'revert.sql') $revert
}
function Rm-Change($id) { Remove-Item -Recurse -Force (Join-Path $work "changes\$id") }
function Applied($conn) { Q $conn "SELECT coalesce(string_agg(change_id, ',' ORDER BY change_id), '') FROM dmcr.change_log;" }
function Grants($conn) { Q $conn "SELECT coalesce(string_agg(table_schema || '.' || table_name || ':' || grantee, ',' ORDER BY 1), '') FROM (SELECT DISTINCT table_schema, table_name, grantee FROM information_schema.role_table_grants WHERE grantee IN ('rt', 'rp')) g;" }

foreach ($db in 'dmcrenvt', 'dmcrenvp') { Q $admin "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null; Q $admin "CREATE DATABASE $db;" | Out-Null }
Q $admin "DROP ROLE IF EXISTS rt;" | Out-Null; Q $admin "DROP ROLE IF EXISTS rp;" | Out-Null
Q $admin "CREATE ROLE rt;" | Out-Null; Q $admin "CREATE ROLE rp;" | Out-Null

"== a schema made by hand before DMCR sets the database up"
Q $test "CREATE SCHEMA zt;" | Out-Null
Ok (Run @('init')) 0 'init keeps a schema that exists'
Ok (Run @('init', '--env', 'prod')) 0 'init creates the one that does not'
Ok (Q $prod "SELECT to_regnamespace('zr') IS NOT NULL;") 't' 'prod has its schema'

"== one file, each environment's schema and role"
$grantT = 'GRANT SELECT, UPDATE, DELETE ON xx TO ${app_role};'
Mk '001_xx' "CREATE TABLE xx (id int);`n$grantT" "REVOKE ALL ON xx FROM `${app_role};`nDROP TABLE xx;"
Ok (Run @('deploy')) 0 'deploy to test'
Ok (Grants $test) 'zt.xx:rt' 'test: the table in its schema, granted to its role'
Ok (Run @('deploy', '--env', 'prod')) 0 'deploy to prod, the same files'
Ok (Has 'Promotion gate OK') 'True' 'the gate sees identical files'
Ok (Grants $prod) 'zr.xx:rp' 'prod: the table in its schema, granted to its role'

"== a role named in the SQL"
Mk '002_role' "CREATE TABLE r2 (id int);`nGRANT SELECT ON r2 TO rt;" 'DROP TABLE r2;'
Ok (Run @('deploy')) 1 'deploy is refused on test'
Ok (Has 'BLOCKED by environment names (test)') 'True' 'says why'
Ok (Has '002_role/deploy.sql names role rt') 'True' 'names the file and the role'
Ok (Applied $test) '001_xx' 'nothing applied'
Ok (Run @('deploy', '--env', 'prod')) 1 'deploy is refused on prod'
Ok (Run @('deploy', '--env', 'prod', '--dry-run', '--json')) 0 'the preview on prod runs'
Ok (Has '002_role/deploy.sql names role rt') 'True' 'and reports it, whichever environment the role is from'
Ok (Run @('deploy', '--dry-run', '--json')) 0 'the preview runs'
Ok (Has '002_role/deploy.sql names role rt') 'True' 'the preview reports it'
Rm-Change '002_role'
Mk '002_role' 'CREATE TABLE r2 (id int);' 'DROP TABLE r2;' "SELECT has_table_privilege('rt', 'zt.r2', 'SELECT');"
Ok (Run @('deploy')) 1 'a role in a privilege check is refused'
Ok (Has '002_role/verify.sql names role rt') 'True' 'names verify.sql'
Ok (Has '002_role/verify.sql names schema zt') 'False' 'zt.r2 in another string is not read as a name here'
Rm-Change '002_role'

"== a schema named in the SQL"
Mk '002_sch' 'CREATE TABLE zt.s2 (id int);' 'DROP TABLE zt.s2;'
Ok (Run @('deploy')) 1 'deploy is refused'
Ok (Has '002_sch/deploy.sql names schema zt') 'True' 'names the file and the schema'
Ok (Has '002_sch/revert.sql names schema zt') 'True' 'and revert.sql'
Rm-Change '002_sch'
Mk '002_sch' 'CREATE TABLE s2 (id int);' 'DROP TABLE s2;' "SELECT to_regclass('zr.s2');"
Ok (Run @('deploy')) 1 'a schema in to_regclass is refused'
Rm-Change '002_sch'

"== what is not a name of an environment"
Mk '002_ok' "-- moved from zt.old_s2, granted to rt before`nCREATE TABLE s2 (id int);`nINSERT INTO s2 SELECT zr.id FROM xx zr;`nCOMMENT ON TABLE s2 IS 'copy of zt.old_s2 for rt';" 'DROP TABLE s2;'
Ok (Run @('deploy')) 0 'a comment, a string and an alias called zr pass'

"== an environment without an App role"
Cfg 'app_role = rt' ''
Mk '003_g' "CREATE TABLE g3 (id int);`nGRANT SELECT ON g3 TO `${app_role};" "DROP TABLE g3;"
Ok (Run @('deploy')) 0 'test has one'
Ok (Run @('deploy', '--env', 'prod')) 1 'prod has none: refused'
Ok (Has '003_g/deploy.sql uses ${app_role}, and prod has no App role') 'True' 'says what to set'

"== the same role everywhere"
Cfg 'app_role = rt' 'app_role = rt'
Mk '004_same' "CREATE TABLE s4 (id int);`nGRANT SELECT ON s4 TO rt;" 'DROP TABLE s4;'
Ok (Run @('deploy')) 0 'a name that is the same everywhere can stay'

"== app_role in dmcr.cfg"
Cfg 'app_role = rt; drop' 'app_role = rp'
Ok (Run @('status')) 1 'not a plain role name: stops'
Ok (Has "Invalid app_role") 'True' 'and says so'

foreach ($db in 'dmcrenvt', 'dmcrenvp') { Q $admin "DROP DATABASE IF EXISTS $db WITH (FORCE);" | Out-Null }
Q $admin "DROP ROLE IF EXISTS rt;" | Out-Null; Q $admin "DROP ROLE IF EXISTS rp;" | Out-Null
""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
