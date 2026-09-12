import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, symlink, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'reports/local/dsh-demo-runtime');
const home = join(root, 'reports/local/dsh-demo-home');
const version = '0.1.5-rc.1';
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => { const child = spawn(command, args, { cwd: root, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))); });
}
let installed: string | undefined;
try { installed = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version; } catch {}
if (installed !== version) { await mkdir(runtime, { recursive: true }); await run('npm', ['install', '--prefix', runtime, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`]); }
const artifact = join(root, 'dist/dsh');
try { await readFile(join(artifact, 'client.js')); } catch { throw new Error('Run npm run build:dsh first.'); }
async function link(target: string, path: string) {
  await mkdir(resolve(path, '..'), { recursive: true });
  try { await lstat(path); if (await realpath(path) !== await realpath(target)) throw new Error(`Unexpected existing demo link: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await symlink(target, path, 'dir'); }
}
// Share the exact host Cordis runtime identity while keeping all demo files local.
await link(join(runtime, 'node_modules/@deepseek-ai/cordis'), join(artifact, 'node_modules/@deepseek-ai/cordis'));
const profile = join(home, 'profiles/ripple-demo');
await link(artifact, join(profile, 'node_modules/@ripple/dsh-integration'));
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'ripple-demo-profile', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } } }, null, 2));
const config = { vault: join(root, 'fixtures/showcase'), stateDir: join(home, 'ripple-state'), endpoint: 'http://127.0.0.1:47321', panel: { port: 47321, webDir: join(artifact, 'web'), frameOrigin: 'http://127.0.0.1:47323' } };
await writeFile(join(profile, 'cordis.patch.yml'), `- id: directory-picker\n  disabled: true\n- insert:\n    - id: ripple-demo-directory-host\n      name: '@deepseek-ai/dsh-host-directory-picker-browse'\n    - id: ripple-demo-directory-ui\n      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'\n    - id: ripple-knowledge\n      name: '@ripple/dsh-integration'\n      config: ${JSON.stringify(config)}\n`);
console.log(`Ripple demo: DSH ${version}; isolated home ${home}\nKeep this terminal open. Use the authenticated URL printed by DSH.\nNo model key is copied; configure a model in this demo's Settings when needed.`);
const child = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'ripple-demo', '--port', '47323', '--no-open'], { cwd: root, env: { ...process.env, DSH_HOME: home }, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
