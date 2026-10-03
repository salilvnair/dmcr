import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  redactText, redactSecrets, splitConnPassword,
  SECRET_MASK, maskSecretMap, unmaskSecretMap, maskArgs, unmaskArgs,
} from '../../src/services/security/redact';

test('redactText masks URL passwords, password= values and auth headers', () => {
  assert.equal(redactText('postgresql://app:s3cret@db:5432/x'), 'postgresql://app:****@db:5432/x');
  assert.equal(redactText("host=db password='it''s' user=a").includes('it'), false);
  assert.equal(redactText('password=abc user=a'), 'password=**** user=a');
  assert.equal(redactText('"Authorization": "Bearer tok123"').includes('tok123'), false);
  assert.equal(redactText('x-api-key: k-999').includes('k-999'), false);
  assert.equal(redactText('nothing secret here'), 'nothing secret here');
});

test('redactText does not leak text after an escaped quote', () => {
  const out = redactText("password='a\\'b c' user=x");
  assert.equal(out.includes('b c'), false);
  assert.equal(out.includes('user=x'), true);
});

test('redactSecrets masks secret-looking keys deeply', () => {
  const out = redactSecrets({ a: { token: 't', nested: ['postgresql://u:p@h/d'] }, keep: 1 });
  assert.deepEqual(out, { a: { token: '****', nested: ['postgresql://u:****@h/d'] }, keep: 1 });
});

test('splitConnPassword handles URL (percent-encoded) and key=value forms', () => {
  assert.deepEqual(splitConnPassword('postgresql://app:p%40ss%3Aw%20rd%21@h:5432/db'),
    { conn: 'postgresql://app@h:5432/db', password: 'p@ss:w rd!' });
  const kv = splitConnPassword("host=h user=app password='it\\'s' dbname=db");
  assert.equal(kv.password, "it's");
  assert.equal(kv.conn.includes('password'), false);
  assert.deepEqual(splitConnPassword('postgresql://app@h/db'), { conn: 'postgresql://app@h/db' });
});

test('maskSecretMap hides secret-named values and embedded passwords only', () => {
  const masked = maskSecretMap({ PGPASSWORD: 'x', DATABASE_URL: 'postgresql://u:p@h/d', PYTHONPATH: '/srv' });
  assert.deepEqual(masked, { PGPASSWORD: SECRET_MASK, DATABASE_URL: 'postgresql://u:****@h/d', PYTHONPATH: '/srv' });
});

test('unmaskSecretMap keeps stored values the UI sent back masked, takes edits', () => {
  const stored = { PGPASSWORD: 'real', DATABASE_URL: 'postgresql://u:p@h/d', MODE: 'a' };
  const fromUi = { ...maskSecretMap(stored)!, MODE: 'b', NEW: 'n' };
  assert.deepEqual(unmaskSecretMap(fromUi, stored), { PGPASSWORD: 'real', DATABASE_URL: 'postgresql://u:p@h/d', MODE: 'b', NEW: 'n' });
  // a changed secret is taken as typed
  assert.equal(unmaskSecretMap({ PGPASSWORD: 'new' }, stored)!.PGPASSWORD, 'new');
  // a removed key stays removed
  assert.deepEqual(unmaskSecretMap({}, stored), {});
});

test('maskArgs / unmaskArgs round-trip connection URLs in process arguments', () => {
  const stored = ['-m', 'app_mcp.server', '--dsn', 'postgresql://u:pw@h/d'];
  const shown = maskArgs(stored)!;
  assert.equal(shown[3], 'postgresql://u:****@h/d');
  assert.deepEqual(unmaskArgs(shown, stored), stored);
  assert.deepEqual(unmaskArgs([...shown, '--verbose'], stored), [...stored, '--verbose']);
});
