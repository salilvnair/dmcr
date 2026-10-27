import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { diffTableData, syncChangeSql, type Query } from '../../src/services/schema/data-diff';

/*
 * Data Diff against a real PostgreSQL: the dmcr-local-pg container (test\scripts\local-sim.ps1).
 * Skipped when it is not running. Two schemas of one scratch database stand in for test and prod.
 */
const container = process.env.DMCR_PG_CONTAINER || 'dmcr-local-pg';
const DB = 'dmcr_data_diff_test';
const NULL = '\u0001NULL\u0001';

function psql(db: string, sql: string): string {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAt', '-F', '\u001f', '-R', '\u001e', '-P', `null=${NULL}`],
    { input: sql, encoding: 'utf8' });
}
const up = (() => { try { psql('postgres', 'SELECT 1'); return true; } catch { return false; } })();

/** like pgsql_mcp's run_readonly_query: every value as text, NULL as null */
const query: Query = async sql => {
  const out = psql(DB, sql.trim().replace(/;?\s*$/, ';'));
  const rows = out.replace(/\n$/, '').split('\u001e').filter(r => r.length).map(r => r.replace(/^\n/, '').split('\u001f').map(v => (v === NULL ? null : v)));
  return { columns: [], rows };
};

const SETUP = `
CREATE SCHEMA dmcr; CREATE TABLE dmcr.change_log (change_id text PRIMARY KEY);
CREATE SCHEMA st; CREATE SCHEMA pr;
CREATE TABLE st.item (id int PRIMARY KEY, code text NOT NULL, price numeric(8,2), seen timestamptz, note text, only_st int);
CREATE TABLE pr.item (id int PRIMARY KEY, code text NOT NULL, price numeric(8,2), seen timestamptz, note text, only_pr int);
INSERT INTO st.item VALUES (1,'A',1.50,'2026-01-01 10:00+00',NULL,1),(2,'B',2.00,NULL,'it''s',1),(3,'C',3.00,NULL,'x',1),(5,'E',5,NULL,'new',1);
INSERT INTO pr.item VALUES (1,'A',1.50,'2026-01-01 10:00+00',NULL,9),(2,'B',2.50,NULL,'it''s',9),(3,'C',3.00,NULL,NULL,9),(4,'D',4,NULL,'gone',9);
CREATE TABLE st.pair (a int, b text, v text, PRIMARY KEY (a, b));
CREATE TABLE pr.pair (a int, b text, v text, PRIMARY KEY (a, b));
INSERT INTO st.pair SELECT g, 'k' || (g % 3), 'v' || g FROM generate_series(1, 2500) g;
INSERT INTO pr.pair SELECT g, 'k' || (g % 3), CASE WHEN g = 1700 THEN 'changed' ELSE 'v' || g END FROM generate_series(2, 2501) g;
CREATE TABLE st.bag (x int, y text); CREATE TABLE pr.bag (x int, y text);
INSERT INTO st.bag VALUES (1,'a'),(1,'a'),(2,NULL),(3,'c');
INSERT INTO pr.bag VALUES (1,'a'),(2,NULL),(4,'d');
`;

const run = (table: string, ignore?: string[], key?: string[]) => diffTableData({ source: query, target: query, sourceSchema: 'st', targetSchema: 'pr', table, ignore, key });

test('data diff: keyed, composite-keyed and keyless tables; the sync change round-trips', { skip: !up && `${container} is not running` }, async () => {
  psql('postgres', `DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};`);
  try {
    psql(DB, SETUP);

    // keyed: one added, one removed, two changed (price; a note that became NULL); the one-sided columns are left out
    const d = await run('item');
    assert.deepEqual(d.keyColumns, ['id']);
    assert.equal(d.keyKind, 'primary');
    assert.deepEqual(d.columns, ['id', 'code', 'price', 'seen', 'note']);
    assert.deepEqual(d.onlyInSourceColumns, ['only_st']);
    assert.deepEqual(d.onlyInTargetColumns, ['only_pr']);
    assert.deepEqual(d.counts, { added: 1, removed: 1, changed: 2 });
    assert.equal(d.same, 1);
    assert.equal(d.added[0].id, '5');
    assert.equal(d.removed[0].id, '4');
    const byId = Object.fromEntries(d.changed.map(c => [c.key.id, c]));
    assert.deepEqual(byId['2'].columns, ['price']);
    assert.equal(byId['2'].source.price, '2.00');
    assert.deepEqual(byId['3'].columns, ['note']);
    assert.equal(byId['3'].target.note, null);
    assert.ok(d.complete);

    // ignoring a column takes its differences out
    const ig = await run('item', ['price', 'note']);
    assert.deepEqual(ig.counts, { added: 1, removed: 1, changed: 0 });
    assert.deepEqual(ig.ignored, ['price', 'note']);

    // the sync change: deploy makes prod match, verify passes applied, revert puts it back, verify passes reverted
    const sql = syncChangeSql(d, { deletes: true });
    const onPr = (s: string) => psql(DB, `SET search_path = pr; ${s}`);
    onPr(sql.deploy);
    assert.deepEqual((await run('item')).counts, { added: 0, removed: 0, changed: 0 });
    psql(DB, `INSERT INTO dmcr.change_log VALUES ('__DMCR_CHANGE_ID__');`);
    onPr(sql.verify);
    onPr(sql.revert);
    psql(DB, `DELETE FROM dmcr.change_log;`);
    onPr(sql.verify);
    const back = await run('item');
    assert.deepEqual(back.counts, d.counts);
    assert.deepEqual(back.changed.map(c => c.target), d.changed.map(c => c.target));

    // match by another column (code), id ignored: the sync inserts without id (its default fills it)
    const byCode = await run('item', ['id'], ['code']);
    assert.equal(byCode.keyKind, 'chosen');
    assert.deepEqual(byCode.keyColumns, ['code']);
    assert.ok(!byCode.columns.includes('id'));
    assert.deepEqual(byCode.counts, { added: 1, removed: 1, changed: 2 });
    assert.match(syncChangeSql(byCode, { deletes: false }).deploy, /INSERT INTO "item" \("code", "price"/);
    // a column that repeats cannot be matched by
    await assert.rejects(run('bag', [], ['x']), /x is not unique on the source/);

    // composite key over more than a page (keyset paging)
    const p = await run('pair');
    assert.deepEqual(p.keyColumns, ['a', 'b']);
    assert.equal(p.sourceRows, 2500);
    assert.deepEqual(p.counts, { added: 1, removed: 1, changed: 1 });
    assert.equal(p.changed[0].key.a, '1700');

    // no key: a bag of rows, twins counted
    const b = await run('bag');
    assert.equal(b.keyKind, 'none');
    assert.deepEqual(b.counts, { added: 2, removed: 1, changed: 0 });
    const bs = syncChangeSql(b, { deletes: true });
    onPr(bs.deploy);
    assert.deepEqual((await run('bag')).counts, { added: 0, removed: 0, changed: 0 });
    onPr(bs.revert);
    assert.deepEqual((await run('bag')).counts, b.counts);
  } finally {
    psql('postgres', `DROP DATABASE IF EXISTS ${DB};`);
  }
});
