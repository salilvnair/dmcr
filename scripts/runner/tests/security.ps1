# PGPASSWORD test for dmcr.ps1 (Windows PowerShell 5.1): password-protected role over TCP, psql argv logged.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp = Join-Path $env:TEMP 'dmcr-runner-tests'
$work = Join-Path $tmp 'swork'; $cfgDir = Join-Path $tmp 'scfg'; $log = Join-Path $tmp 'psql-argv.log'
$env:DMCR_PSQL_ARGV_LOG = $log
Remove-Item -Recurse -Force $work, $cfgDir, $log -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes\001_t'), $cfgDir | Out-Null
"[dmcr]`nenv = dev`nchanges_dir = changes`n`n[dev]`nconn =" | Set-Content -Encoding ASCII (Join-Path $cfgDir 'dmcr.cfg')
Set-Content -Encoding ASCII (Join-Path $work 'changes\001_t\deploy.sql') 'CREATE TABLE public.sec_t (id int);'
Set-Content -Encoding ASCII (Join-Path $work 'changes\001_t\verify.sql') 'SELECT 1;'
Set-Content -Encoding ASCII (Join-Path $work 'changes\001_t\revert.sql') 'DROP TABLE public.sec_t;'
docker exec dmcr-test-pg psql -U postgres -d dmcrtest -X -q -c 'DROP SCHEMA IF EXISTS dmcr CASCADE; DROP TABLE IF EXISTS public.sec_t;' 2>$null | Out-Null
# Password-protected role (scram over TCP); the password has characters that need percent-encoding.
docker exec dmcr-test-pg psql -U postgres -d dmcrtest -X -q -c 'DROP ROLE IF EXISTS app_user;' -c "CREATE ROLE app_user LOGIN PASSWORD 'p@ss:w rd!';" -c 'GRANT ALL ON DATABASE dmcrtest TO app_user; GRANT ALL ON SCHEMA public TO app_user;' 2>$null | Out-Null
$ip = (docker exec dmcr-test-pg hostname -i).Trim().Split(' ')[0]
$env:DMCR_PSQL = Join-Path $here 'psql-shim-spy.ps1'; $env:DMCR_BASE_DIR = $work; Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
$cfg = Join-Path $cfgDir 'dmcr.cfg'
$script:p = 0; $script:f = 0
function Ok($got, $want, $label) { if ("$got" -eq "$want") { "  PASS  $label"; $script:p++ } else { "  FAIL  $label (got '$got')"; $script:f++ } }
function Run([string[]]$a) { & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | Out-Null; return $LASTEXITCODE }

"== URL form (percent-encoded password)"
$env:DMCR_CONN = "postgresql://app_user:p%40ss%3Aw%20rd%21@${ip}:5432/dmcrtest"
Ok (Run @('init')) 0 'init authenticates via PGPASSWORD'
Ok (Run @('deploy')) 0 'deploy authenticates via PGPASSWORD'
$lines = Get-Content $log
Ok (@($lines | Select-String -SimpleMatch -Pattern 'p@ss','p%40ss','w rd','w%20rd').Count) 0 "password never in psql argv ($($lines.Count) psql calls logged)"
Ok ([bool](@($lines | Select-String -SimpleMatch "app_user@$ip").Count)) 'True' 'psql got the password-less URL'
"== key=value form"
Remove-Item $log
$env:DMCR_CONN = "host=$ip port=5432 dbname=dmcrtest user=app_user password='p@ss:w rd!'"
Ok (Run @('revertLast')) 0 'revertLast with key=value conn'
Ok (@(Get-Content $log | Select-String -SimpleMatch -Pattern 'p@ss','password').Count) 0 'password never in psql argv'
"== wrong password still fails"
$env:DMCR_CONN = "postgresql://app_user:wrong@${ip}:5432/dmcrtest"
Ok (Run @('status')) 1 'wrong password rejected'
"== PGPASSWORD restored after each call (not left in the runner's own env)"
Ok ([string]::IsNullOrEmpty($env:PGPASSWORD)) 'True' 'caller environment untouched'
""; "RESULT: $script:p passed, $script:f failed"
if ($script:f -gt 0) { exit 1 }
