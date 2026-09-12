import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { openSqliteVault } from '../../packages/adapters/filesystem/sqlite-workspace.js';
import { openVault, atomicJson } from '../../packages/adapters/filesystem/workspace.js';
import { NodeIdentityProvider } from '../../packages/adapters/runtime-node/index.js';
import { Playground } from './controller.js';
import { KernelError } from '../../packages/core/model.js';
import { configureEmbeddingFromFile } from '../../packages/adapters/embedding-http/config.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    vault: { type: 'string', default: 'fixtures/vault' },
    commands: { type: 'string' }, 'state-dir': { type: 'string' },
    ephemeral: { type: 'boolean', default: false }, 'all-markdown': { type: 'boolean', default: false },
    storage: { type: 'string', default: 'sqlite' },
    help: { type: 'boolean', default: false },
    embedding: { type: 'string' }, index: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Ripple Knowledge Playground\n--vault <directory> [--commands <file>] [--state-dir <outside-vault directory>] [--storage json|sqlite] [--ephemeral] [--all-markdown] [--embedding <config.json>] [--index]'); return;
  }
  const stateDir = values.ephemeral ? undefined : resolve(values['state-dir'] ?? join('.ripple', new NodeIdentityProvider().hash(resolve(values.vault)).slice(0, 16)));
  if (!['json', 'sqlite'].includes(values.storage)) throw new KernelError('INVALID_INPUT', 'Storage must be json or sqlite');
  const workspace = values.storage === 'sqlite' && stateDir ? await openSqliteVault(values.vault, { stateDir, allMarkdown: values['all-markdown'] }) : await openVault(values.vault, { ...(stateDir ? { stateDir } : {}), allMarkdown: values['all-markdown'] });
  try {
    const playground = new Playground(workspace.service);
    if (values.embedding) {
      try { await configureEmbeddingFromFile(workspace.service, values.embedding, values.vault); }
      catch (error) { console.error(`Embedding configuration unavailable: ${(error as Error).message}. Deterministic knowledge remains available.`); }
    }
    if (values.index && workspace.service.capabilities.semantic !== 'not-configured') console.log(await playground.indexEmbeddings('all'));
    if (stateDir) {
      try { playground.session.importState(JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    console.log(`Ripple | ${workspace.service.listDocuments().length} documents | semantic: ${workspace.service.capabilities.semantic}`);
    for (const warning of workspace.sources.warnings) console.error(warning);
    const save = async (): Promise<void> => {
      await workspace.save();
      if (stateDir) await atomicJson(join(stateDir, 'session.json'), playground.session.exportState());
    };
    await save();
    const execute = async (line: string, strict: boolean): Promise<boolean> => {
      try {
        const search = line.trim().match(/^search(?:-(literal|exact))?\s+(.+)$/i);
        if (search) { console.log(JSON.stringify(workspace.service.search(search[2]!, { mode: (search[1]?.toLowerCase() as 'literal' | 'exact') ?? 'text' }), null, 2)); return true; }
        const index = line.trim().match(/^index(?:\s+(.*))?$/i);
        if (index) { console.log(await playground.indexEmbeddings(index[1] ?? 'all')); await save(); return true; }
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
  } finally { if ('close' in workspace && typeof workspace.close === 'function') workspace.close(); }
}
main().catch(error => { console.error(`${error instanceof KernelError ? error.code : 'ERROR'}: ${(error as Error).message}`); process.exitCode = 1; });
