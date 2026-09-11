import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { openVault, atomicJson } from '../../packages/adapters/filesystem/workspace.js';
import { NodeIdentityProvider } from '../../packages/adapters/runtime-node/index.js';
import { Playground } from './controller.js';
import { KernelError } from '../../packages/core/model.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    vault: { type: 'string', default: 'fixtures/vault' },
    commands: { type: 'string' }, 'state-dir': { type: 'string' },
    ephemeral: { type: 'boolean', default: false }, 'all-markdown': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Ripple K1–K3 Playground\n--vault <directory> [--commands <file>] [--state-dir <outside-vault directory>] [--ephemeral] [--all-markdown]'); return;
  }
  const stateDir = values.ephemeral ? undefined : resolve(values['state-dir'] ?? join('.ripple', new NodeIdentityProvider().hash(resolve(values.vault)).slice(0, 16)));
  const workspace = await openVault(values.vault, { ...(stateDir ? { stateDir } : {}), allMarkdown: values['all-markdown'] });
  const playground = new Playground(workspace.service);
  if (stateDir) {
    try { playground.session.importState(JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  console.log(`Ripple | ${workspace.service.listDocuments().length} documents | semantic: not-configured`);
  for (const warning of workspace.sources.warnings) console.error(warning);
  const save = async (): Promise<void> => {
    await workspace.save();
    if (stateDir) await atomicJson(join(stateDir, 'session.json'), playground.session.exportState());
  };
  await save();
  const execute = async (line: string, strict: boolean): Promise<boolean> => {
    try {
      const result = playground.execute(line);
      if (result.output) console.log(result.output);
      await save(); return !result.quit;
    } catch (error) {
      if (strict) throw error;
      console.error(`${error instanceof KernelError ? error.code : 'ERROR'}: ${(error as Error).message}`); return true;
    }
  };
  if (values.commands) {
    for (const line of (await readFile(values.commands, 'utf8')).split(/\r?\n/)) {
      if (line.trim() && !line.trim().startsWith('#')) console.log(`> ${line}`);
      if (!await execute(line, true)) break;
    }
  } else {
    const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (process.stdin.isTTY) { readline.setPrompt('ripple> '); readline.prompt(); }
    for await (const line of readline) {
      if (!await execute(line, !process.stdin.isTTY)) { readline.close(); break; }
      if (process.stdin.isTTY) readline.prompt();
    }
  }
}
main().catch(error => { console.error(`${error instanceof KernelError ? error.code : 'ERROR'}: ${(error as Error).message}`); process.exitCode = 1; });
