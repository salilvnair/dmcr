import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { verifyHasElseBranch } from '../../src/forms/llm/generation/verify-rules';

const guard = (applied: string, reverted: string) => `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
    ${applied}
  END IF;
  IF NOT EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
    ${reverted}
  END IF;
END $$;`;

test('an IF … ELSE branch is not allowed', () => {
  const v = `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '__DMCR_CHANGE_ID__') THEN
      PERFORM 1;
    ELSE
      PERFORM 2;
    END IF;
  END $$;`;
  assert.equal(verifyHasElseBranch(v), true);
});

test('CASE … ELSE … END expressions are fine', () => {
  const applied = `IF shop.fn_price(100, 'premium') <> CASE 'premium' WHEN 'premium' THEN 118.00 ELSE 112.00 END THEN
      RAISE EXCEPTION 'v2 not applied';
    END IF;`;
  const reverted = `IF (SELECT CASE WHEN count(*) = 0 THEN 'none' ELSE 'some' END FROM shop.t) <> 'none' THEN
      RAISE EXCEPTION 'rows left';
    END IF;`;
  assert.equal(verifyHasElseBranch(guard(applied, reverted)), false);
});

test('nested CASE expressions, and ELSE inside strings or comments', () => {
  const applied = `PERFORM CASE WHEN a THEN CASE WHEN b THEN 1 ELSE 2 END ELSE 3 END; -- ELSE in a comment
    RAISE NOTICE 'IF … ELSE in a string';`;
  assert.equal(verifyHasElseBranch(guard(applied, 'PERFORM 1;')), false);
});

test('a CASE statement with ELSE inside still counts as a branch', () => {
  // CASE … END CASE is control flow in PL/pgSQL, not an expression
  const v = guard(`CASE x WHEN 1 THEN PERFORM 1; ELSE PERFORM 2; END CASE;`, 'PERFORM 1;');
  assert.equal(verifyHasElseBranch(v), true);
});
