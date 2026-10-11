/**
 * dmcr-ci: the pull-request check for a DMCR changes folder (GitHub Actions, or any CI with bash,
 * psql, git and node). For the change folders a PR adds or edits it:
 *   - lints deploy.sql for lock risks (src/services/lint/lock-lint.ts),
 *   - checks meta.json and `requires`, flags edits to changes that already exist on the base branch,
 *   - rebuilds the whole history on an empty database with the DMCR runner (danger_ changes through
 *     their manual script, as a DBA would run them),
 *   - round-trip tests the changed ones (deploy, verify, revert, deploy again; rolled back),
 * and writes a Markdown report (for the PR comment) plus JSON. Exit code 1 when something fails.
 *
 *   node dmcr-ci.cjs --changes db/changes --base origin/main --conn postgresql://postgres:pw@localhost:5432/postgres
 *                    [--runner .github/dmcr/dmcr.sh] [--out dmcr-report.md] [--json dmcr-report.json]
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lintDeploySql, type LintFinding } from '../services/lint/lock-lint';

type Args = { changes: string; base: string; conn: string; runner: string; out: string; json: string };
type RoundTrip = { change_id: string; status: string; details?: string };
type ChangeReport = {
  id: string; status: 'added' | 'edited'; danger: boolean; meta: Record<string, unknown> | null; metaError?: string;
  lint: LintFinding[]; roundTrip?: RoundTrip; problems: string[]; notes: string[];
};

function parseArgs(argv: string[]): Args {
  const get = (k: string, d = '') => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const a: Args = {
    changes: get('changes', 'db/changes'), base: get('base', 'origin/main'), conn: get('conn', process.env.DMCR_CONN ?? ''),
    runner: get('runner', path.join(__dirname, 'dmcr.sh')), out: get('out', 'dmcr-report.md'), json: get('json', 'dmcr-report.json'),
  };
  if (!a.conn) throw new Error('--conn (or DMCR_CONN) is required: an empty PostgreSQL database the check may change');
  return a;
}

const sh = (cmd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) =>
  cp.spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, input, maxBuffer: 64 * 1024 * 1024 });
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tail = (s: string, n = 12) => stripAnsi(s).trim().split('\n').slice(-n).join('\n');
const isDanger = (id: string) => /(^|_)danger_/i.test(id);

/** Change folders the PR touches, relative to the base branch: added or edited, and removed ones. */
function changedFolders(a: Args): { touched: string[]; removed: string[]; onBase: Set<string> } {
  const rel = path.relative(process.cwd(), path.resolve(a.changes)).split(path.sep).join('/');
  const diff = sh('git', ['diff', '--name-only', `${a.base}...HEAD`, '--', rel]);
  if (diff.status !== 0) throw new Error(`git diff against ${a.base} failed: ${diff.stderr.trim()} (checkout with fetch-depth: 0)`);
  const ids = new Set<string>();
  for (const f of diff.stdout.split('\n').map(x => x.trim()).filter(Boolean)) {
    const seg = f.slice(rel.length + 1).split('/')[0];
    if (seg && seg !== 'releases.json' && f.slice(rel.length + 1).includes('/')) ids.add(seg);
  }
  const onBase = new Set<string>();
  const touched: string[] = [], removed: string[] = [];
  for (const id of [...ids].sort()) {
    if (sh('git', ['cat-file', '-e', `${a.base}:${rel}/${id}/deploy.sql`]).status === 0) onBase.add(id);
    if (fs.existsSync(path.join(a.changes, id))) touched.push(id); else removed.push(id);
  }
  return { touched, removed, onBase };
}

function readMeta(dir: string): { meta: Record<string, unknown> | null; error?: string } {
  const f = path.join(dir, 'meta.json');
  if (!fs.existsSync(f)) return { meta: null };
  try { return { meta: JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown> }; }
  catch (e) { return { meta: null, error: (e as Error).message }; }
}

/** The runner against the CI database, with a config written for this run. */
function makeRunner(a: Args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-ci-'));
  const cfg = path.join(dir, 'dmcr.cfg');
  fs.writeFileSync(cfg, `[dmcr]\nenv = ci\nchanges_dir = ${path.resolve(a.changes).split(path.sep).join('/')}\nlock_timeout = 30s\nstatement_timeout = 10min\nchecksum_policy = block\n\n[envs]\nnames = ci\n\n[ci]\nconn =\n`);
  const env = { DMCR_CONN: a.conn, DMCR_ACTOR: 'dmcr-ci', DMCR_BASE_DIR: process.cwd() };
  const run = (...args: string[]) => sh('bash', [a.runner, '-c', cfg, ...args], env);
  // through bash, so DMCR_PSQL (the runner's psql override) may be a script
  const psqlFile = (sql: string) => sh('bash', ['-c', '"${DMCR_PSQL:-psql}" "$@"', 'psql', a.conn, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], undefined, sql);
  return { run, psqlFile };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const all = fs.readdirSync(a.changes, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d+/.test(d.name) && fs.existsSync(path.join(a.changes, d.name, 'deploy.sql')))
    .map(d => d.name).sort();
  const { touched, removed, onBase } = changedFolders(a);
  const failures: string[] = [];

  /* ── per change: meta, requires, lint ── */
  const reports: ChangeReport[] = touched.filter(id => !id.startsWith('R__')).map(id => {
    const dir = path.join(a.changes, id);
    const { meta, error } = readMeta(dir);
    const r: ChangeReport = { id, status: onBase.has(id) ? 'edited' : 'added', danger: isDanger(id), meta, metaError: error, lint: [], problems: [], notes: [] };
    if (error) r.problems.push(`meta.json is not valid JSON: ${error}`);
    for (const n of ['deploy.sql', 'verify.sql', 'revert.sql']) if (!fs.existsSync(path.join(dir, n))) r.problems.push(`${n} is missing`);
    for (const req of (Array.isArray(meta?.requires) ? meta!.requires as string[] : [])) {
      if (!all.includes(req)) r.problems.push(`requires ${req}, which is not a change folder`);
      else if (req > id) r.problems.push(`requires ${req}, which sorts after it (deploys later)`);
    }
    if (r.status === 'edited') r.notes.push(`edits a change that is already on ${a.base}: where it is applied, the checksum policy blocks the next deploy until the edit is accepted`);
    if (r.danger) r.notes.push('manual-only (danger_): deploy never runs it; the DBA runs its script by hand (dmcr manual-script), after approval where required. Here it ran through that script, so it is not round-trip tested');
    r.lint = fs.existsSync(path.join(dir, 'deploy.sql')) ? lintDeploySql(fs.readFileSync(path.join(dir, 'deploy.sql'), 'utf8')) : [];
    return r;
  });
  for (const id of removed) failures.push(`${id} was deleted: a change that may be applied somewhere must stay (drop it in meta.json instead)`);

  /* ── the database: everything before the first changed change, then the round trip, then the rest ── */
  const { run, psqlFile } = makeRunner(a);
  let history = 'not run';
  const firstChanged = reports.length ? reports[0].id : null;
  const applyThrough = (ids: string[]): string | null => {
    let pendingTo: string | null = null;
    const flush = () => {
      if (!pendingTo) return null;
      const r = run('deploy', '--to', pendingTo);
      pendingTo = null;
      return r.status === 0 ? null : `deploy failed:\n${tail(r.stdout + r.stderr)}`;
    };
    for (const id of ids) {
      if (!isDanger(id)) { pendingTo = id; continue; }
      const e = flush(); if (e) return e;
      const ms = run('manual-script', id);
      if (ms.status !== 0) return `manual-script ${id} failed:\n${tail(ms.stdout + ms.stderr)}`;
      const p = psqlFile(stripAnsi(ms.stdout));
      if (p.status !== 0) return `${id} (run by hand from its manual script) failed:\n${tail(p.stdout + p.stderr)}`;
    }
    return flush();
  };
  const init = run('init');
  if (init.status !== 0) {
    history = 'failed';
    failures.push(`dmcr init failed:\n${tail(init.stdout + init.stderr)}`);
  } else {
    const before = firstChanged ? all.filter(id => id < firstChanged) : all;
    const e1 = applyThrough(before);
    if (e1) { history = 'failed'; failures.push(`The history before this PR does not apply on an empty database: ${e1}`); }
    else if (firstChanged) {
      // The round trip stops at a change it cannot roll back (danger_, or "transaction": false with
      // CONCURRENTLY): apply up to and including that change for real, as a deploy (or the DBA) would,
      // then go on testing the changes after it.
      let after: string | null = null, e2: string | null = null;   // applied for real through `after`
      const rest = (id: string) => (after ? id > after : id >= firstChanged);
      for (let guard = 0; guard < all.length && !e2; guard++) {
        const t = run('test', '--json');
        const out = stripAnsi(t.stdout);
        let rt: { status: string; changes: RoundTrip[]; stopped_at?: { change_id: string; reason: string } };
        try { rt = JSON.parse(out.slice(out.indexOf('{'))); }
        catch { failures.push(`dmcr test did not return a result:
${tail(t.stdout + t.stderr)}`); break; }
        for (const c of rt.changes) { const r = reports.find(x => x.id === c.change_id); if (r) r.roundTrip = c; }
        if (rt.status !== 'passed' || !rt.stopped_at) break;
        const stop = rt.stopped_at.change_id;
        const sr = reports.find(x => x.id === stop);
        if (sr && !sr.danger) sr.notes.push(`not round-trip tested: ${rt.stopped_at.reason.replace(/ — later changes were not tested$/, '')}; applied for real, then the round trip went on`);
        e2 = applyThrough(all.filter(id => rest(id) && id <= stop));
        after = stop;
      }
      if (!e2) e2 = applyThrough(all.filter(rest));
      if (e2) { history = 'failed'; failures.push(`The history with this PR does not apply on an empty database: ${e2}`); }
      else history = 'ok';
    } else history = 'ok';
  }
  for (const r of reports) {
    if (r.roundTrip && r.roundTrip.status !== 'pass') r.problems.push(`round trip ${r.roundTrip.status}: ${(r.roundTrip.details ?? '').split('\n')[0]}`);
    for (const p of r.problems) failures.push(`${r.id}: ${p}`);
  }

  /* ── report ── */
  const ok = failures.length === 0;
  const risks = reports.reduce((n, r) => n + r.lint.filter(f => f.severity === 'warning').length, 0);
  const md: string[] = ['<!-- dmcr-ci -->'];
  md.push(`## ${ok ? '✅' : '❌'} DMCR: ${reports.length} change${reports.length === 1 ? '' : 's'} in this PR`);
  md.push('', `History from an empty database: **${history}** · lock risks: **${risks}** · base: \`${a.base}\``, '');
  if (reports.length) {
    md.push('| Change | | Project · kind | Round trip | Lock lint |', '|---|---|---|---|---|');
    for (const r of reports) {
      const m = r.meta ?? {};
      const rt = r.roundTrip ? (r.roundTrip.status === 'pass' ? '✅ pass' : `❌ ${r.roundTrip.status}`) : (r.danger ? 'manual' : '—');
      const lint = r.lint.length ? r.lint.map(f => `${f.severity === 'warning' ? '⚠️' : 'ℹ️'} ${f.rule} (line ${f.line})`).join('<br>') : '✅';
      md.push(`| \`${r.id}\` | ${r.status}${r.danger ? ' · danger' : ''} | ${[m.project, m.kind].filter(Boolean).join(' · ') || '—'} | ${rt} | ${lint} |`);
    }
  } else md.push('No change folders added or edited.');
  if (failures.length) { md.push('', '### Failures'); for (const f of failures) md.push('', '```', f, '```'); }
  const withLint = reports.filter(r => r.lint.length);
  if (withLint.length) {
    md.push('', '### Lock lint', '_Advisory: fine on a small table or in a maintenance window._', '');
    for (const r of withLint) for (const f of r.lint) md.push(`- ${f.severity === 'warning' ? '⚠️' : 'ℹ️'} **\`${r.id}\` line ${f.line}**: \`${f.statement.slice(0, 120)}\`<br>${f.why}<br>**Safer:** ${f.fix}`);
  }
  const notes = reports.filter(r => r.notes.length);
  if (notes.length) { md.push('', '### Notes'); for (const r of notes) for (const n of r.notes) md.push(`- \`${r.id}\`: ${n}`); }
  fs.writeFileSync(a.out, md.join('\n') + '\n');
  fs.writeFileSync(a.json, JSON.stringify({ ok, history, base: a.base, changes: reports, removed, failures }, null, 2));
  process.stdout.write(md.join('\n') + '\n');
  process.exit(ok ? 0 : 1);
}

try { main(); } catch (e) { console.error(`dmcr-ci: ${(e as Error).message}`); process.exit(2); }
