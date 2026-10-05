# High-severity fix tests for dmcr.ps1 (Windows PowerShell 5.1, psql via psql-shim.ps1 -> container).
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent $here) 'dmcr.ps1'
$tmp    = Join-Path $env:TEMP 'dmcr-runner-tests'
$work   = Join-Path $tmp 'hwork'; $cfgDir = Join-Path $tmp 'hcfg'
Remove-Item -Recurse -Force $work, $cfgDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'changes'), $cfgDir | Out-Null
$conn = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest'
$env:DMCR_PSQL = Join-Path $here 'psql-shim.ps1'; $env:DMCR_CONN = $conn; $env:DMCR_BASE_DIR = $work
$env:DMCR_DANGER_RULES = Join-Path $cfgDir 'dmcr_danger.json'; $env:DMCR_ACTOR = 'tester'
"[dmcr]`nenv = dev`nchanges_dir = changes`nlock_timeout = 5s`nstatement_timeout = 1min`n`n[dev]`nconn =" | Set-Content -Encoding ASCII (Join-Path $cfgDir 'dmcr.cfg')
'{"deployOnlyPatterns":[{"label":"DROP TABLE","regex":"(?i)\\bDROP\\s+TABLE\\b","scope":"deployOnly"},{"label":"GRANT ALL","regex":"(?i)\\bGRANT\\s+ALL\\b","scope":"deployOnly"}],"alwaysPatterns":[{"label":"TRUNCATE","regex":"(?i)\\bTRUNCATE\\b","scope":"always"}],"deleteWithoutWhereEnabled":true,"updateWithoutWhereEnabled":false}' |
    Set-Content -Encoding ASCII $env:DMCR_DANGER_RULES
$cfg = Join-Path $cfgDir 'dmcr.cfg'
$script:pass = 0; $script:fail = 0
function Q([string]$sql) { (docker exec -i dmcr-test-pg psql $conn -X -t -A -c $sql | Out-String).Trim() }
function Ok($got, $want, $label) {
    if ("$got" -eq "$want") { "  PASS  $label"; $script:pass++ } else { "  FAIL  $label  (got '$got', want '$want')"; $script:fail++ }
}
function Run([string[]]$a) {
    $script:last = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -c $cfg @a 2>&1 | ForEach-Object { "$_" }
    return $LASTEXITCODE
}
function Show { $script:last | Select-String -Pattern 'BLOCKED|requires|rolled back|does not match|Circular' | Select-Object -First 2 | ForEach-Object { "        $($_.Line.Trim())" } }
function Guard($id, $tbl) {
@"
DO `$`$ BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '$id') THEN
    IF to_regclass('$tbl') IS NULL THEN RAISE EXCEPTION 'applied but $tbl missing'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '$id') THEN
    IF to_regclass('$tbl') IS NOT NULL THEN RAISE EXCEPTION 'reverted but $tbl still exists'; END IF;
  END IF;
END `$`$;
"@
}
function Mk($id, $deploy, $verify, $revert, $meta) {
    $d = Join-Path $work "changes\$id"; New-Item -ItemType Directory -Force $d | Out-Null
    Set-Content -Encoding ASCII (Join-Path $d 'deploy.sql') $deploy
    Set-Content -Encoding ASCII (Join-Path $d 'verify.sql') $verify
    Set-Content -Encoding ASCII (Join-Path $d 'revert.sql') $revert
    if ($meta) { Set-Content -Encoding ASCII (Join-Path $d 'meta.json') $meta }
}
function RmChange($id) { Remove-Item -Recurse -Force (Join-Path $work "changes\$id") }

Q "DROP SCHEMA IF EXISTS dmcr CASCADE; DROP TABLE IF EXISTS public.fk_items, public.widgets, public.gadgets, public.verify_side_effect, public.r_items CASCADE; DROP VIEW IF EXISTS public.v_items;" | Out-Null
Run @('init') | Out-Null

"== verify inside the deploy transaction"
Mk '001_create_widgets' 'CREATE TABLE public.widgets (id int);' ((Guard '001_create_widgets' 'public.widgets') + "`nCREATE TABLE public.verify_side_effect (x int);") 'DROP TABLE public.widgets;'
Ok (Run @('deploy')) 0 'deploy 001 (guard verify) succeeds'
Ok (Q "SELECT to_regclass('public.verify_side_effect') IS NULL;") 't' 'verify side effects are rolled back (savepoint)'
Mk '002_bad_verify' 'CREATE TABLE public.gadgets (id int);' 'DO $$ BEGIN RAISE EXCEPTION ''verify says no''; END $$;' 'DROP TABLE public.gadgets;'
Ok (Run @('deploy')) 1 'deploy with failing verify exits 1'; Show
Ok (Q "SELECT to_regclass('public.gadgets') IS NULL;") 't' 'failing verify rolled back deploy.sql'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id='002_bad_verify';") '0' 'no registry row for 002'
Ok (Q "SELECT count(*) FROM dmcr.deploy_lock;") '0' 'lock released after failure'
RmChange '002_bad_verify'

"== transaction-control guard"
Mk '002_commit_inside' 'CREATE TABLE public.gadgets (id int); COMMIT;' 'SELECT 1;' 'DROP TABLE public.gadgets;'
Ok (Run @('deploy')) 1 'COMMIT inside deploy.sql is blocked'; Show
RmChange '002_commit_inside'
Mk '002_psql_meta' "\c otherdb`nCREATE TABLE public.gadgets (id int);" 'SELECT 1;' 'DROP TABLE public.gadgets;'
Ok (Run @('deploy')) 1 'psql \c meta-command is blocked'; Show
RmChange '002_psql_meta'
Mk '002_create_gadgets' "-- don't worry: plpgsql BEGIN/END and ROLLBACK TO are fine`nCREATE TABLE public.gadgets (id int);`nDO `$fn`$ BEGIN PERFORM 1; END `$fn`$;`nSAVEPOINT s1; INSERT INTO public.gadgets VALUES (1); ROLLBACK TO SAVEPOINT s1;" (Guard '002_create_gadgets' 'public.gadgets') 'DROP TABLE public.gadgets;'
Ok (Run @('deploy')) 0 'DO $fn$ BEGIN..END and ROLLBACK TO SAVEPOINT are allowed'

"== requires + cycles"
Mk '003_needs_later' 'SELECT 1;' 'SELECT 1;' 'SELECT 1;' '{"requires":["004_later"]}'
Mk '004_later' 'SELECT 1;' 'SELECT 1;' 'SELECT 1;'
Ok (Run @('deploy')) 1 'change requiring a not-yet-applied change fails'; Show
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id IN ('003_needs_later','004_later');") '0' 'nothing applied out of order'
Set-Content -Encoding ASCII (Join-Path $work 'changes\004_later\meta.json') '{"requires":["003_needs_later"]}'
Ok (Run @('deploy')) 1 'dependency cycle blocks deploy'; Show
RmChange '003_needs_later'; RmChange '004_later'

"== --to validation"
Ok (Run @('deploy','--to','999_nope')) 1 'unknown --to target is rejected'; Show

"== danger rules"
Mk '003_delete_mixed' 'DELETE FROM public.widgets WHERE id = 1; DELETE FROM public.widgets;' 'SELECT 1;' 'SELECT 1;'
Ok (Run @('deploy')) 1 'second DELETE without WHERE is caught per statement'; Show
RmChange '003_delete_mixed'
Mk '003_fk_cascade' 'CREATE TABLE public.fk_items (id int PRIMARY KEY, w int REFERENCES public.fk_items(id) ON DELETE CASCADE); GRANT DELETE ON public.fk_items TO PUBLIC; REVOKE DELETE ON public.fk_items FROM PUBLIC; INSERT INTO public.fk_items VALUES (1, NULL) ON CONFLICT (id) DO UPDATE SET w = NULL;' (Guard '003_fk_cascade' 'public.fk_items') 'REVOKE ALL ON public.fk_items FROM PUBLIC; DROP TABLE public.fk_items;'
Ok (Run @('deploy')) 0 'ON DELETE CASCADE, GRANT/REVOKE DELETE and DO UPDATE SET are not deletes'; Show
Ok (Run @('revert', '003_fk_cascade')) 0 'its revert (REVOKE ... FROM) runs too'; Show
RmChange '003_fk_cascade'
Mk '003_add_col' 'ALTER TABLE public.widgets ADD COLUMN name text;' 'SELECT 1;' 'ALTER TABLE public.widgets DROP COLUMN name;' '{"requires":["001_create_widgets"],"ticket":"ZAP-1"}'
Ok (Run @('deploy')) 0 'valid change with satisfied requires deploys'

"== revert inside one transaction"
Ok (Run @('tag','create','v2')) 0 'tag v2 at 003'
Mk '004_create_r' 'CREATE TABLE public.r_items (id int);' (Guard '004_create_r' 'public.r_items') 'DROP TABLE public.r_items;'
Mk '005_bad_revert' 'CREATE VIEW public.v_items AS SELECT 1 AS x;' (Guard '005_bad_revert' 'public.v_items') 'SELECT 1; -- forgets to drop the view'
Ok (Run @('deploy')) 0 'deploy 004, 005'
Ok (Run @('revertLast')) 1 'revert whose verify fails exits 1'; Show
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id='005_bad_revert';") '1' 'failed revert rolled back: 005 still applied'
Set-Content -Encoding ASCII (Join-Path $work 'changes\005_bad_revert\revert.sql') 'DROP VIEW public.v_items;'
Ok (Run @('revertLast')) 0 'fixed revert succeeds (verify passes inside tx)'
Ok (Q "SELECT to_regclass('public.v_items') IS NULL;") 't' 'view dropped'

"== revert to @tag keeps the tagged change"
Ok (Run @('revert','to','@v2')) 0 'revert to @v2'
Ok (Q "SELECT string_agg(change_id, ',' ORDER BY change_id) FROM dmcr.change_log;") '001_create_widgets,002_create_gadgets,003_add_col' 'state is exactly the tag (003 kept)'
Ok (Run @('revert','to','003_add_col')) 0 'revert to <id> still includes the target'
Ok (Q "SELECT count(*) FROM dmcr.change_log WHERE change_id='003_add_col';") '0' '003 reverted'

"== repeatable: failed verify does not record checksum"
$rd = Join-Path $work 'changes\R__items_view'; New-Item -ItemType Directory -Force $rd | Out-Null
Set-Content -Encoding ASCII (Join-Path $rd 'deploy.sql') 'CREATE OR REPLACE VIEW public.v_items AS SELECT 2 AS x;'
Set-Content -Encoding ASCII (Join-Path $rd 'verify.sql') 'DO $$ BEGIN RAISE EXCEPTION ''nope''; END $$;'
Run @('repeatable') | Out-Null
Ok (Q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__items_view';") '0' 'checksum not recorded'
Ok (Q "SELECT to_regclass('public.v_items') IS NULL;") 't' 'repeatable deploy.sql rolled back'
Set-Content -Encoding ASCII (Join-Path $rd 'verify.sql') 'SELECT 1;'
Ok (Run @('repeatable')) 0 'repeatable with passing verify'
Ok (Q "SELECT count(*) FROM dmcr.repeatable_log WHERE change_id='R__items_view';") '1' 'checksum recorded'
Ok (Q "SELECT count(*) FROM dmcr.deploy_lock;") '0' 'no lock left behind'

"== verify all: superseded vs failed"
# fresh registry and folder: earlier sections leave pending changes behind
Q "DROP SCHEMA dmcr CASCADE; DROP TABLE IF EXISTS public.sup_items, public.sup_other;" | Out-Null
Remove-Item -Recurse -Force (Join-Path $work 'changes\*'); Run @('init') | Out-Null
Mk '001_sup_items_seed' 'CREATE TABLE public.sup_items (id int); INSERT INTO public.sup_items VALUES (1), (2);' `
   'DO $$ BEGIN IF (SELECT count(*) FROM public.sup_items) <> 2 THEN RAISE EXCEPTION ''expected 2 rows''; END IF; END $$;' `
   'DROP TABLE public.sup_items;'
Mk '002_sup_items_more' 'INSERT INTO public.sup_items VALUES (3);' 'SELECT 1;' 'DELETE FROM public.sup_items WHERE id = 3;'
Mk '003_sup_other' 'CREATE TABLE public.sup_other (id int);' (Guard '003_sup_other' 'public.sup_other') 'DROP TABLE IF EXISTS public.sup_other;'
Ok (Run @('deploy')) 0 'deploy 001-003'
Q "DROP TABLE public.sup_other;" | Out-Null   # drift: a real failure, no later change wrote it
function LastJson { $t = $script:last -join "`n"; (ConvertFrom-Json $t.Substring($t.IndexOf("`n[") + 1)) | ForEach-Object { $_ } }  # PS 5.1 emits a JSON array as one item
Run @('verify', 'all', '--json') | Out-Null
$v = @(LastJson)
$s = @($v | Where-Object { $_.status -eq 'superseded' })
Ok "$($s.change_id)|$($s.superseded_by -join ';')" '001_sup_items_seed|002_sup_items_more (public.sup_items)' 'seed rewritten by a later change is superseded (names the change and object)'
Ok (@($v | Where-Object { $_.status -eq 'failed' }).change_id -join ',') '003_sup_other' 'verify broken by drift is still failed'

"== tag list marks a tag whose change was reverted"
Ok (Run @('tag', 'create', 't_sup')) 0 'tag 003'
Ok (Run @('revert', '003_sup_other')) 0 'revert 003'
Run @('tag', 'list', '--json') | Out-Null
$t = @(LastJson) | Where-Object { $_.tag_name -eq 't_sup' }
Ok "$($t.change_id)|$($t.applied)" '003_sup_other|False' 'tag list: applied=false after revert'
""; "RESULT: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
