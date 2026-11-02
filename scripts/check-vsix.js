// What the installed VSIX can load, checked before it ships.
//
// The VSIX is packaged with --no-dependencies, so the extension has no node_modules of its own: whatever
// esbuild leaves external must sit in dist/node_modules with everything it requires. Run from the repo,
// a missing package is hidden by the repo's node_modules ("Cannot find module '@pgsql/types'" only showed
// up in an installed build). So the files vsce would package are copied to a folder with no node_modules
// above it, and each external package is loaded and used there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-vsix-'));
const fail = msg => { console.error(`[check-vsix] FAIL: ${msg}`); process.exitCode = 1; };

const files = execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'ls', '--no-dependencies'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
for (const f of files) {
  const dst = path.join(out, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(root, f), dst);
}

(async () => {
  try {
    const lib = require(path.join(out, 'dist', 'node_modules', 'libpg-query', 'wasm', 'index.cjs'));
    if (lib.loadModule) await lib.loadModule();
    const r = await lib.parse('CREATE TABLE IF NOT EXISTS t (id bigserial PRIMARY KEY)');
    if (!r?.stmts?.length) fail('libpg-query parsed nothing');
    else console.log('[check-vsix] libpg-query loads and parses');
  } catch (e) { fail(`libpg-query: ${e.message}`); }
  for (const f of ['dist/extension.js', 'dist/sql-wasm.wasm', 'scripts/runner/dmcr.ps1', 'scripts/runner/dmcr.sh', 'scripts/runner/dmcr_conflicts.cjs']) {
    if (!fs.existsSync(path.join(out, f))) fail(`${f} is not packaged`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  if (!process.exitCode) console.log(`[check-vsix] ok (${files.length} files)`);
})();
