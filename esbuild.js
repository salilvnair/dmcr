const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Copy sql.js WASM + libpg-query (still needs its own dir) into dist/.
 */
function copyAssets() {
  // sql.js WASM binary
  const wasmSrc = path.join('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const wasmDst = path.join('dist', 'sql-wasm.wasm');
  if (fs.existsSync(wasmSrc)) {
    fs.mkdirSync('dist', { recursive: true });
    try {
      fs.copyFileSync(wasmSrc, wasmDst);
      console.log('[wasm] copied sql-wasm.wasm → dist/sql-wasm.wasm');
    } catch (e) {
      if (e.code === 'EPIPE' || e.code === 'EBUSY') {
        console.warn('[wasm] sql-wasm.wasm locked — using existing copy');
      } else { throw e; }
    }
  } else {
    console.warn('[wasm] sql-wasm.wasm not found — skip');
  }

  // libpg-query: still needs its WASM at runtime, and the packages it requires (@pgsql/types): the VSIX has no node_modules
  for (const pkg of runtimePackages('libpg-query')) {
    const src = path.join('node_modules', pkg);
    const dst = path.join('dist', 'node_modules', pkg);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.cpSync(src, dst, { recursive: true });
      console.log(`[native] copied ${pkg} → dist/node_modules/${pkg}`);
    } catch (e) {
      if (e.code === 'EPIPE' || e.code === 'EBUSY') {
        console.warn(`[native] ${pkg} locked — using existing copy`);
      } else { throw e; }
    }
  }
}

/** A package and every package its dependencies need at runtime, as installed under node_modules */
function runtimePackages(name, seen = new Set()) {
  const dir = path.join('node_modules', name);
  if (seen.has(name) || !fs.existsSync(dir)) return [...seen];
  seen.add(name);
  const deps = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies ?? {};
  for (const dep of Object.keys(deps)) runtimePackages(dep, seen);
  return [...seen];
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✗ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/** dist/dmcr-ci.cjs: a standalone Node script (no vscode), see src/ci/dmcr-ci.ts */
async function buildCi() {
	await esbuild.build({
		entryPoints: ['src/ci/dmcr-ci.ts'], bundle: true, format: 'cjs', platform: 'node', target: 'node18',
		minify: production, outfile: 'dist/dmcr-ci.cjs', logLevel: 'silent',
	});
	console.log('[ci] built dist/dmcr-ci.cjs');
	// next to dmcr.ps1 / dmcr.sh (shipped and committed with them): their deploy's conflict check
	await esbuild.build({
		entryPoints: ['src/ci/dmcr-conflicts.ts'], bundle: true, format: 'cjs', platform: 'node', target: 'node18',
		minify: true, outfile: 'scripts/runner/dmcr_conflicts.cjs', logLevel: 'silent',
		banner: { js: '// Built from src/ci/dmcr-conflicts.ts by esbuild.js: do not edit. node dmcr_conflicts.cjs --changes <dir> --ids <a,b>' },
	});
	console.log('[ci] built scripts/runner/dmcr_conflicts.cjs');
}

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', 'libpg-query'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		// The pull-request check (dmcr-ci) that Releases > Set up CI copies into a repository
		await buildCi();
		// Copy WASM + libpg-query assets
		copyAssets();
		// Copy DmcrWiki.md into dist/ so wiki-search.ts can read it at runtime
		try {
			fs.copyFileSync(
				path.join('src', 'forms', 'llm', 'prompts', 'DmcrWiki.md'),
				path.join('dist', 'DmcrWiki.md')
			);
			console.log('[wiki] copied DmcrWiki.md → dist/DmcrWiki.md');
		} catch { /* non-fatal */ }
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
