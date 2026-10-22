import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSourceLink, loadFromRepo, loadFromFolder } from '../../src/services/import/sql-source';

test('GitHub links: commit, pull request, folder; anything else says what it takes', () => {
  assert.deepEqual(parseSourceLink('https://github.com/acme/db-scripts/commit/3f2a9c1b'), { kind: 'commit', repoUrl: 'https://github.com/acme/db-scripts.git', repo: 'acme/db-scripts', sha: '3f2a9c1b' });
  assert.deepEqual(parseSourceLink('github.com/acme/db-scripts/pull/42/files'), { kind: 'pr', repoUrl: 'https://github.com/acme/db-scripts.git', repo: 'acme/db-scripts', pr: 42 });
  assert.deepEqual(parseSourceLink('https://github.com/acme/db-scripts/tree/main/sql/november'), { kind: 'tree', repoUrl: 'https://github.com/acme/db-scripts.git', repo: 'acme/db-scripts', ref: 'main', dir: 'sql/november' });
  assert.ok('error' in parseSourceLink('https://gitlab.com/acme/x/commit/abc1234'));
  assert.ok('error' in parseSourceLink('https://github.com/acme/x/commit/not-a-sha'));
});

function repoWithTwoCommits(): { dir: string; first: string; second: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-src-test-'));
  const g = (args: string[], date?: string) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'add_region.sql'), 'ALTER TABLE t ADD COLUMN region text;');
  fs.writeFileSync(path.join(dir, 'insert_plans.sql'), "INSERT INTO t (code) VALUES ('P001');");
  fs.writeFileSync(path.join(dir, 'README.md'), 'not sql');
  g(['add', '.']); g(['commit', '-q', '-m', 'first'], '2026-10-01T10:00:00Z');
  const first = g(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'set_region.sql'), "UPDATE t SET region = 'EU' WHERE code = 'P001';");
  g(['add', '.']); g(['commit', '-q', '-m', 'second'], '2026-10-02T10:00:00Z');
  return { dir, first, second: g(['rev-parse', 'HEAD']) };
}

test('a commit gives the .sql files it adds; a folder gives every .sql file with the order git added them', async () => {
  const r = repoWithTwoCommits();
  try {
    const c2 = await loadFromRepo(r.dir, { sha: r.second });
    assert.deepEqual(c2.map(f => f.name), ['set_region.sql']);
    assert.match(c2[0].sql, /SET region = 'EU'/);
    const c1 = await loadFromRepo(r.dir, { sha: r.first });
    assert.deepEqual(c1.map(f => f.name).sort(), ['add_region.sql', 'insert_plans.sql'], 'no README');
    const tree = await loadFromRepo(r.dir, { ref: 'main', dir: '' });
    const order = Object.fromEntries(tree.map(f => [f.name, f.gitOrder]));
    assert.equal(order['add_region.sql'], order['insert_plans.sql'], 'same commit: same order');
    assert.ok(order['set_region.sql'] > order['add_region.sql'], 'added later: later');
    const local = await loadFromFolder(r.dir);
    assert.deepEqual(local.map(f => [f.name, f.gitOrder]), tree.map(f => [f.name, f.gitOrder]).sort());
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});
