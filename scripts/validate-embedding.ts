import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createNodeKernel } from '../packages/adapters/node/index.js';
import { HttpEmbeddingProvider } from '../packages/adapters/embedding-http/index.js';
import { LocalMediaResolver } from '../packages/adapters/filesystem/media.js';
import { readVault } from '../packages/adapters/filesystem/index.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../packages/core/embedding/config.js';
import type { EmbeddingInput, EmbeddingProvider } from '../packages/core/embedding/model.js';

const { values } = parseArgs({ options: { endpoint: { type: 'string', default: 'http://127.0.0.1:8787' }, vault: { type: 'string' } } });
const endpoint = new URL(values.endpoint);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('This validation sends private vault excerpts only to a loopback provider');
const output = resolve('reports/local/wemm-validation.json');
await mkdir(resolve('reports/local'), { recursive: true });
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), scope: 'Real WeMM runtime smoke test; no human quality labels or benchmark claims', stages: {} };
const stages = report.stages as Record<string, unknown>;
const checkpoint = async (): Promise<void> => { await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
const cosine = (a: number[], b: number[]): number => a.reduce((n, value, i) => n + value * b[i]!, 0);
try {
  const http = await HttpEmbeddingProvider.connect({ protocol: 'ripple', baseUrl: values.endpoint, timeoutMs: 180_000 });
  report.model = http.descriptor;
  const samples: { count: number; milliseconds: number; imageInputs: number }[] = [];
  const provider: EmbeddingProvider = { descriptor: http.descriptor, countTokens: (inputs, options) => http.countTokens(inputs, options),
    embed: async (inputs, options) => {
      const start = performance.now(); const result = await http.embed(inputs, options);
      samples.push({ count: inputs.length, milliseconds: performance.now() - start, imageInputs: inputs.filter(i => i.images.length).length });
      console.log(`Encoded ${inputs.length} units (${inputs.filter(i => i.images.length).length} image): ${Math.round(samples.at(-1)!.milliseconds)} ms`);
      return result;
    } };
  const config = structuredClone(DEFAULT_EMBEDDING_CONFIG); config.execution.batchSize = 1;
  const service = createNodeKernel();
  service.ingestDocuments([
    { id: 'alpha', path: 'Alpha.md', markdown: '# Alpha\n\nJavaScript runs a callback after the current call stack finishes. Promise continuations enter a queue drained before the next task.\n\n' },
    { id: 'beta', path: 'Beta.md', markdown: '# Beta\n\n在 JavaScript 中，当前同步代码执行完毕后，运行时会先清空微任务队列，再开始下一个任务；异步回调的先后由事件循环协调。' },
    { id: 'gamma', path: 'Gamma.md', markdown: '# Gamma\n\nWhales migrate through the deep ocean and feed on krill.' },
  ]);
  assert.equal(service.getRelations('alpha').length, 0);
  service.configureEmbedding(provider, config);
  const first = await service.indexEmbeddings();
  stages.text = { run: first, coverage: service.getEmbeddingCoverage(), relations: service.getRelations('alpha') };
  await checkpoint();
  assert.equal(first.encoded, 3); assert.equal(service.getEmbeddingCoverage().status, 'ready');
  const records = service.exportEmbeddingCache()!.spaces[service.getEmbeddingCoverage().spaceId!]!.records;
  const vector = (id: string) => records.find(r => r.unit.documentId === id)!.vector;
  const positiveCosine = cosine(vector('alpha'), vector('beta')), negativeCosine = cosine(vector('alpha'), vector('gamma'));
  stages.similarity = { positiveCosine, negativeCosine, expectedPositiveOutranksNegative: positiveCosine > negativeCosine };
  const negativeRelation = service.getRelations('alpha').find(r => r.nodes.includes('gamma'));
  stages.failureSamples = [{ case: 'JavaScript callback scheduling vs whales and krill', expected: 'unrelated', cosine: negativeCosine,
    recalled: !!negativeRelation, score: negativeRelation?.score, visibleAtLens70: (negativeRelation?.score ?? 0) >= 0.3,
    interpretation: 'The permissive uncalibrated baseline can expose irrelevant candidates; preserve for K5 instead of tuning on this smoke sample.' }];
  await checkpoint();
  assert.ok(positiveCosine > negativeCosine);
  const positive = service.getRelations('alpha').find(r => r.nodes.includes('beta'))!;
  assert.ok(positive); assert.ok(positive.signals.every(signal => signal.kind === 'semantic'));
  for (const signal of positive.signals) for (const evidence of signal.evidence) assert.equal(service.getEvidence(evidence).status, 'valid');
  const snapshot = service.createExplorationSnapshot('alpha', { lensValue: 100 });
  const second = await service.indexEmbeddings(); assert.equal(second.encoded, 0); assert.equal(second.reused, 3);
  const alpha = service.getNode('alpha')!;
  service.ingestDocument({ id: alpha.id, path: alpha.path, markdown: alpha.markdown + '## Rendering\nRendering can occur between tasks.' });
  assert.equal(service.getVisibleRelations(snapshot).status, 'invalid');
  const changed = await service.indexEmbeddings();
  assert.equal(changed.encoded, 1); assert.equal(changed.reused, 3);
  stages.incremental = { unchanged: second, editedInMemory: changed };
  await checkpoint();

  const fixtureRoot = resolve('fixtures/embedding');
  const fixture = createNodeKernel(); fixture.ingestDocuments((await readVault(fixtureRoot)).inputs);
  const visual = fixture.listDocuments().find(doc => doc.parsed.title === 'Visual Sample')!;
  fixture.configureEmbedding(provider, config, new LocalMediaResolver(fixtureRoot));
  const textOnly = await fixture.indexEmbeddings();
  const textSpaceId = fixture.getEmbeddingCoverage().spaceId;
  fixture.configureEmbedding(provider, { ...config, mode: 'multimodal' }, new LocalMediaResolver(fixtureRoot));
  const multiModal = await fixture.indexEmbeddings();
  stages.multimodal = { textOnly, multiModal, textSpaceId, multimodalSpaceId: fixture.getEmbeddingCoverage().spaceId,
    visualUnits: fixture.getKnowledgeUnits(visual.id), documentTitles: Object.fromEntries(fixture.listDocuments().map(doc => [doc.id, doc.parsed.title])), relations: fixture.getRelations(visual.id) };
  await checkpoint();
  assert.equal(fixture.getEmbeddingCoverage().status, 'ready');
  assert.notEqual(textSpaceId, fixture.getEmbeddingCoverage().spaceId);
  assert.equal(fixture.getKnowledgeUnits(visual.id).filter(unit => unit.kind === 'image-context').length, 1);
  // Detect image->text positional-cache contamination in a single long-lived model instance.
  const repeatInput: EmbeddingInput = { text: records.find(r => r.unit.documentId === 'beta')!.unit.text, images: [] };
  const repeated = (await provider.embed([repeatInput], { signal: new AbortController().signal }))[0]!;
  const repeatCosine = cosine(vector('beta'), repeated);
  stages.interleavedStability = { textBeforeAndAfterImageCosine: repeatCosine };
  assert.ok(repeatCosine > 0.999);
  await checkpoint();

  if (values.vault) {
    const sources = await readVault(values.vault);
    const chosen = sources.inputs.filter(input => ['Event Loop.md', 'Web Workers.md', 'Observable.md', '响应式编程.md'].some(name => input.path.endsWith('/' + name)));
    assert.equal(chosen.length, 4, 'Expected four selected Wiki articles');
    const wiki = createNodeKernel(); wiki.ingestDocuments(chosen); wiki.configureEmbedding(provider, config);
    const start = performance.now(); const result = await wiki.indexEmbeddings();
    const relations = [...new Map(wiki.listDocuments().flatMap(doc => wiki.getRelations(doc.id)).map(r => [r.id, r])).values()];
    const describe = (id: string): string => wiki.getNode(id)!.parsed.title;
    const discovered = relations.filter(r => r.signals.every(s => s.kind === 'semantic')).map(r => ({
      titles: r.nodes.map(describe), score: r.score, cosine: r.signals[0]!.rawValue,
      excerpts: r.signals[0]!.evidence.map(e => wiki.getEvidence(e).text), humanJudgment: 'pending',
    }));
    const after = await readVault(values.vault); assert.deepEqual(after.files, sources.files);
    stages.wiki = { documents: chosen.length, paths: chosen.map(input => input.path), run: result, elapsedMs: performance.now() - start,
      sourceBytesUnchanged: true, coverage: wiki.getEmbeddingCoverage(), semanticOnlyCandidates: discovered,
      allRelations: relations.map(r => ({ titles: r.nodes.map(describe), score: r.score, signals: r.signals.map(s => ({ kind: s.kind, rawValue: s.rawValue })) })) };
    await checkpoint();
    assert.equal(wiki.getEmbeddingCoverage().status, 'ready');
  }
  report.inferenceSamples = samples;
  report.status = 'passed'; await checkpoint(); console.log(JSON.stringify({ report: output, status: report.status, stages: Object.keys(stages) }, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = (error as Error).message; await checkpoint(); throw error;
}
