import { atomicJson } from './atomic-json.js';
export { atomicJson } from './atomic-json.js';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute, sep } from 'node:path';
import { KnowledgeService } from '../../core/service.js';
import { KernelError, type KernelState, type UserDeclarations } from '../../core/model.js';
import { MemoryStorage } from '../storage-memory/index.js';
import { RemarkMarkdownParser } from '../parser-markdown/index.js';
import { NodeIdentityProvider } from '../runtime-node/index.js';
import { readVault } from './index.js';
import { DEFAULT_SCORE_POLICY } from '../../core/relation.js';
import type { EmbeddingCache } from '../../core/embedding/model.js';

interface Manifest {
  schemaVersion: 1;
  vaultRoot: string;
  documents: { id: string; path: string; revision: number; contentHash: string }[];
  revisions: Record<string, number>;
  validityEpochs: Record<string, number>;
  indexRevision: number;
  userPolicyRevision: number;
  parserVersion: string;
  scorePolicyVersion: string;
  declarationsHash: string;
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** Persists durable identity/intent only; parse and relation indexes are rebuilt from read-only source files. */
export async function openVault(root: string, options: { stateDir?: string; allMarkdown?: boolean } = {}) {
  const vaultRoot = resolve(root);
  const stateDir = options.stateDir ? resolve(options.stateDir) : undefined;
  if (stateDir) {
    const inside = relative(vaultRoot, stateDir);
    if (!inside || (!(inside === '..' || inside.startsWith(`..${sep}`)) && !isAbsolute(inside))) throw new KernelError('INVALID_INPUT', 'State directory must be outside the read-only vault');
  }
  const sources = await readVault(vaultRoot, options);
  const manifest = stateDir ? await readJson<Manifest>(join(stateDir, 'manifest.json')) : undefined;
  if (manifest && (manifest.schemaVersion !== 1 || manifest.vaultRoot !== vaultRoot)) throw new KernelError('INVALID_INPUT', 'Manifest belongs to another vault or schema');
  const declarations = (stateDir ? await readJson<UserDeclarations>(join(stateDir, 'user-relations.json')) : undefined)
    ?? { schemaVersion: 1 as const, aliases: [], relations: {} };
  const parser = new RemarkMarkdownParser();
  const identity = new NodeIdentityProvider();
  const initial: KernelState = {
    documents: [], declarations, revisions: { ...manifest?.revisions }, validityEpochs: { ...manifest?.validityEpochs },
    indexRevision: manifest?.indexRevision ?? 0, userPolicyRevision: manifest?.userPolicyRevision ?? 0,
  };
  const embedding = stateDir ? await readJson<EmbeddingCache>(join(stateDir, 'cache/embeddings.json')) : undefined;
  if (embedding?.schemaVersion === 1) initial.embedding = embedding;
  if (manifest && (manifest.parserVersion !== parser.version || manifest.scorePolicyVersion !== DEFAULT_SCORE_POLICY.version)) initial.indexRevision++;
  if (manifest && manifest.declarationsHash !== identity.hash(JSON.stringify(declarations))) {
    initial.indexRevision++; initial.userPolicyRevision++;
  }
  const previousByPath = new Map(manifest?.documents.map(doc => [doc.path, doc]));
  const inputs = sources.inputs.map(input => {
    const previous = previousByPath.get(input.path);
    if (previous && previous.contentHash === identity.hash(input.markdown)) {
      initial.documents.push({ ...previous, markdown: input.markdown, parsed: parser.parse(previous.id, input.path, input.markdown) });
    }
    return { ...input, id: previous?.id ?? identity.newId() };
  });
  let deleted = false;
  const currentPaths = new Set(inputs.map(input => input.path));
  for (const doc of manifest?.documents ?? []) if (!currentPaths.has(doc.path)) {
    initial.validityEpochs[doc.id] = (initial.validityEpochs[doc.id] ?? 0) + 1; deleted = true;
  }
  if (deleted) initial.indexRevision++;
  const storage = new MemoryStorage(initial);
  const service = new KnowledgeService({ storage, parser, identity });
  service.ingestDocuments(inputs);
  const save = async (): Promise<void> => {
    if (!stateDir) return;
    await mkdir(stateDir, { recursive: true });
    const state = storage.load();
    const next: Manifest = {
      schemaVersion: 1, vaultRoot,
      documents: state.documents.map(({ id, path, revision, contentHash }) => ({ id, path, revision, contentHash })),
      revisions: state.revisions, validityEpochs: state.validityEpochs,
      indexRevision: state.indexRevision, userPolicyRevision: state.userPolicyRevision,
      parserVersion: parser.version, scorePolicyVersion: service.scorePolicy.version,
      declarationsHash: identity.hash(JSON.stringify(state.declarations)),
    };
    await atomicJson(join(stateDir, 'manifest.json'), next);
    await atomicJson(join(stateDir, 'user-relations.json'), state.declarations);
    if (state.embedding) {
      await mkdir(join(stateDir, 'cache'), { recursive: true });
      await atomicJson(join(stateDir, 'cache/embeddings.json'), state.embedding);
    }
  };
  return { service, sources, save, stateDir };
}
