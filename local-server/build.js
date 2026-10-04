/**
 * Bundles local-server/server.ts and everything it pulls in from src/ into one Node script
 * (local-server/dist/server.js). The one difference from esbuild.js: `vscode` resolves to
 * local-server/vscode-shim.ts instead of being external, because there is no VS Code host.
 *
 *   node local-server/build.js          build once
 *   node local-server/build.js --serve  build, run, and rebuild + restart on every change
 */
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const serve = process.argv.includes('--serve');
const OUT = path.join(__dirname, 'dist', 'server.js');
let child;

function restart() {
  const start = () => {
    child = spawn(process.execPath, [OUT], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], cwd: path.resolve(__dirname, '..') });
    child.on('exit', code => { if (code) console.error(`[dmcr-web] exited with ${code}`); });
  };
  if (!child || child.exitCode !== null) { start(); return; }
  const old = child;
  old.once('exit', start);
  try { old.send('shutdown'); } catch { old.kill(); }   // saves the database before exiting
  setTimeout(() => { if (old.exitCode === null) old.kill(); }, 4000);
}

const vscodeAlias = {
  name: 'vscode-shim',
  setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: path.join(__dirname, 'vscode-shim.ts') })); },
};
const restartOnBuild = {
  name: 'restart',
  setup(b) { b.onEnd(r => { if (r.errors.length) { console.error('[dmcr-web] build failed — still serving the previous build'); return; } restart(); }); },
};

async function main() {
  // sql.js needs dist/sql-wasm.wasm at the repo root (the extension build copies it there)
  if (!fs.existsSync(path.join(__dirname, '..', 'dist', 'sql-wasm.wasm'))) {
    console.error('[dmcr-web] dist/sql-wasm.wasm missing — run `node esbuild.js` once first');
  }
  const ctx = await esbuild.context({
    entryPoints: [path.join(__dirname, 'server.ts')],
    bundle: true, format: 'cjs', platform: 'node', target: 'node18', sourcemap: true, outfile: OUT,
    external: ['libpg-query'],
    plugins: serve ? [vscodeAlias, restartOnBuild] : [vscodeAlias],
    logLevel: 'info',
  });
  if (serve) { await ctx.watch(); console.log('[dmcr-web] watching; restarts on every rebuild'); }
  else { await ctx.rebuild(); await ctx.dispose(); }
}
main().catch(e => { console.error(e); process.exit(1); });
