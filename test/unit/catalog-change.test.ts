import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeCatalogChange } from '../../src/services/releases/catalog-change';

const rel = { id: '2026-11-20', name: 'QuickStart', date: '2026-11-20', status: 'planned' };
const projA = { id: 'A', name: 'Items', type: 'new', release: '2026-11-20', status: 'active' };
const projB = { id: 'B', name: 'Pricing', type: 'new', release: '2026-11-20', status: 'active' };

test('releases.json commit messages say what the edit did', () => {
  assert.equal(describeCatalogChange(null, { releases: [rel], projects: [] }), 'add release 2026-11-20 QuickStart');
  assert.equal(describeCatalogChange({ releases: [rel], projects: [] }, { releases: [rel], projects: [projA] }), 'add project A Items to 2026-11-20');
  const both = { releases: [rel], projects: [projA, projB] };
  assert.equal(describeCatalogChange(both, { releases: [rel], projects: [projA, { ...projB, status: 'dropped' }] }), 'project B not going');
  assert.equal(describeCatalogChange({ releases: [rel], projects: [projA, { ...projB, status: 'dropped' }] }, both), 'project B going again');
  assert.equal(describeCatalogChange(both, { releases: [rel], projects: [projA, { ...projB, release: '2026-12-01' }] }), 'move project B to 2026-12-01');
  assert.equal(describeCatalogChange(both, { releases: [{ ...rel, archived: true }], projects: [projA, projB] }), 'archive release 2026-11-20');
  assert.equal(describeCatalogChange(both, { releases: [rel], projects: [projA] }), 'remove project B');
  assert.equal(describeCatalogChange(both, both), 'update releases and projects');
});

test('many edits at once: the first three, then a count', () => {
  const projects = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, release: '2026-11-20', status: 'active' }));
  assert.equal(describeCatalogChange({ releases: [rel], projects: [] }, { releases: [rel], projects }),
    'add project A to 2026-11-20, add project B to 2026-11-20, add project C to 2026-11-20 and 2 more');
});

test('a project left without a release when its release is deleted', () => {
  const p = { id: 'A', release: '2026-11-20', status: 'active' };
  assert.equal(describeCatalogChange({ releases: [rel], projects: [p] }, { releases: [], projects: [{ ...p, release: '' }] }),
    'remove release 2026-11-20, unschedule project A');
});
