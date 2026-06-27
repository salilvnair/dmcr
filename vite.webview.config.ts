import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
const DUI_ROOT = resolve(__dirname, '../dui/src/lib');
const DUI_SRC  = resolve(__dirname, '../dui/src');
const DUI_DIST = resolve(__dirname, '../dui/dist');

export default defineConfig({
  base: './',

  resolve: {
    alias: {
      // Subpath exports from a file: symlink aren't reliably resolved by Vite —
      // alias every dui subpath explicitly so the build never falls back to broken
      // node module resolution.
      '@salilvnair/dui/monaco-setup': resolve(DUI_SRC,  'monaco-setup.ts'),
      '@salilvnair/dui/style.css':    resolve(DUI_DIST, 'style.css'),
      '@salilvnair/dui/theme/core':   resolve(DUI_ROOT, 'theme/core.ts'),
      '@salilvnair/dui/theme/utils':  resolve(DUI_ROOT, 'theme/utils.ts'),
      '@salilvnair/dui/theme/editor': resolve(DUI_ROOT, 'theme/editor.tsx'),
    },
    // Force a single React instance — prevents "Cannot read properties of null
    // (reading 'useState')" when convengine-chat's SSE code paths import React
    // independently from the host app's React.
    dedupe: ['react', 'react-dom', '@monaco-editor/react', 'monaco-editor'],
  },

  build: {
    outDir: 'webview/dist',
    emptyOutDir: true,
    assetsInlineLimit: 8192,
    rollupOptions: {
      input: {
        index:        resolve(process.cwd(), 'webview-ui/index.html'),
        conversation: resolve(process.cwd(), 'webview-ui/conversation.html'),
        wiki:         resolve(process.cwd(), 'webview-ui/wiki.html'),
        'schema-explorer': resolve(process.cwd(), 'webview-ui/schema-explorer.html'),
      },
    },
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  plugins: [react(), tailwindcss()],
});
