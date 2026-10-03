/**
 * Two VS Code windows share ~/.dmcr/db/dmcr.db. Each loads the whole database into memory
 * (sql.js), so a save from one window used to overwrite the other's changes.
 * Here the db module is loaded twice — two independent "windows" — against one temp file.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type DbModule = typeof import('../../src/storage/db');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-db-test-'));
const extDir = path.join(home, 'ext');
const dbModulePath = require.resolve('../../src/storage/db');

function openWindow(): DbModule {
  delete require.cache[dbModulePath]; // fresh module state = a separate window
  return require(dbModulePath) as DbModule;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

before(() => {
  process.env.HOME = home;          // db path is ~/.dmcr/db/dmcr.db
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
  fs.copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), path.join(extDir, 'dist', 'sql-wasm.wasm'));
});

after(() => { fs.rmSync(home, { recursive: true, force: true }); });

test('saves from two windows are merged, not overwritten', async () => {
  const a = openWindow(); await a.initDb(extDir);
  const b = openWindow(); await b.initDb(extDir);
  assert.match(a.getDbPath(), /dmcr-db-test-/);

  a.upsert('t', 'fromA', { v: 1 });
  b.upsert('t', 'fromB', { v: 2 });
  a.closeDb();            // A saves first
  await sleep(20);
  b.closeDb();            // B sees the file changed, reloads it, re-applies its write, saves

  const c = openWindow(); await c.initDb(extDir);
  assert.deepEqual(c.findById('t', 'fromA'), { v: 1 });
  assert.deepEqual(c.findById('t', 'fromB'), { v: 2 });
  c.closeDb();
});

test('an idle window picks up another window\'s save', async () => {
  const a = openWindow(); await a.initDb(extDir);
  const b = openWindow(); await b.initDb(extDir);
  a.upsert('t', 'late', { v: 3 });
  a.closeDb();
  await sleep(4500);      // the file watcher polls every 2 s
  assert.deepEqual(b.findById('t', 'late'), { v: 3 });
  b.closeDb();
});

test('conversation SQL older than a day is kept (30-day retention)', async () => {
  const a = openWindow(); await a.initDb(extDir);
  const raw = a.getRawDb()!;
  raw.prepare(`INSERT INTO conversation_sql (conversation_id, change_name, deploy_sql, verify_sql, revert_sql, created_at)
               VALUES ('old', 'x', 'd', 'v', 'r', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'))`).run();
  a.saveConversationSql({ conversation_id: 'new', change_name: 'y', deploy_sql: 'd', verify_sql: 'v', revert_sql: 'r' });
  assert.ok(a.getConversationSql('old'), '3-day-old entry should still be there');
  raw.prepare(`UPDATE conversation_sql SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE conversation_id = 'old'`).run();
  a.saveConversationSql({ conversation_id: 'new2', change_name: 'z', deploy_sql: 'd', verify_sql: 'v', revert_sql: 'r' });
  assert.equal(a.getConversationSql('old'), undefined, '31-day-old entry should be purged');
  a.closeDb();
});
