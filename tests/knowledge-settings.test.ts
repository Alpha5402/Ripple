import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeFilter } from '../packages/ingestion/knowledge-filter.js';
import { readVault } from '../packages/adapters/filesystem/index.js';
import { NodeWorkspace } from '../packages/host/node-workspace.js';
import { createPublicBridge } from '../packages/workbench/public-bridge.js';
import { readDirectory, type DirectoryHandle } from '../packages/workbench/browser-workspaces.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../packages/core/embedding/config.js';
import type { EmbeddingProvider, ModelDescriptor } from '../packages/core/embedding/model.js';
import { kernel, document } from './helpers.js';
import type { WorkbenchState } from '../packages/host/contract.js';

const descriptor: ModelDescriptor = { model: 'settings-fixture', revision: '1', dimensions: 2, normalized: true, modalities: ['text'], maxInputTokens: 512, representation: 'fixture', tokenizer: 'fixture' };
function provider(model = descriptor.model): EmbeddingProvider {
  return { descriptor: { ...descriptor, model }, countTokens: async inputs => inputs.map(i => i.text.length), embed: async inputs => inputs.map(() => [1, 0]) };
}
const source = '# Visible\nSecret [[private/secret|explicit target]]';

test('gitignore rules support rooted directories, arbitrary depth, wildcards, comments and parent-aware exceptions', () => {
  const excluded = knowledgeFilter('# comment\n/Archive/\n**/drafts/\n*.tmp.md\nnotes/*\n!notes/keep.md');
  for (const path of ['Archive/a.md', 'Archive/nested/b.md', 'drafts/a.md', 'nested/drafts/a.md', 'a.tmp.md', 'nested/a.tmp.md', 'notes/drop.md']) assert.ok(excluded(path), path);
  for (const path of ['nested/Archive/a.md', 'notes/keep.md', 'source.md']) assert.ok(!excluded(path), path);
  assert.ok(knowledgeFilter('private/\n!private/keep.md')('private/keep.md'), 'excluded parents cannot be bypassed by a file exception');
  assert.ok(!knowledgeFilter('private/*\n!private/keep.md')('private/keep.md'));
  assert.ok(excluded('Archive', true));
  assert.throws(() => excluded('../outside.md')); assert.throws(() => knowledgeFilter('x\0y'));
});

test('desktop settings remove references and all model vectors, persist across restart, and allow including everything again', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ripple-exclude-')), root = join(temp, 'vault'), stateDir = join(temp, 'state');
  await mkdir(join(root, 'private'), { recursive: true });
  await writeFile(join(root, 'visible.md'), source); await writeFile(join(root, 'private/secret.md'), '# Secret\nConfidential subject.');
  let host = await NodeWorkspace.open(root, { stateDir, readOnly: true, watch: false });
  try {
    const secret = host.service.resolveEntity('Secret').candidates[0]!.documentId;
    const visible = host.service.resolveEntity('Visible').candidates[0]!.documentId;
    assert.equal(host.service.getRelations(visible).length, 1);
    for (const name of ['model-a', 'model-b']) { host.service.configureEmbedding(provider(name), structuredClone(DEFAULT_EMBEDDING_CONFIG)); await host.service.indexEmbeddings(); }
    assert.equal(Object.keys(host.service.exportState().embedding!.spaces).length, 2);
    await host.command({ type: 'configure-knowledge', ignoreRules: 'private/' });
    assert.equal(host.service.listDocuments().length, 1); assert.equal(host.service.getNode(secret), undefined);
    assert.equal(host.service.getRelations(visible).length, 0);
    assert.equal(host.service.findWikiLinks({ sourceDocumentId: visible })[0]!.resolution.status, 'missing');
    assert.equal(host.service.search('Confidential').length, 0);
    for (const space of Object.values(host.service.exportState().embedding!.spaces)) {
      assert.ok(space.records.every(r => r.unit.documentId !== secret)); assert.equal(space.documents[secret], undefined);
    }
    // A subsequent active engine publish cannot resurrect vectors from the excluded note.
    await host.service.indexEmbeddings();
    assert.ok(Object.values(host.service.exportState().embedding!.spaces).every(s => s.records.every(r => r.unit.documentId !== secret)));
    assert.equal(await readFile(join(root, 'visible.md'), 'utf8'), source);
    assert.equal(await readFile(join(root, 'private/secret.md'), 'utf8'), '# Secret\nConfidential subject.');
    await host.close(); host = await NodeWorkspace.open(root, { stateDir, readOnly: true, watch: false });
    assert.equal(host.state().knowledgeSettings!.ignoreRules, 'private/'); assert.equal(host.state().documents.length, 1);
    await host.command({ type: 'configure-knowledge', ignoreRules: '**' });
    assert.equal(host.state().documents.length, 0); assert.equal(host.state().current, null);
    await host.command({ type: 'configure-knowledge', ignoreRules: '' });
    assert.equal(host.state().documents.length, 2); assert.ok(host.state().current, 'empty workspace can recover a focus');
    assert.equal(host.service.getRelations(host.service.resolveEntity('Visible').candidates[0]!.documentId).length, 1);
  } finally { await host.close(); await rm(temp, { recursive: true, force: true }); }
});

test('filesystem exclusions happen before reading content, including invalid UTF-8 in excluded directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ripple-scan-filter-'));
  try {
    await mkdir(join(root, 'skip')); await writeFile(join(root, 'skip/bad.md'), Buffer.from([0xff])); await writeFile(join(root, 'valid.md'), '# Valid');
    const result = await readVault(root, { allMarkdown: true, ignoreRules: 'skip/' });
    assert.deepEqual(result.inputs.map(d => d.path), ['valid.md']); assert.deepEqual(result.excludedPaths, ['skip/']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser exclusions survive restart, cannot leak back through source synchronization, and can be undone without losing local text', async () => {
  const service = kernel(document('visible', source, 'visible.md'), document('secret', '# Secret\nOriginal secret.', 'private/secret.md'));
  service.configureEmbedding(provider(), structuredClone(DEFAULT_EMBEDDING_CONFIG)); await service.indexEmbeddings();
  const bundle = { schemaVersion: 1 as const, id: 'settings-browser', title: 'Settings', generatedAt: '', scorePolicy: service.scorePolicy, documents: service.listDocuments().map(({ id, path, markdown }) => ({ id, path, markdown })) };
  const initial = { kernel: service.exportState(), session: { schemaVersion: 1 as const, current: null, backStack: [] } };
  const first = createPublicBridge(bundle, { initial });
  await first.command({ type: 'save', id: 'secret', expectedHash: service.getNode('secret')!.contentHash, markdown: '# Secret\nLocal edit kept.' });
  const result = await first.command({ type: 'configure-knowledge', ignoreRules: 'private/' }) as WorkbenchState;
  assert.equal(result.documents.length, 1); assert.equal(result.visible!.relations.length, 0);
  assert.ok(Object.values(first.snapshot().kernel.embedding!.spaces).every(s => s.records.every(r => r.unit.documentId !== 'secret')));
  await first.syncDocuments([{ path: 'visible.md', markdown: source }, { path: 'private/new.md', markdown: '# HiddenNew' }]);
  assert.equal((await first.command({ type: 'state' }) as WorkbenchState).documents.length, 1);
  const restored = createPublicBridge(bundle, { initial: JSON.parse(JSON.stringify(first.snapshot())) });
  assert.equal(restored.snapshot().ignoreRules, 'private/'); assert.equal(restored.snapshot().kernel.documents.length, 1);
  await restored.command({ type: 'configure-knowledge', ignoreRules: '' });
  assert.equal(restored.snapshot().kernel.documents.length, 3);
  assert.equal(restored.snapshot().kernel.documents.find(d => d.id === 'secret')!.markdown, '# Secret\nLocal edit kept.');
  assert.equal(restored.snapshot().excludedDocuments!.length, 0);
  await first.dispose(); await restored.dispose();
});

test('browser directory traversal skips excluded folders before enumerating or reading their files', async () => {
  let reads = 0;
  const skipped = { name: 'private', kind: 'directory', async *values() { throw new Error('Excluded folder should not be traversed'); } };
  const root = { name: 'vault', kind: 'directory', async *values() {
    yield skipped; yield { kind: 'file', name: 'public.md', async getFile() { reads++; return new File(['# Public'], 'public.md'); } };
  } } as unknown as DirectoryHandle;
  assert.deepEqual(await readDirectory(root, 'private/'), [{ path: 'public.md', markdown: '# Public' }]); assert.equal(reads, 1);
});

test('applying exclusions during indexing cancels the current request and publishes only the remaining scope', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ripple-exclude-active-')), root = join(temp, 'vault');
  await mkdir(root); await writeFile(join(root, 'secret.md'), '# Secret\nText that must leave the index.');
  const host = await NodeWorkspace.open(root, { stateDir: join(temp, 'state'), readOnly: true, watch: false });
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  let aborted = false;
  const slow = provider(); slow.embed = async (_inputs, { signal }) => {
    began(); return await new Promise<number[][]>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true });
    });
  };
  try {
    host.service.configureEmbedding(slow, structuredClone(DEFAULT_EMBEDDING_CONFIG));
    await host.command({ type: 'index' }); await started;
    await host.command({ type: 'configure-knowledge', ignoreRules: '*.md' });
    assert.ok(aborted); assert.equal(host.state().documents.length, 0);
    assert.equal(host.state().indexing, false);
    assert.ok(Object.values(host.service.exportState().embedding!.spaces).every(s => s.records.length === 0));
  } finally { await host.close(); await rm(temp, { recursive: true, force: true }); }
});
