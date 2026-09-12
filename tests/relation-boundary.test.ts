import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeService } from '../packages/core/service.js';
import { MemoryStorage, RemarkMarkdownParser, NodeIdentityProvider } from '../packages/adapters/node/index.js';
import { retrieveSemanticCandidates } from '../packages/core/relation/semantic-candidate.js';
import { detectSignificantGap } from '../packages/core/relation/gap-detector.js';
import { defaultBoundaryConfig } from '../packages/core/relation/relation-boundary.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../packages/core/embedding/config.js';
import type { EmbeddingProvider, EmbeddingInput } from '../packages/core/embedding/model.js';
import { document } from './helpers.js';

const strong = ['请求伪造', '内网探测', '云元数据', '地址校验', 'DNS重绑定', '协议限制', '重定向防护'];
const weak = ['Vite', 'Source Map', 'Web Storage'];
async function fixture(scores = [.94, .92, .90, .88, .86, .84, .82, .64, .63, .62], deterministic = false) {
  let retrievals = 0, embeddings = 0;
  const service = new KnowledgeService({ storage: new MemoryStorage(), parser: new RemarkMarkdownParser(), identity: new NodeIdentityProvider(),
    semanticRetriever(...args) { retrievals++; return retrieveSemanticCandidates(...args); } });
  const names = scores.length === 10 ? [...strong, ...weak] : scores.map((_, i) => `概念${i}`);
  const texts = ['# SSRF\n服务端请求伪造。' + (deterministic ? '\nVite [[Source Map|明确引用]]' : ''), ...names.map((name, i) => `# ${name}\n样本编号${i}。`)];
  service.ingestDocuments(texts.map((text, i) => document(`d${i}`, text)));
  const provider: EmbeddingProvider = {
    descriptor: { model: 'fixture-cosine', revision: '1', dimensions: scores.length + 1, normalized: true, modalities: ['text'], maxInputTokens: 1024, representation: 'fixture', tokenizer: 'fixture' },
    countTokens: async inputs => inputs.map(i => i.text.length),
    async embed(inputs: EmbeddingInput[]) { embeddings++; return inputs.map(input => {
      const rank = names.findIndex(name => input.text.startsWith(name + '\n'));
      if (rank < 0) return [1, ...scores.map(() => 0)];
      const vector = Array(scores.length + 1).fill(0); vector[0] = scores[rank]; vector[rank + 1] = Math.sqrt(1 - scores[rank]! ** 2); return vector;
    }); },
  };
  const config = structuredClone(DEFAULT_EMBEDDING_CONFIG); config.retrieval.boundary = defaultBoundaryConfig(provider.descriptor.model);
  service.configureEmbedding(provider, config); await service.indexEmbeddings();
  return { service, counts: () => ({ retrievals, embeddings }) };
}

test('SSRF: retrieval is a raw candidate pool; boundary removes weak tail at every Lens value without recall', async () => {
  const { service, counts } = await fixture();
  const snapshot = service.createExplorationSnapshot('d0', { lensValue: 0 });
  assert.equal(snapshot.semanticCandidatePool.candidates.length, 10);
  assert.ok(snapshot.semanticCandidatePool.candidates.every(c => !('signals' in c) && !('score' in c)));
  assert.equal(snapshot.relationBoundary.cutRank, 7);
  assert.equal(snapshot.validSemanticNeighborhood.length, 7);
  const before = counts(); let previous: string[] = [];
  for (let lens = 0; lens <= 100; lens++) {
    const view = service.getVisibleRelations(service.setLens(snapshot, lens));
    const ids = view.relations.map(r => r.id);
    assert.ok(previous.every(id => ids.includes(id)));
    assert.ok(view.relations.every(r => !r.nodes.some(id => ['d8', 'd9', 'd10'].includes(id))));
    previous = ids;
  }
  assert.equal(previous.length, 7); assert.deepEqual(counts(), before);
  service.ingestDocument(document('new', '# 新增\n新内容'));
  const stale = service.getVisibleRelations(service.setLens(snapshot, 100));
  assert.equal(stale.status, 'stale'); assert.deepEqual(stale.relations.map(r => r.id), previous);
  assert.deepEqual(counts(), before);
});

test('Mention and WikiLink survive even when the corresponding semantic signal fails the boundary', async () => {
  const { service } = await fixture(undefined, true);
  const snapshot = service.createExplorationSnapshot('d0', { lensValue: 100 });
  const view = service.getVisibleRelations(snapshot);
  for (const id of ['d8', 'd9']) {
    const relation = view.relations.find(r => r.nodes.includes(id))!;
    assert.ok(relation); assert.ok(relation.signals.every(s => s.kind !== 'semantic'));
  }
  assert.ok(!view.relations.some(r => r.nodes.includes('d10')));
});

test('ordinary fluctuations do not manufacture a boundary; rank-one outlier does not isolate one result', () => {
  assert.equal(detectSignificantGap([.90, .89, .875, .86, .845, .83]).boundaryRank, null);
  assert.equal(detectSignificantGap([.99, .80, .79, .78, .77, .76]).boundaryRank, null);
  assert.equal(detectSignificantGap([.99, .80, .79, .78, .60, .59, .58]).boundaryRank, 4);
});

test('low-similarity neighborhood is rejected by model floor even with a significant gap', async () => {
  const { service } = await fixture([.48, .47, .46, .39, .38, .37]);
  const snapshot = service.createExplorationSnapshot('d0', { lensValue: 100 });
  assert.equal(snapshot.relationBoundary.cutRank, 3);
  assert.equal(snapshot.validSemanticNeighborhood.length, 0);
  assert.equal(service.getVisibleRelations(snapshot).relations.length, 0);
});

test('natural neighborhood size is variable: a broad center admits 25 results rather than a fixed display K', async () => {
  const { service } = await fixture([...Array.from({ length: 25 }, (_, i) => .97 - i * .008), .60, .59, .58]);
  const snapshot = service.createExplorationSnapshot('d0', { lensValue: 100 });
  assert.equal(snapshot.relationBoundary.cutRank, 25);
  assert.equal(service.getVisibleRelations(snapshot).relations.length, 25);
});

test('cross edges use existing gated relations between visible nodes, and never fabricate a clique', () => {
  const service = new KnowledgeService({ storage: new MemoryStorage(), parser: new RemarkMarkdownParser(), identity: new NodeIdentityProvider() });
  service.ingestDocuments([document('a', '# Alpha\nBeta Gamma Delta'), document('b', '# Beta\nGamma'), document('c', '# Gamma'), document('d', '# Delta')]);
  const snapshot = service.createExplorationSnapshot('a', { lensValue: 100 });
  const visible = service.getVisibleRelations(snapshot);
  assert.equal(visible.relations.length, 3); assert.equal(visible.graphRelations.length, 4);
  assert.ok(visible.graphRelations.some(r => r.nodes.join(',') === 'b,c'));
  assert.ok(!visible.graphRelations.some(r => r.nodes.includes('d') && !r.nodes.includes('a')));
});

test('recorded WeMM SSRF distribution excludes Vite, Source Map and Web Storage', async () => {
  const { readFile } = await import('node:fs/promises');
  const recorded = JSON.parse(await readFile('fixtures/ssrf-cosine-distribution.json', 'utf8'));
  const { service } = await fixture(recorded.candidates.map((c: { similarity: number }) => c.similarity));
  const snapshot = service.createExplorationSnapshot('d0', { lensValue: 100 });
  assert.equal(snapshot.relationBoundary.cutRank, 2);
  for (const label of ['Vite', 'Source Map', 'Web Storage']) {
    const index = recorded.candidates.findIndex((c: { label: string }) => c.label === label);
    assert.ok(index >= 0);
    assert.ok(!snapshot.validSemanticNeighborhood.includes(`d${index + 1}`));
  }
});

test('boundary strategy can be replaced while the common quality floor remains enforced', async () => {
  const { applyRelationBoundary } = await import('../packages/core/relation/relation-boundary.js');
  const { service } = await fixture([.9, .8, .7, .4]);
  const pool = service.getSemanticNeighborhood('d0').pool;
  const config = { ...defaultBoundaryConfig(pool.model), strategy: 'fixed-threshold-test' };
  const boundary = applyRelationBoundary(pool, config, { id: config.strategy, version: '1', select(candidatePool) {
    return { ids: candidatePool.candidates.map(c => c.id), cutRank: null };
  } });
  assert.equal(boundary.decisions.filter(d => d.accepted).length, 3);
  assert.equal(boundary.strategy, 'fixed-threshold-test');
});
