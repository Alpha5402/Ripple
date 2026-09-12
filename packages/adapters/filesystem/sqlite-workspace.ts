import { mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, dirname, basename, join } from 'node:path';
import { KernelError } from '../../core/model.js';
import { KnowledgeService } from '../../core/service.js';
import { SqliteStorage } from '../storage-sqlite/index.js';
import { RemarkMarkdownParser } from '../parser-markdown/index.js';
import { NodeIdentityProvider } from '../runtime-node/index.js';
import { readVault } from './index.js';
import { openVault } from './workspace.js';

async function canonicalDestination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}
export async function openSqliteVault(root: string, options: { stateDir: string; allMarkdown?: boolean; ignoreRules?: string }) {
  const vaultRoot = await realpath(resolve(root)), stateDir = await canonicalDestination(resolve(options.stateDir));
  const inside = relative(vaultRoot, stateDir);
  if (!inside || (!(inside === '..' || inside.startsWith(`..${sep}`)) && !isAbsolute(inside))) throw new KernelError('INVALID_INPUT', 'State directory must be outside the read-only vault');
  await mkdir(stateDir, { recursive: true });
  const storage = new SqliteStorage(join(stateDir, 'kernel.sqlite'), { namespace: vaultRoot });
  try {
    // One-time import of K1–K4 identity, declarations and vector caches; legacy files remain untouched.
    if (!storage.load().documents.length && storage.load().indexRevision === 0) {
      let legacy = false;
      try { await stat(join(stateDir, 'manifest.json')); legacy = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (legacy) { const workspace = await openVault(root, { ...options, stateDir }); storage.save(workspace.service.exportState()); }
    }
    const sources = await readVault(vaultRoot, options);
    const service = new KnowledgeService({ storage, search: storage, parser: new RemarkMarkdownParser(), identity: new NodeIdentityProvider() });
    const paths = new Set(sources.inputs.map(input => input.path));
    service.removeDocuments(service.listDocuments().filter(doc => !paths.has(doc.path)).map(doc => doc.id));
    service.ingestDocuments(sources.inputs);
    return { service, sources, stateDir, save: async (): Promise<void> => {}, close: (): void => storage.close() };
  } catch (error) { storage.close(); throw error; }
}
