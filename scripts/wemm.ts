import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, totalmem, cpus } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(project, '.ripple/wemm');
const revision = 'bbd6cd4bf52cfc6716f752a2df80b2706720bd95';
const modelDir = join(runtime, 'models', revision);
const python = join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const requirements = join(project, 'deploy/wemm/requirements.txt');
const env = { ...process.env, HF_HOME: join(runtime, 'hf-cache'), PIP_CACHE_DIR: join(runtime, 'pip-cache'), PYTHONUNBUFFERED: '1' };

function run(executable: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: project, env: { ...env, ...extraEnv }, stdio: 'inherit' });
    const forward = (): void => { child.kill('SIGINT'); };
    process.once('SIGINT', forward);
    child.once('error', error => { process.off('SIGINT', forward); reject(error); });
    child.once('exit', code => { process.off('SIGINT', forward); code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}`)); });
  });
}
function findPython(): string | undefined {
  const candidates = [process.env.RIPPLE_PYTHON, 'python3.12', 'python3.11', 'python3.10', 'python3',
    join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3')];
  return candidates.find(candidate => candidate && spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' }).status === 0);
}
async function setup(): Promise<void> {
  await mkdir(runtime, { recursive: true });
  if (!existsSync(python)) {
    let bootstrap = findPython();
    if (!bootstrap) {
      const uvTarget = join(runtime, 'bootstrap');
      await run('python3', ['-m', 'pip', 'install', '--target', uvTarget, 'uv>=0.8,<1']);
      const uv = join(uvTarget, 'bin/uv');
      const extra = { UV_PYTHON_INSTALL_DIR: join(runtime, 'python'), UV_CACHE_DIR: join(runtime, 'uv-cache') };
      await run(uv, ['python', 'install', '3.12'], extra);
      const found = spawnSync(uv, ['python', 'find', '3.12'], { env: { ...env, ...extra }, encoding: 'utf8' });
      if (found.status !== 0) throw new Error('Python bootstrap failed; set RIPPLE_PYTHON to Python 3.10+');
      bootstrap = found.stdout.trim();
    }
    await run(bootstrap, ['-m', 'venv', join(runtime, 'venv')]);
  }
  const fingerprint = createHash('sha256').update(await readFile(requirements)).digest('hex');
  const marker = join(runtime, 'requirements.sha256');
  if (await readFile(marker, 'utf8').catch(() => '') !== fingerprint) {
    await run(python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    await run(python, ['-m', 'pip', 'install', '-r', requirements]);
    await writeFile(marker, fingerprint);
  }
  await run(python, [join(project, 'deploy/wemm/download.py'), '--directory', modelDir]);
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  device: { type: 'string', default: 'auto' }, port: { type: 'string', default: '8787' }, host: { type: 'string', default: '127.0.0.1' },
  'max-tokens': { type: 'string', default: '1024' }, 'no-setup': { type: 'boolean', default: false },
  'image-pixels': { type: 'string', default: '65536' },
} });
const command = positionals[0] ?? 'start';
if (!['doctor', 'setup', 'start'].includes(command)) throw new Error('Use doctor, setup or start');
if (command === 'doctor') {
  console.log(JSON.stringify({ cpu: cpus()[0]?.model, memoryGiB: totalmem() / 2 ** 30, python: findPython(), environmentInstalled: existsSync(python), weightsDownloaded: existsSync(join(modelDir, 'model.safetensors')), modelDir, revision }, null, 2));
} else {
  if (!values['no-setup']) await setup();
  if (command === 'start') await run(python, [join(project, 'deploy/wemm/server.py'), '--model-dir', modelDir, '--device', values.device, '--host', values.host, '--port', values.port, '--max-tokens', values['max-tokens'], '--image-pixels', values['image-pixels']], { PYTORCH_ENABLE_MPS_FALLBACK: '1' });
}
