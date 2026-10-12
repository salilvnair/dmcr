import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { exactRoutineRevert, splitTopLevelStatements } from '../../src/forms/utils/sql-utils';

const V2 = `CREATE OR REPLACE FUNCTION \${schema}.zap_score(p_zap_id bigint)
RETURNS numeric
LANGUAGE sql
STABLE
AS $zap_score$
    SELECT 1::numeric; -- a semicolon inside the body
$zap_score$;`;
const HOTFIX = `-- Hotfix: only finished runs count.
CREATE OR REPLACE FUNCTION \${schema}.zap_score(p_zap_id bigint)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
    SELECT 2::numeric;
$function$;`;

test('a Freeform change that only replaces a routine reverts to its Previous version word for word', () => {
  const r = exactRoutineRevert(HOTFIX, V2);
  assert.ok(r, 'exact revert produced');
  assert.ok(r!.includes(V2), 'previous definition verbatim');
  assert.match(r!, /^-- Revert: put back the previous definition of \$\{schema\}\.zap_score\(p_zap_id bigint\)/);
});

test('no exact revert when the change does more, or Previous version is another routine', () => {
  assert.equal(exactRoutineRevert(HOTFIX + '\nGRANT EXECUTE ON FUNCTION ${schema}.zap_score(bigint) TO app_rw;', V2), null);
  assert.equal(exactRoutineRevert(HOTFIX, V2.replace('zap_score(p_zap_id bigint)', 'zap_rank(p_zap_id bigint)')), null);
  assert.equal(exactRoutineRevert(HOTFIX, ''), null);
  assert.equal(exactRoutineRevert('UPDATE ${schema}.zaps SET status = 1 WHERE id = 1;', V2), null);
});

test('statements split on top-level semicolons only', () => {
  assert.equal(splitTopLevelStatements(V2).length, 1);
  assert.equal(splitTopLevelStatements("SELECT ';'; SELECT 2; -- x;\n/* ; */").length, 2);
});
