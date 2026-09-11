import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { document, kernel } from './helpers.js';
import { DEFAULT_EMBEDDING_CONFIG, createEmbeddingSpace } from '../packages/core/embedding/config.js';
import { EmbeddingError, type EmbeddingConfig, type EmbeddingInput, type EmbeddingProvider, type ModelDescriptor } from '../packages/core/embedding/model.js';
import { NodeIdentityProvider } from '../packages/adapters/node/index.js';

const descriptor: ModelDescriptor = { model: 'fixture-vectors', revision: 'test-v1', dimensions: 3, normalized: true, modalities: ['text', 'image'], maxInputTokens: 512, representation: 'test-document-v1', tokenizer: 'test-codepoints' };
class FixtureProvider implements EmbeddingProvider {
  readonly descriptor = structuredClone(descriptor);
  calls: EmbeddingInput[][] = [];
  countTokens = async (inputs: EmbeddingInput[]) => inputs.map(input => [...input.text].length + 8 + input.images.length * 32);
  async embed(inputs: EmbeddingInput[]): Promise<number[][]> {
    this.calls.push(structuredClone(inputs));
    return inputs.map(input => input.text.includes('ocean') ? [0, 1, 0] : [1, 0, 0]);
  }
}
const config = (): EmbeddingConfig => ({ ...structuredClone(DEFAULT_EMBEDDING_CONFIG), execution: { batchSize: 2, maxRetries: 2, retryDelayMs: 0 } });

test('space identity isolates model, revision, representation, dimensionality, modality and chunking, independently of JSON key order', () => {
  const identity = new NodeIdentityProvider();
  const original = createEmbeddingSpace(descriptor, config(), identity).id;
  const reordered = Object.fromEntries(Object.entries(descriptor).reverse()) as unknown as ModelDescriptor;
  assert.equal(createEmbeddingSpace(reordered, config(), identity).id, original);
  for (const change of [{ revision: 'v2' }, { dimensions: 4 }, { representation: 'different' }]) assert.notEqual(createEmbeddingSpace({ ...descriptor, ...change }, config(), identity).id, original);
  assert.notEqual(createEmbeddingSpace(descriptor, { ...config(), mode: 'multimodal' }, identity).id, original);
  const smaller = config(); smaller.chunking.maxTokens = 100;
  assert.notEqual(createEmbeddingSpace(descriptor, smaller, identity).id, original);
  const ranking = config(); ranking.retrieval.candidateBudget = 10;
  assert.equal(createEmbeddingSpace(descriptor, ranking, identity).id, original, 'retrieval policy does not change the vector representation');
});

test('semantic-only relations enter the same one-hop engine with both contributing source locations', async () => {
  const service = kernel(document('a', '# Alpha\nA promise-like asynchronous outcome.'), document('b', '# Beta\nContinuations run after completion.'), document('c', '# Gamma\nThe ocean is blue.'));
  assert.equal(service.getRelations('a').length, 0);
  service.configureEmbedding(new FixtureProvider(), config());
  assert.equal(service.capabilities.semantic, 'pending');
  const report = await service.indexEmbeddings();
  assert.equal(report.encoded, 3);
  assert.equal(service.capabilities.semantic, 'ready');
  const relation = service.getRelations('a')[0]!;
  assert.deepEqual(relation.nodes, ['a', 'b']);
  assert.equal(relation.signals[0]!.kind, 'semantic');
  assert.equal(relation.components.mention, 0); assert.equal(relation.components.explicit, 0);
  assert.equal(relation.signals[0]!.evidence.length, 2);
  assert.ok(relation.signals[0]!.evidence.every(e => service.getEvidence(e).status === 'valid'));
  assert.deepEqual(service.getRelations('b')[0], relation);
});

test('long sections split without truncation, preserve source coverage, and carry heading context within token budget', async () => {
  const markdown = '---\naliases: [MetadataOnly]\n---\n# Long\n\n' + '中文😀 paragraph. '.repeat(40);
  const service = kernel(document('long', markdown));
  const small = config(); small.chunking.maxTokens = 80;
  const provider = new FixtureProvider(); service.configureEmbedding(provider, small);
  await service.indexEmbeddings();
  const units = service.getKnowledgeUnits('long').sort((a, b) => a.evidence.start - b.evidence.start);
  assert.ok(units.length > 4);
  assert.ok(units.every(unit => unit.tokenCount <= 80 && unit.text.startsWith('Long\n\n') && !unit.text.includes('MetadataOnly')));
  assert.equal(units.map(unit => service.getEvidence(unit.evidence).text).join(''), markdown.slice(markdown.indexOf('# Long')));
  assert.ok(units.every(unit => !/[\uD800-\uDBFF]$/.test(service.getEvidence(unit.evidence).text!)));
});

test('Text Only uses image alt text without resolving media; MultiModal adds image-context units and a different space', async () => {
  const service = kernel(document('a', '# Alpha\n\n![A chart](plot.png)\n\nCaption with context.'));
  let resolves = 0;
  const resolver = { resolve: async () => { resolves++; return { dataUrl: 'data:image/png;base64,AA==', contentHash: 'image-v1', mimeType: 'image/png' }; } };
  const provider = new FixtureProvider(); service.configureEmbedding(provider, config(), resolver);
  await service.indexEmbeddings();
  const textSpace = service.getEmbeddingCoverage().spaceId;
  assert.equal(resolves, 0);
  assert.ok(provider.calls.flat().every(input => input.images.length === 0 && !input.text.includes('plot.png')));
  assert.equal(service.getKnowledgeUnits().length, 1);
  service.configureEmbedding(provider, { ...config(), mode: 'multimodal' }, resolver);
  await service.indexEmbeddings();
  assert.notEqual(service.getEmbeddingCoverage().spaceId, textSpace);
  assert.equal(resolves, 1);
  const image = service.getKnowledgeUnits().find(unit => unit.kind === 'image-context')!;
  assert.ok(image.text.includes('Caption with context'));
  assert.equal(image.media[0]!.contentHash, 'image-v1');
  assert.equal(service.getEvidence(image.media[0]!.evidence).text, '![A chart](plot.png)');
});

test('multimodal mode fails explicitly for text-only providers; missing media records partial coverage without dropping text', async () => {
  const provider = new FixtureProvider(); provider.descriptor.modalities = ['text'];
  const service = kernel(document('a', '# Alpha\n![diagram](missing.png)'));
  assert.throws(() => service.configureEmbedding(provider, { ...config(), mode: 'multimodal' }), /support/);
  service.configureEmbedding(new FixtureProvider(), { ...config(), mode: 'multimodal' });
  await service.indexEmbeddings();
  assert.equal(service.getEmbeddingCoverage().documents.a!.status, 'partial');
  assert.equal(service.getEmbeddingCoverage().documents.a!.errors[0]!.code, 'CAPABILITY');
  assert.equal(service.getKnowledgeUnits().length, 1);
});

test('incremental indexing reuses unchanged sections, refreshes source revisions, and keeps no-op indexing idempotent', async () => {
  const service = kernel(document('a', '# Alpha\n\nStable.\n\n## Detail\nFirst.'), document('b', '# Beta\nOther.'));
  const provider = new FixtureProvider(); service.configureEmbedding(provider, config());
  const first = await service.indexEmbeddings();
  assert.equal(first.encoded, 3);
  const revision = service.indexRevision;
  const second = await service.indexEmbeddings();
  assert.equal(second.encoded, 0); assert.equal(second.reused, 3);
  assert.equal(service.indexRevision, revision);
  service.ingestDocument(document('a', '# Alpha\n\nStable.\n\n## Detail\nChanged.'));
  assert.equal(service.getEmbeddingCoverage().documents.a!.status, 'stale');
  const changed = await service.indexEmbeddings();
  assert.equal(changed.encoded, 1); assert.equal(changed.reused, 2);
  assert.ok(service.getKnowledgeUnits('a').every(unit => unit.revision === 2 && service.getEvidence(unit.evidence).status === 'valid'));
});

test('changed attachment bytes re-embed only the image-context unit', async () => {
  const service = kernel(document('a', '# Alpha\n![diagram](image.png)'));
  let imageHash = 'v1';
  const resolver = { resolve: async () => ({ dataUrl: 'data:image/png;base64,AA==', contentHash: imageHash, mimeType: 'image/png' }) };
  service.configureEmbedding(new FixtureProvider(), { ...config(), mode: 'multimodal' }, resolver);
  await service.indexEmbeddings(); imageHash = 'v2';
  const changed = await service.indexEmbeddings();
  assert.equal(changed.encoded, 1); assert.equal(changed.reused, 1);
});

test('late responses cannot overwrite a newer document version even if the provider ignores abort', async () => {
  const service = kernel(document('a', '# Alpha\nOld.'));
  let complete!: (vectors: number[][]) => void;
  const provider = new FixtureProvider();
  provider.embed = async () => new Promise(resolve => { complete = resolve; });
  service.configureEmbedding(provider, config());
  const old = service.indexEmbeddings();
  while (!complete) await setImmediate();
  service.ingestDocument(document('a', '# Alpha\nNew.'));
  complete([[1, 0, 0]]);
  const report = await old;
  assert.equal(report.cancelled, true); assert.ok(report.discarded > 0);
  assert.equal(service.getKnowledgeUnits().length, 0);
  provider.embed = async inputs => inputs.map(() => [0, 1, 0]);
  await service.indexEmbeddings();
  assert.equal(service.getKnowledgeUnits()[0]!.revision, 2);
});

test('switching model during inference isolates late results and can return to a cached space', async () => {
  const service = kernel(document('a', '# Alpha\nContent.'));
  let complete!: (vectors: number[][]) => void;
  const first = new FixtureProvider(); first.embed = async () => new Promise(resolve => { complete = resolve; });
  service.configureEmbedding(first, config()); const old = service.indexEmbeddings();
  while (!complete) await setImmediate();
  const second = new FixtureProvider(); second.descriptor.revision = 'test-v2';
  service.configureEmbedding(second, config()); await service.indexEmbeddings();
  const space = service.getEmbeddingCoverage().spaceId;
  complete([[1, 0, 0]]); await old;
  assert.equal(service.getEmbeddingCoverage().spaceId, space);
  assert.equal(service.getKnowledgeUnits().length, 1);
  const third = new FixtureProvider(); service.configureEmbedding(third, config());
  assert.equal((await service.indexEmbeddings()).encoded, 1);
  service.configureEmbedding(second, config());
  assert.equal((await service.indexEmbeddings()).encoded, 0);
});

test('transient failures retry within a bound, permanent failures keep deterministic relations available', async () => {
  const service = kernel(document('a', '# Alpha\nBeta'), document('b', '# Beta'));
  const provider = new FixtureProvider(); let attempts = 0;
  provider.embed = async inputs => { if (++attempts < 3) throw new EmbeddingError('NETWORK', 'temporary', true); return inputs.map(() => [1, 0, 0]); };
  service.configureEmbedding(provider, config()); await service.indexEmbeddings({ documentIds: ['a'] });
  assert.equal(attempts, 3);
  const permanent = new FixtureProvider(); permanent.descriptor.revision = 'broken'; let denied = 0;
  permanent.embed = async () => { denied++; throw new EmbeddingError('AUTH', 'denied'); };
  service.configureEmbedding(permanent, config()); const report = await service.indexEmbeddings({ documentIds: ['a'] });
  assert.equal(denied, 1); assert.equal(report.documents.a!.status, 'error');
  assert.equal(service.getRelations('a')[0]!.components.mention, 0.5);
  assert.equal(service.getNode('a')!.markdown, '# Alpha\nBeta');
});

test('invalid, non-finite, zero and wrong-dimensional vectors are rejected', async () => {
  for (const vector of [[0, 0, 0], [NaN, 0, 1], [1, 0], [2, 0, 0]]) {
    const service = kernel(document('a', '# Alpha'));
    const provider = new FixtureProvider(); provider.embed = async () => [vector];
    service.configureEmbedding(provider, config()); const report = await service.indexEmbeddings();
    assert.equal(report.documents.a!.errors[0]!.code, 'INVALID_RESPONSE');
    assert.equal(service.getKnowledgeUnits().length, 0);
  }
});

test('document candidate budget deduplicates long-document units and does not cap deterministic links', async () => {
  const service = kernel(document('a', '# Alpha\nBeta Gamma Delta'),
    document('b', '# Beta\n' + Array.from({ length: 12 }, (_, i) => `\n## Section${i}\nText.`).join('')),
    document('c', '# Gamma\nText.'), document('d', '# Delta\nText.'), document('e', '# Epsilon\nText.'));
  const bounded = config(); bounded.retrieval.candidateBudget = 2;
  service.configureEmbedding(new FixtureProvider(), bounded); await service.indexEmbeddings();
  const relations = service.getRelations('a');
  assert.ok(relations.length >= 3, 'all deterministic targets survive semantic recall budget');
  assert.equal(new Set(relations.map(r => r.id)).size, relations.length);
  const e = service.getRelations('e');
  assert.equal(e.length, 2, 'semantic-only candidate pool is document-level');
});

test('semantic refresh preserves fixed snapshot membership; model changes withdraw old semantic evidence', async () => {
  const service = kernel(document('a', '# Alpha\nBeta'), document('b', '# Beta'), document('c', '# Gamma'));
  const before = service.createExplorationSnapshot('a', { lensValue: 100 });
  service.configureEmbedding(new FixtureProvider(), config()); await service.indexEmbeddings();
  assert.equal(service.getVisibleRelations(before).relations.length, 1);
  assert.equal(service.getVisibleRelations(before).status, 'stale');
  const after = service.createExplorationSnapshot('a', { lensValue: 100 });
  assert.equal(service.getVisibleRelations(after).relations.length, 2);
  service.disableEmbedding();
  assert.equal(service.getVisibleRelations(after).relations.length, 0);
  assert.equal(service.getRelations('a').length, 1);
});

test('pre-cancelled indexing never calls provider and is reported as cancelled', async () => {
  const service = kernel(document('a', '# Alpha')); const provider = new FixtureProvider();
  service.configureEmbedding(provider, config());
  const controller = new AbortController(); controller.abort();
  const report = await service.indexEmbeddings({ signal: controller.signal });
  assert.equal(report.cancelled, true); assert.equal(provider.calls.length, 0);
  assert.equal(service.getEmbeddingCoverage().documents.a!.status, 'cancelled');
});

test('tokenizer outages retain valid cached vectors but never revive vectors for an edited revision', async () => {
  const service = kernel(document('a', '# Alpha\nStable.'), document('b', '# Beta\nContent.'));
  const provider = new FixtureProvider(); service.configureEmbedding(provider, config()); await service.indexEmbeddings();
  provider.countTokens = async () => { throw new EmbeddingError('NETWORK', 'offline'); };
  const failed = await service.indexEmbeddings();
  assert.equal(failed.documents.a!.status, 'partial');
  assert.equal(service.getKnowledgeUnits().length, 2);
  assert.equal(service.getRelations('a').length, 1);
  service.ingestDocument(document('a', '# Alpha\nChanged.'));
  await service.indexEmbeddings();
  assert.equal(service.getKnowledgeUnits('a').length, 0);
  assert.equal(service.getKnowledgeUnits('b').length, 1);
});
