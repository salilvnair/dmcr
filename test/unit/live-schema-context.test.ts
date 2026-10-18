import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildLiveSchemaContext, mentionedObjects, splitStatements, statementsFor } from '../../src/forms/llm/generation/live-schema-context';

test('objects named in a request: qualified names, and bare snake_case names in the default schema', () => {
  const objs = mentionedObjects('Insert into public.zp_lookup_data and read zap_runs; ignore dmcr.change_log', 'public');
  assert.deepEqual(objs.map(o => `${o.schema}.${o.name}`).sort(), ['public.zap_runs', 'public.zp_lookup_data']);
});

test('statements are split outside $$ bodies, strings and comments', () => {
  const sql = "CREATE FUNCTION f() RETURNS int AS $x$ SELECT 1; $x$ LANGUAGE sql;\n-- a; comment\nCOMMENT ON TABLE t IS 'a;b';";
  assert.equal(splitStatements(sql).length, 2);
});

test('only structure statements for the object are kept, not DMCR backups or data', () => {
  const sql = [
    'CREATE TABLE IF NOT EXISTS dmcr.bak_x AS SELECT code FROM public.zaps;',
    'CREATE TABLE IF NOT EXISTS public.zaps (id bigint PRIMARY KEY, name text);',
    "INSERT INTO public.zaps (name) VALUES ('a');",
    'ALTER TABLE public.zaps ADD COLUMN owner text;',
    'CREATE TABLE public.zaps_archive (id bigint);',
  ].join('\n');
  const got = statementsFor(sql, { schema: 'public', name: 'zaps' });
  assert.equal(got.length, 2);
  assert.match(got[0], /^CREATE TABLE IF NOT EXISTS public\.zaps \(/);
  assert.match(got[1], /^ALTER TABLE public\.zaps ADD COLUMN owner/);
});

test('context combines live DDL and the repository changes, in deploy order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-ctx-'));
  fs.mkdirSync(path.join(dir, '001_create'));
  fs.writeFileSync(path.join(dir, '001_create', 'deploy.sql'), 'CREATE TABLE public.zap_runs (id bigint, duration_ms int);');
  fs.mkdirSync(path.join(dir, '002_types'));
  fs.writeFileSync(path.join(dir, '002_types', 'deploy.sql'), "ALTER TABLE public.zap_runs ADD COLUMN status text NOT NULL DEFAULT 'queued';");
  const live = {
    label: 'shop-test',
    async objects() { return new Map([['zaps', 'table']]); },
    async ddl(_s: string, n: string) { return `CREATE TABLE public.${n} (id bigint);`; },
  };
  const ctx = await buildLiveSchemaContext('score public.zaps from public.zap_runs', 'public', dir, live);
  assert.match(ctx, /LIVE DATABASE OBJECTS[\s\S]*public\.zaps \(table\)[\s\S]*CREATE TABLE public\.zaps/);
  assert.match(ctx, /-- 001_create\nCREATE TABLE public\.zap_runs[\s\S]*-- 002_types\nALTER TABLE public\.zap_runs ADD COLUMN status/);
  assert.equal(await buildLiveSchemaContext('no objects here', 'public', dir, live), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only real schemas qualify a name: file names, e.g., aliases are not schemas', () => {
  const objs = mentionedObjects('Fix deploy.sql and meta.json, e.g. r.zap_id from zap_runs r; also app.orders and public.customers', 'app', ['app', 'public', 'zp']);
  assert.deepEqual(objs.map(o => `${o.schema}.${o.name}`).sort(), ['app.orders', 'app.zap_runs', 'public.customers']);
});
