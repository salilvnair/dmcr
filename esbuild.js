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

  // libpg-query: still needs its WASM at runtime
  const libpgSrc = path.join('node_modules', 'libpg-query');
  const libpgDst = path.join('dist', 'node_modules', 'libpg-query');
  if (fs.existsSync(libpgSrc)) {
    fs.mkdirSync(path.dirname(libpgDst), { recursive: true });
    try {
      fs.cpSync(libpgSrc, libpgDst, { recursive: true });
      console.log('[native] copied libpg-query → dist/node_modules/libpg-query');
    } catch (e) {
      if (e.code === 'EPIPE' || e.code === 'EBUSY') {
        console.warn('[native] libpg-query locked — using existing copy');
      } else { throw e; }
    }
  }
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
