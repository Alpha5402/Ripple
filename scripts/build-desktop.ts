import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
await mkdir('dist/desktop', { recursive: true });
await build({ entryPoints: ['apps/desktop/main.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/desktop/main.mjs', external: ['electron'] });
await build({ entryPoints: ['apps/desktop/worker.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/desktop/worker.mjs', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
await copyFile('apps/desktop/preload.cjs', 'dist/desktop/preload.cjs');
await writeFile('dist/desktop/package.json', JSON.stringify({ name: 'ripple-desktop', productName: 'Ripple', version: '0.1.0', main: 'main.mjs', type: 'module', author: 'Alpha', description: 'Explore knowledge, one connection at a time.' }, null, 2));
await viteBuild({ configFile: 'apps/workbench/vite.config.mts', build: { outDir: '../../dist/desktop/renderer' } });
