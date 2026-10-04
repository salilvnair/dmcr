import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildTableSnapshot, checkWhere, quoteIdent, snapshotName, uniqueSnapshotName, type SnapshotSpec,
} from '../../src/services/snapshot/table-snapshot';

const spec: SnapshotSpec = {
  schema: 'shop',
  table: 'zp_lookup_data',
  columns: [
    { name: 'id', type: 'bigint', notNull: true },
    { name: 'code', type: 'character varying(40)', notNull: true },
    { name: 'amount', type: 'numeric(12,2)', notNull: false },
    { name: 'order', type: 'integer', notNull: false },
    { name: 'Label', type: 'text', notNull: false },
  ],
  primaryKey: ['id'],
  rows: 'all',
  backupName: 'zp_lookup_data_backup_04_10_2026',
  sourceLabel: 'MCP server "prod"',
  rowsAtGeneration: 290000,
  generatedAt: new Date('2026-10-04T10:00:00Z'),
};

test('backup name is <table>_backup_DD_MM_YYYY', () => {
  assert.equal(snapshotName('zp_lookup_data', new Date(2026, 9, 4)), 'zp_lookup_data_backup_04_10_2026');
});

test('backup name fits in 63 bytes', () => {
  const n = snapshotName('t'.repeat(70), new Date(2026, 0, 9));
  assert.equal(n.length, 63);
  assert.ok(n.endsWith('_backup_09_01_2026'));
});

test('a taken name gets _2, _3 …', () => {
  assert.equal(uniqueSnapshotName('x_backup_04_10_2026', []), 'x_backup_04_10_2026');
  assert.equal(uniqueSnapshotName('x_backup_04_10_2026', ['x_backup_04_10_2026']), 'x_backup_04_10_2026_2');
  assert.equal(uniqueSnapshotName('x_backup_04_10_2026', ['x_backup_04_10_2026', 'x_backup_04_10_2026_2']), 'x_backup_04_10_2026_3');
});

test('identifiers are quoted only when needed', () => {
  assert.equal(quoteIdent('zp_lookup_data'), 'zp_lookup_data');
  assert.equal(quoteIdent('order'), '"order"');
  assert.equal(quoteIdent('Label'), '"Label"');
  assert.equal(quoteIdent('a"b'), '"a""b"');
});

test('WHERE conditions cannot end the statement or hide SQL', () => {
  assert.equal(checkWhere("status = 'a;b'"), null);
  assert.match(checkWhere('id > 1; DROP TABLE x') ?? '', /;/);
  assert.match(checkWhere('id > 1 -- x') ?? '', /comments/);
  assert.match(checkWhere('id > 1 /* x */') ?? '', /comments/);
  assert.match(checkWhere('  ') ?? '', /condition/);
});

test('deploy copies exact types, NOT NULL and the primary key, then all rows', () => {
  const c = buildTableSnapshot(spec);
  assert.equal(c.changeName, 'snapshot_zp_lookup_data');
  assert.match(c.deploySql, /CREATE TABLE shop\.zp_lookup_data_backup_04_10_2026 \(/);
  assert.match(c.deploySql, /code character varying\(40\) NOT NULL/);
  assert.match(c.deploySql, /amount numeric\(12,2\),/);
  assert.match(c.deploySql, /"order" integer/);
  assert.match(c.deploySql, /PRIMARY KEY \(id\)/);
  assert.match(c.deploySql, /INSERT INTO shop\.zp_lookup_data_backup_04_10_2026 \(id, code, amount, "order", "Label"\)\nSELECT id, code, amount, "order", "Label"\nFROM shop\.zp_lookup_data;/);
  assert.match(c.deploySql, /__DMCR_CHANGE_ID__/);
  assert.doesNotMatch(c.deploySql, /DEFAULT|nextval/);
});

test('rows matching a condition, and structure only', () => {
  const w = buildTableSnapshot({ ...spec, rows: 'where', where: " code LIKE 'A%' " });
  assert.match(w.deploySql, /FROM shop\.zp_lookup_data\nWHERE code LIKE 'A%';/);
  assert.equal(JSON.parse(w.metaJson).snapshot.where, "code LIKE 'A%'");
  const s = buildTableSnapshot({ ...spec, rows: 'none' });
  assert.doesNotMatch(s.deploySql, /INSERT INTO/);
  assert.throws(() => buildTableSnapshot({ ...spec, rows: 'where', where: '1=1; DELETE FROM x' }), /;/);
});

test('verify checks both states; revert drops only the copy', () => {
  const c = buildTableSnapshot(spec);
  assert.match(c.verifySql, /change_id = '__DMCR_CHANGE_ID__'/);
  assert.match(c.verifySql, /IF cols <> 5 THEN/);
  assert.match(c.verifySql, /still exists after revert/);
  assert.equal(c.revertSql.match(/DROP TABLE/g)?.length, 1);
  assert.match(c.revertSql, /DROP TABLE IF EXISTS shop\.zp_lookup_data_backup_04_10_2026;/);
});
