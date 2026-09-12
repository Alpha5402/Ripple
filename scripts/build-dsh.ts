import { build as bundle } from 'esbuild';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { mkdir, writeFile, cp } from 'node:fs/promises';
const output = resolve('dist/dsh'); await mkdir(output, { recursive: true });
await bundle({ entryPoints: ['packages/integrations/dsh/entry.mjs'], outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['@deepseek-ai/cordis'], banner: { js: "import { createRequire as rippleCreateRequire } from 'node:module'; const require = rippleCreateRequire(import.meta.url);" } });
await build({ configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, plugins: [vue()], build: { target: 'es2023', outDir: output, emptyOutDir: false, lib: { entry: resolve('packages/workbench/dsh-client.ts'), formats: ['es'], fileName: () => 'client.mjs', cssFileName: 'client' }, minify: true } });
// DSH's browser module table consumes a closure factory, not a standalone ES module.
await bundle({ entryPoints: [resolve(output, 'client.mjs')], outfile: resolve(output, 'client.js'), bundle: true, platform: 'browser', format: 'cjs', target: 'es2023', banner: { js: 'window.__ModuleLoader__.load({ id: "@ripple/dsh-integration", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' }, footer: { js: 'return module.exports; } });' } });
await cp('dist/web', resolve(output, 'web'), { recursive: true });
await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: '@ripple/dsh-integration', version: '0.1.1', type: 'module', main: './entry.mjs', exports: { '.': './entry.mjs', './client': './client.js', './package.json': './package.json' }, dsh: { client: { inject: ['@deepseek-ai/dsh-api-session-controller'], platform: 'web' } }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.2', '@deepseek-ai/dsh-tools': '*', '@deepseek-ai/dsh-system-prompt': '*', '@deepseek-ai/dsh-api-session-controller': '*' } }, null, 2) + '\n');
