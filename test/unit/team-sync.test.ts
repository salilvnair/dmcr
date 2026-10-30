import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  abortMerge, bringIn, conflictDetails, describe as words, fetch, finishMerge, gitIn, listBranches, mergeInto, newBranch, pull, push,
  resolveFile, switchTo, type Repo,
} from '../../src/services/git/team-sync';

/*
 * Two DBAs on one shared repository, in a temp folder: a bare "shared" repository and a clone each.
 * Nobody types git in DMCR; these are the calls its buttons make.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-team-'));
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
const CH = 'db/changes';

function clone(name: string, user: string): Repo {
  const root = path.join(tmp, name);
  sh(tmp, 'clone', '-q', path.join(tmp, 'shared.git'), name);
  sh(root, 'config', 'user.name', user); sh(root, 'config', 'user.email', `${user}@example.com`);
  return { root, changesRel: CH, git: gitIn(root) };
}
function change(repo: Repo, id: string, requires: string[] = [], sql = `SELECT '${id}';`) {
  const dir = path.join(repo.root, CH, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ change_id: id, requires }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'deploy.sql'), sql + '\n');
  fs.writeFileSync(path.join(dir, 'verify.sql'), `SELECT 1 FROM dmcr.change_log WHERE change_id = '${id}';\n`);
}
function commit(repo: Repo, msg: string) { sh(repo.root, 'add', '-A'); sh(repo.root, 'commit', '-q', '-m', msg); }
const folders = (repo: Repo) => fs.readdirSync(path.join(repo.root, CH)).filter(f => /^\d+_/.test(f)).sort();
const releases = (date: string) => JSON.stringify({ releases: [{ id: 'B', name: 'Product B', date }] }, null, 2) + '\n';

// the shared repository, with the light walkthrough's first changes on main
sh(tmp, 'init', '-q', '--bare', '-b', 'main', 'shared.git');
const seed = path.join(tmp, 'seed');
sh(tmp, 'init', '-q', '-b', 'main', 'seed');
sh(seed, 'config', 'user.name', 'seed'); sh(seed, 'config', 'user.email', 'seed@example.com');
const s: Repo = { root: seed, changesRel: CH, git: gitIn(seed) };
change(s, '029_a_create_lookup'); change(s, '030_b_add_column', ['029_a_create_lookup']);
fs.writeFileSync(path.join(seed, CH, 'releases.json'), releases('2026-10-31'));
commit(s, 'seed');
sh(seed, 'remote', 'add', 'origin', path.join(tmp, 'shared.git')); sh(seed, 'push', '-q', '-u', 'origin', 'main');

const u1 = clone('anika', 'anika.rao');
const u2 = clone('leo', 'leo.martin');

test('the second DBA to push pulls first, and the change that used the same number moves to the next one', async () => {
  change(u1, '031_b_zp_coupon_create'); commit(u1, 'add 031 coupon');
  const p1 = await push(u1);
  assert.ok(p1.ok && p1.pushed, p1.error);

  // leo saved 031 too, before he had anika's: it requires anika's 030 and names itself in verify.sql
  change(u2, '031_c_lookup_rows', ['030_b_add_column']);
  change(u2, '032_c_after_rows', ['031_c_lookup_rows']);
  commit(u2, 'add 031 lookup rows + 032');
  const p2 = await push(u2);
  assert.ok(p2.ok && p2.pushed, p2.error);
  assert.equal(p2.pulled, 1);
  // 032 is still free on main, so only 031 moves, to the next number after everything (033)
  assert.deepEqual(p2.renamed.map(r => [r.from, r.to, r.by]), [['031_c_lookup_rows', '033_c_lookup_rows', 'anika.rao']]);
  assert.deepEqual(folders(u2), ['029_a_create_lookup', '030_b_add_column', '031_b_zp_coupon_create', '032_c_after_rows', '033_c_lookup_rows']);
  const meta = JSON.parse(fs.readFileSync(path.join(u2.root, CH, '033_c_lookup_rows', 'meta.json'), 'utf8'));
  assert.equal(meta.change_id, '033_c_lookup_rows');
  assert.match(fs.readFileSync(path.join(u2.root, CH, '033_c_lookup_rows', 'verify.sql'), 'utf8'), /change_id = '033_c_lookup_rows'/);
  // what requires it follows
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(u2.root, CH, '032_c_after_rows', 'meta.json'), 'utf8')).requires, ['033_c_lookup_rows']);
  assert.equal(words(p2), 'Pushed main; brought in 1 commit from anika.rao; 031 came from anika.rao, yours is now 033');
  assert.equal(words(await pull(u2), 'Pulled'), 'Up to date: nothing to pull');
  assert.equal(sh(u2.root, 'status', '--porcelain'), '', 'the move is committed');

  // anika pulls and has leo's changes under their new numbers
  const p3 = await pull(u1);
  assert.ok(p3.ok, p3.error);
  assert.ok(p3.pulled >= 2);
  assert.deepEqual(folders(u1), folders(u2));
});

test('a change saved but not committed yet is renamed on disk only', async () => {
  change(u1, '035_b_coupon_index'); commit(u1, 'add 035'); assert.ok((await push(u1)).pushed);
  change(u2, '035_c_not_committed');                     // saved, not committed
  const p = await pull(u2);
  assert.ok(p.ok, p.error);
  assert.deepEqual(p.renamed.map(r => r.to), ['036_c_not_committed']);
  assert.match(sh(u2.root, 'status', '--porcelain'), /\?\? db\/changes\/036_c_not_committed\//);
  fs.rmSync(path.join(u2.root, CH, '036_c_not_committed'), { recursive: true });
});

test('both DBAs move the same release date: the pull stops on releases.json, and Take theirs settles it', async () => {
  fs.writeFileSync(path.join(u1.root, CH, 'releases.json'), releases('2026-11-03')); commit(u1, 'B on 11-03');
  assert.ok((await push(u1)).pushed);
  fs.writeFileSync(path.join(u2.root, CH, 'releases.json'), releases('2026-11-05')); commit(u2, 'B on 11-05');
  const p = await push(u2);
  assert.equal(p.ok, false);
  assert.equal(p.pushed, false);
  assert.deepEqual(p.conflict?.files, [`${CH}/releases.json`]);
  assert.equal(p.conflict?.kind, 'pull');

  const d = await conflictDetails(u2);
  assert.equal(d.files.length, 1);
  assert.match(d.files[0].mine, /2026-11-05/);
  assert.match(d.files[0].theirs, /2026-11-03/);
  assert.equal(d.files[0].theirsBy, 'anika.rao');
  assert.match(d.files[0].merged, /^<<<<<<< /m);

  // a hand-merged text with markers left in is refused
  assert.equal((await resolveFile(u2, `${CH}/releases.json`, 'text', d.files[0].merged)).ok, false);
  assert.ok((await resolveFile(u2, `${CH}/releases.json`, 'theirs')).ok);
  const f = await finishMerge(u2);
  assert.ok(f.ok && f.pushed, f.error);
  assert.match(fs.readFileSync(path.join(u2.root, CH, 'releases.json'), 'utf8'), /2026-11-03/);
  assert.ok((await pull(u1)).ok);
  assert.equal(sh(u1.root, 'rev-parse', 'HEAD'), sh(u2.root, 'rev-parse', 'HEAD'));
});

test('a branch: new, pushed, seen by the other DBA, main brought in (renumbered), merged into main', async () => {
  assert.ok((await newBranch(u2, 'leo/coupon-price')).ok);
  assert.equal((await newBranch(u2, 'leo/coupon-price')).ok, false, 'already exists');
  assert.equal((await newBranch(u2, 'bad name..')).ok, false);
  change(u2, '037_c_coupon_price'); commit(u2, 'add 037 on the branch');
  const p = await push(u2);
  assert.ok(p.pushed, p.error);
  assert.equal(p.upstream, 'origin/leo/coupon-price');

  // anika sees leo's branch once she refreshes (a fetch), and changes main meanwhile with the same number
  await fetch(u1);
  const b = await listBranches(u1);
  assert.deepEqual(b.remoteOnly, ['leo/coupon-price']);
  assert.equal(b.main, 'main');
  change(u1, '037_b_round_price'); commit(u1, 'add 037 on main');
  assert.ok((await push(u1)).pushed);

  const bi = await bringIn(u2, 'main');
  assert.ok(bi.ok && bi.pushed, bi.error);
  assert.deepEqual(bi.renamed.map(r => [r.from, r.to]), [['037_c_coupon_price', '038_c_coupon_price']]);
  assert.equal(sh(u2.root, 'symbolic-ref', '--short', 'HEAD'), 'leo/coupon-price');

  const m = await mergeInto(u2, 'main');
  assert.ok(m.ok && m.pushed, m.error);
  assert.equal(m.branch, 'main');
  assert.equal(sh(u2.root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.ok((await pull(u1)).ok);
  assert.ok(folders(u1).includes('037_b_round_price') && folders(u1).includes('038_c_coupon_price'));

  // anika checks out leo's pushed branch
  assert.ok((await switchTo(u1, 'leo/coupon-price')).ok);
  assert.equal(sh(u1.root, 'symbolic-ref', '--short', 'HEAD'), 'leo/coupon-price');
  assert.ok((await switchTo(u1, 'main')).ok);
});

test('merging a branch into main stops on a file: "mine" is the branch, Cancel puts everything back', async () => {
  assert.ok((await newBranch(u2, 'leo/dates')).ok);
  fs.writeFileSync(path.join(u2.root, CH, 'releases.json'), releases('2026-12-01')); commit(u2, 'B on 12-01');
  fs.writeFileSync(path.join(u1.root, CH, 'releases.json'), releases('2026-12-09')); commit(u1, 'B on 12-09');
  assert.ok((await push(u1)).pushed);
  const m = await mergeInto(u2, 'main');
  assert.equal(m.conflict?.kind, 'merge-into');
  const d = await conflictDetails(u2);
  assert.match(d.files[0].mine, /2026-12-01/, 'mine is the branch');
  assert.match(d.files[0].theirs, /2026-12-09/);
  assert.equal(d.mineLabel, 'leo/dates (yours)');
  assert.equal((await switchTo(u2, 'leo/dates')).ok, false, 'no switching mid-merge');
  assert.ok((await abortMerge(u2)).ok);
  assert.equal(sh(u2.root, 'symbolic-ref', '--short', 'HEAD'), 'leo/dates');

  // again, keeping mine this time
  const m2 = await mergeInto(u2, 'main');
  assert.ok(m2.conflict);
  assert.ok((await resolveFile(u2, `${CH}/releases.json`, 'mine')).ok);
  const f = await finishMerge(u2);
  assert.ok(f.ok && f.pushed, f.error);
  assert.match(fs.readFileSync(path.join(u2.root, CH, 'releases.json'), 'utf8'), /2026-12-01/);
});

test('no remote: a push commits here and says so', async () => {
  const solo: Repo = { root: path.join(tmp, 'solo'), changesRel: CH, git: gitIn(path.join(tmp, 'solo')) };
  sh(tmp, 'init', '-q', '-b', 'main', 'solo');
  sh(solo.root, 'config', 'user.name', 'solo'); sh(solo.root, 'config', 'user.email', 'solo@example.com');
  change(solo, '001_a_x'); commit(solo, 'x');
  const p = await push(solo);
  assert.ok(p.ok); assert.equal(p.pushed, false); assert.match(p.note ?? '', /No git remote/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
