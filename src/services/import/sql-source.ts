/**
 * Where the SQL to import comes from: a GitHub link (a commit, a pull request, or a folder on a branch) or a
 * local folder. GitHub is read with the user's own git (their credentials, private repos too), into a
 * temporary clone that is removed afterwards. Each file gets its git order: the commit that added it.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ImportFile } from './import-order';

export type SourceLink =
  | { kind: 'commit'; repoUrl: string; repo: string; sha: string }
  | { kind: 'pr'; repoUrl: string; repo: string; pr: number }
  | { kind: 'tree'; repoUrl: string; repo: string; ref: string; dir: string }
  | { kind: 'local'; dir: string };

/** github.com/<owner>/<repo>/commit/<sha> | /pull/<n> | /tree/<ref>/<dir>, or a local folder. */
export function parseSourceLink(input: string): SourceLink | { error: string } {
  const s = input.trim().replace(/[?#].*$/, '');
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/(commit|pull|tree)\/(.+)$/i.exec(s);
  if (gh) {
    const repo = `${gh[1]}/${gh[2]}`;
    const repoUrl = `https://github.com/${repo}.git`;
    const rest = gh[4].replace(/\/+$/, '');
    if (gh[3].toLowerCase() === 'commit') {
      const sha = rest.split('/')[0];
      return /^[0-9a-f]{7,40}$/i.test(sha) ? { kind: 'commit', repoUrl, repo, sha } : { error: `"${sha}" is not a commit id` };
    }
    if (gh[3].toLowerCase() === 'pull') {
      const pr = Number(rest.split('/')[0]);
      return Number.isInteger(pr) && pr > 0 ? { kind: 'pr', repoUrl, repo, pr } : { error: 'No pull request number in the link' };
    }
    const [ref, ...dir] = rest.split('/');
    return { kind: 'tree', repoUrl, repo, ref, dir: dir.join('/') };
  }
  if (/^https?:\/\//i.test(s)) return { error: 'Only GitHub links are supported: a commit, a pull request or a folder (…/tree/<branch>/<folder>)' };
  if (s && fs.existsSync(s) && fs.statSync(s).isDirectory()) return { kind: 'local', dir: s };
  return { error: 'Paste a GitHub link (commit, pull request or folder) or the path of a local folder with the .sql files' };
}

function git(args: string[], cwd?: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join('\n')));
      else resolve(stdout);
    });
  });
}

const isSql = (p: string) => /\.sql$/i.test(p);
/** "A\tpath", "M\tpath", "R100\told\tnew" -> the paths a commit adds or changes */
function addedOrChanged(nameStatus: string): string[] {
  const out: string[] = [];
  for (const line of nameStatus.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const st = parts[0];
    if (st.startsWith('A') || st.startsWith('M')) out.push(parts[1]);
    else if (st.startsWith('R') || st.startsWith('C')) out.push(parts[2]);
  }
  return out.filter(isSql);
}

/** The .sql files of a git repository source, read from a temporary clone (removed afterwards). */
export async function loadFromRepo(repoUrl: string, what: { sha: string } | { pr: number } | { ref: string; dir: string }): Promise<ImportFile[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-import-'));
  try {
    await git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', repoUrl, tmp], undefined, 300_000);
    if ('sha' in what) {
      const paths = addedOrChanged(await git(['show', '--name-status', '--format=', '-M', what.sha], tmp));
      const files: ImportFile[] = [];
      for (const p of paths) files.push({ name: path.posix.basename(p), path: p, sql: await git(['show', `${what.sha}:${p}`], tmp), gitOrder: 0 });
      return files;   // one commit: git cannot tell their order
    }
    if ('pr' in what) {
      await git(['fetch', '--quiet', 'origin', `pull/${what.pr}/head:dmcr_import_pr`], tmp, 300_000);
      const base = (await git(['merge-base', 'origin/HEAD', 'dmcr_import_pr'], tmp)).trim();
      const commits = (await git(['rev-list', '--reverse', `${base}..dmcr_import_pr`], tmp)).split('\n').map(x => x.trim()).filter(Boolean);
      const firstSeen = new Map<string, number>();
      for (const [i, c] of commits.entries()) for (const p of addedOrChanged(await git(['show', '--name-status', '--format=', '-M', c], tmp))) if (!firstSeen.has(p)) firstSeen.set(p, i);
      const atTip = new Set((await git(['ls-tree', '-r', '--name-only', 'dmcr_import_pr'], tmp)).split('\n').map(x => x.trim()));
      const files: ImportFile[] = [];
      for (const [p, i] of firstSeen) if (atTip.has(p)) files.push({ name: path.posix.basename(p), path: p, sql: await git(['show', `dmcr_import_pr:${p}`], tmp), gitOrder: i });
      return files;
    }
    const ref = (await git(['rev-parse', '--verify', '--quiet', `origin/${what.ref}`], tmp).catch(() => '')).trim() ? `origin/${what.ref}` : what.ref;
    const list = (await git(['ls-tree', '-r', '--name-only', ref, '--', what.dir || '.'], tmp)).split('\n').map(x => x.trim()).filter(isSql);
    return await withAddedOrder(list, async p => git(['show', `${ref}:${p}`], tmp), p => git(['log', '--format=%ct', '--diff-filter=A', '-1', ref, '--', p], tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Files in the order git added them (their first commit's time), else unknown (0). */
async function withAddedOrder(paths: string[], read: (p: string) => Promise<string>, addedAt: (p: string) => Promise<string>): Promise<ImportFile[]> {
  const files: ImportFile[] = [];
  const stamps: number[] = [];
  for (const p of paths) {
    const t = Number((await addedAt(p).catch(() => '')).trim().split('\n')[0]) || 0;
    stamps.push(t);
    files.push({ name: path.basename(p), path: p, sql: await read(p), gitOrder: t });
  }
  // rank the times so equal times stay equal (one commit = unknown order between them)
  const ranks = [...new Set(stamps)].sort((a, b) => a - b);
  files.forEach((f, i) => { f.gitOrder = stamps[i] ? ranks.indexOf(stamps[i]) + 1 : 0; });
  return files;
}

/** The .sql files of a local folder (not its subfolders), with their git order when the folder is in a repository. */
export async function loadFromFolder(dir: string): Promise<ImportFile[]> {
  const names = fs.readdirSync(dir).filter(n => isSql(n) && fs.statSync(path.join(dir, n)).isFile()).sort();
  const inRepo = await git(['rev-parse', '--is-inside-work-tree'], dir).then(() => true, () => false);
  return withAddedOrder(names, async n => fs.readFileSync(path.join(dir, n), 'utf8'),
    n => (inRepo ? git(['log', '--format=%ct', '--diff-filter=A', '-1', '--', n], dir) : Promise.resolve('')));
}

export async function loadSource(input: string): Promise<{ label: string; files: ImportFile[] }> {
  const src = parseSourceLink(input);
  if ('error' in src) throw new Error(src.error);
  if (src.kind === 'local') return { label: src.dir, files: await loadFromFolder(src.dir) };
  if (src.kind === 'commit') return { label: `commit ${src.sha.slice(0, 7)} in ${src.repo}`, files: await loadFromRepo(src.repoUrl, { sha: src.sha }) };
  if (src.kind === 'pr') return { label: `pull request #${src.pr} in ${src.repo}`, files: await loadFromRepo(src.repoUrl, { pr: src.pr }) };
  return { label: `${src.dir || 'the root'} on ${src.ref} in ${src.repo}`, files: await loadFromRepo(src.repoUrl, { ref: src.ref, dir: src.dir }) };
}
