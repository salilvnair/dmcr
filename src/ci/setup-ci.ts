/**
 * Releases > Set up CI: the files that run the DMCR pull-request check (src/ci/dmcr-ci.ts) in GitHub
 * Actions, written into the repository that holds the changes folder. Nothing is committed or pushed.
 *   .github/workflows/dmcr.yml    the workflow: PostgreSQL service, the check, one PR comment kept up to date
 *   .github/dmcr/dmcr-ci.cjs      the check (dist/dmcr-ci.cjs)
 *   .github/dmcr/dmcr.sh …        the runner it drives, with its registry DDL, round-trip helpers and danger rules
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface CiFile { path: string; from?: string; content?: string; exists: boolean }
export interface CiPlan { root: string; changesRel: string; files: CiFile[]; workflow: string }

/** The repository root (git) that holds the changes folder. */
function repoRoot(changesDir: string): string {
  const r = cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: changesDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`The changes folder is not in a git repository (${changesDir}); CI runs on pull requests`);
  return fs.realpathSync.native(path.resolve(r.stdout.trim()));
}

export function workflowYaml(changesRel: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `# DMCR pull-request check, written by DMCR (Releases > Set up CI). Set up CI again to update it.
# For the change folders a PR adds or edits: lock lint, meta.json and requires checks, the whole history
# rebuilt on an empty PostgreSQL (danger_ changes through their manual script), and a round trip of the
# changed ones (deploy, verify, revert, deploy again). One PR comment, updated on every push.
name: DMCR

on:
  pull_request:
    paths:
      - ${q(`${changesRel}/**`)}
      - '.github/dmcr/**'
      - '.github/workflows/dmcr.yml'

permissions:
  contents: read
  pull-requests: write

jobs:
  dmcr:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: dmcr-ci
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 2s --health-timeout 5s --health-retries 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: DMCR check
        run: >-
          node .github/dmcr/dmcr-ci.cjs
          --changes ${q(changesRel)}
          --base "origin/\${{ github.base_ref }}"
          --conn postgresql://postgres:dmcr-ci@localhost:5432/postgres
          --runner .github/dmcr/dmcr.sh
          --out dmcr-report.md --json dmcr-report.json
      - name: Job summary
        if: always() && hashFiles('dmcr-report.md') != ''
        run: cat dmcr-report.md >> "$GITHUB_STEP_SUMMARY"
      - name: Comment on the pull request
        if: always() && hashFiles('dmcr-report.md') != ''
        continue-on-error: true   # a PR from a fork gets a read-only token
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = fs.readFileSync('dmcr-report.md', 'utf8');
            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number });
            const mine = comments.find(c => (c.body || '').startsWith('<!-- dmcr-ci -->'));
            if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
            else await github.rest.issues.createComment({ owner, repo, issue_number, body });
      - name: Keep the report
        if: always() && hashFiles('dmcr-report.md') != ''
        uses: actions/upload-artifact@v4
        with:
          name: dmcr-report
          path: dmcr-report.*
`;
}

export function planCi(opts: { extensionPath: string; changesDir: string; dangerRules?: string }): CiPlan {
  const root = repoRoot(opts.changesDir);
  // real paths on both sides: a Windows 8.3 short name (SALILV~1) never matches git's long one
  const changesRel = path.relative(root, fs.realpathSync.native(path.resolve(opts.changesDir))).split(path.sep).join('/');
  if (!changesRel || changesRel.startsWith('..')) throw new Error(`The changes folder is outside the repository ${root}`);
  const runner = path.join(opts.extensionPath, 'scripts', 'runner');
  const ci = path.join(opts.extensionPath, 'dist', 'dmcr-ci.cjs');
  if (!fs.existsSync(ci)) throw new Error(`${ci} is missing: build DMCR first (node esbuild.js)`);
  const workflow = workflowYaml(changesRel);
  const rel = (p: string) => p.split('/').join(path.sep);
  const files: CiFile[] = [
    { path: '.github/workflows/dmcr.yml', content: workflow },
    { path: '.github/dmcr/dmcr-ci.cjs', from: ci },
    { path: '.github/dmcr/dmcr.sh', from: path.join(runner, 'dmcr.sh') },
    { path: '.github/dmcr/dmcr_change_log_ddl.sql', from: path.join(runner, 'dmcr_change_log_ddl.sql') },
    { path: '.github/dmcr/dmcr_roundtrip.sql', from: path.join(runner, 'dmcr_roundtrip.sql') },
    { path: '.github/dmcr/dmcr_danger.json', from: opts.dangerRules && fs.existsSync(opts.dangerRules) ? opts.dangerRules : path.join(runner, 'dmcr_danger.json') },
  ].map(f => ({ ...f, exists: fs.existsSync(path.join(root, rel(f.path))) }));
  return { root, changesRel, files, workflow };
}

/** Writes the plan's files (LF line endings for the shell script and the workflow). */
export function writeCi(plan: CiPlan): string[] {
  const written: string[] = [];
  for (const f of plan.files) {
    const dst = path.join(plan.root, f.path.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let body = f.content ?? fs.readFileSync(f.from!, 'utf8');
    if (/\.(sh|yml|sql|json)$/.test(f.path)) body = body.replace(/\r\n/g, '\n');
    fs.writeFileSync(dst, body, { encoding: 'utf8', mode: f.path.endsWith('.sh') ? 0o755 : 0o644 });
    written.push(f.path);
  }
  return written;
}
