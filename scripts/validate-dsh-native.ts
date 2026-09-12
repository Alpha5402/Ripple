import { build } from 'esbuild';
import { readdir, readFile, mkdir, stat, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const { values } = parseArgs({ options: { source: { type: 'string' } } });
if (!values.source) throw new Error('Pass --source PATH to the local DSH checkout');
const root = resolve(values.source), output = resolve('reports/local/dsh-native'); await mkdir(output, { recursive: true });
const packages = new Map<string, string>();
for (const group of ['vendor', ...(await readdir(join(root, 'packages'))).map(x => `packages/${x}`)]) {
  try { for (const name of await readdir(join(root, group))) { const dir = join(root, group, name); try { const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); packages.set(pkg.name, dir); } catch {} } } catch {}
}
await build({ stdin: { contents: "export { Context, Service } from '@deepseek-ai/cordis'; export { default as SystemPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'; export { default as Tools } from '@deepseek-ai/dsh-tools'; export * as RipplePlugin from '" + resolve("packages/integrations/dsh/entry.mjs") + "';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(output, 'runtime.mjs'), banner: { js: "import { createRequire as rippleCreateRequire } from 'node:module'; const require = rippleCreateRequire(import.meta.url);" }, plugins: [{ name: 'dsh-source-workspace', setup(b) { b.onLoad({ filter: /attribution\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)), loader: 'ts' })); b.onResolve({ filter: /^@deepseek-ai\// }, async args => {
  const segments = args.path.split('/'), name = segments.slice(0, 2).join('/'), directory = packages.get(name); if (!directory) return undefined;
  const sub = segments.slice(2).join('/'); const candidates = sub ? [join(directory, 'src', sub + '.ts'), join(directory, 'src', sub, 'index.ts'), join(directory, sub)] : [join(directory, 'src/index.ts')];
  for (const path of candidates) { try { if ((await stat(path)).isFile()) return { path }; } catch {} }
  return undefined;
}); } }] });
await cp('fixtures/showcase', join(output, 'vault'), { recursive: true });
await writeFile(join(output, 'vault', 'AbortController.md'), (await readFile('fixtures/showcase/AbortController.md', 'utf8')) + '\nTemplate source: {{unregistered_secret}}\n');
const runtime = await import(pathToFileURL(join(output, 'runtime.mjs')).href);
const ctx = new runtime.Context(); await ctx.plugin(runtime.SystemPrompt, {}); await ctx.plugin(runtime.Tools);
const counts = [];
for (let i = 0; i < 3; i++) {
  const fork = await ctx.plugin(runtime.RipplePlugin, { vault: join(output, 'vault'), stateDir: join(output, 'native-state') }); assert.ok(ctx.rippleKnowledge);
  const knowledge = ctx.rippleKnowledge.knowledge;
  const names = ctx.tools.schemas().map((tool: any) => tool.name); assert.ok(names.includes('ripple_context')); assert.ok(!names.includes('ripple_approve'));
  knowledge.human({ type: 'follow', sessionId: 'native-session', enabled: true });
  const result = await ctx.tools.execute({ callId: 'native-call', name: 'ripple_context', arguments: {}, agent: { id: 'native-session' }, signal: new AbortController().signal });
  assert.equal(result.isError, false); const content = JSON.parse(result.content[0].text); assert.equal(content.version, knowledge.context('native-session').version);
  const assembled = await ctx.systemPrompt.assemble({ scope: { id: 'native-session' } });
  assert.equal(JSON.parse(runtime.renderContextSections(assembled).find((c: any) => c.name === 'ripple:follow-lens').text).rippleKnowledge.version, content.version);
  assert.ok(runtime.renderContextSections(assembled).find((c: any) => c.name === 'ripple:follow-lens').text.includes('{{unregistered_secret}}'));
  await fork.dispose(); assert.equal(ctx.rippleKnowledge, undefined); assert.equal(ctx.tools.schemas().some((tool: any) => tool.name.startsWith('ripple_')), false);
  counts.push({ cycle: i + 1, registered: names.length, remaining: ctx.tools.schemas().length });
}
await ctx.fiber.dispose();
await writeFile(join(output, 'result.json'), JSON.stringify({ runtime: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, source: root, nativeContextAndTools: true, lifecycle: counts, liveModelTurn: false }, null, 2));
console.log(JSON.stringify({ nativeContextAndTools: true, lifecycle: counts }));
