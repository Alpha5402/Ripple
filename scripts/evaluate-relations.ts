import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createNodeKernel, NodeIdentityProvider } from '../packages/adapters/node/index.js';
import { HttpEmbeddingProvider } from '../packages/adapters/embedding-http/index.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../packages/core/embedding/config.js';
import type { KernelState } from '../packages/core/model.js';
import { calibrateOnDevelopment, evaluateRelations, type PairLabel, type PairFeatures, type Mapping } from '../packages/eval/relations.js';
import { relationKey } from '../packages/core/relation.js';

const { values } = parseArgs({ options: { stage: { type: 'string', default: 'encode' }, endpoint: { type: 'string', default: 'http://127.0.0.1:8787' } } });
const root = resolve('reports/local/eval-v1'), identity = new NodeIdentityProvider();
await mkdir(root, { recursive: true });
const fixtureText = await readFile(resolve('fixtures/eval/reference-v1.json'), 'utf8');
const fixture = JSON.parse(fixtureText) as { id: string; labelProtocol: unknown; documents: { id: string; path: string; markdown: string; split: string; contentHash: string }[]; labels: PairLabel[] };
const datasetHash = identity.hash(fixtureText), output = async (name: string, value: unknown) => writeFile(`${root}/${name}.json`, JSON.stringify(value, null, 2) + '\n');
assert.equal(fixture.documents.length, 32); assert.equal(fixture.labels.length, 240);
const docSplits = new Map(fixture.documents.map(d => [d.id, d.split]));
for (const label of fixture.labels) assert.ok(label.nodes.every(id => docSplits.get(id) === label.split));
for (const doc of fixture.documents) assert.equal(identity.hash(doc.markdown), doc.contentHash);
if (values.stage === 'encode') {
  const endpoint = new URL(values.endpoint);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Evaluation encoder is restricted to the local model');
  const provider = await HttpEmbeddingProvider.connect({ protocol: 'ripple', baseUrl: values.endpoint, timeoutMs: 180000 });
  let state: KernelState | undefined;
  try { const cache = JSON.parse(await readFile(`${root}/vectors.json`, 'utf8')); if (cache.datasetHash === datasetHash) state = cache.state; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const service = createNodeKernel(state ? { initialState: state } : {});
  service.ingestDocuments(fixture.documents);
  const config = structuredClone(DEFAULT_EMBEDDING_CONFIG); config.execution.batchSize = 1;
  // Extract all unit-pair cosines; ranking experiments below apply their own fixed mapping.
  config.retrieval.candidateBudget = 31; config.retrieval.mappings['text-text'] = { min: -1, max: 1 };
  service.configureEmbedding(provider, config);
  const start = performance.now();
  for (const doc of fixture.documents) {
    const report = await service.indexEmbeddings({ documentIds: [doc.id] });
    console.log(`${doc.id}: encoded=${report.encoded} reused=${report.reused}`);
    assert.equal(report.documents[doc.id]?.status, 'ready');
    await output('vectors', { datasetHash, model: provider.descriptor, state: service.exportState() });
  }
  const relations = new Map(service.listDocuments().flatMap(doc => service.getRelations(doc.id)).map(relation => [relation.id, relation]));
  const features: PairFeatures[] = fixture.labels.map(label => {
    const relation = relations.get(relationKey(...label.nodes));
    const cosine = relation?.signals.find(s => s.kind === 'semantic')?.rawValue;
    return { nodes: label.nodes, mention: relation?.components.mention ?? 0, explicit: relation?.components.explicit ?? 0, ...(cosine === undefined ? {} : { cosine }) };
  });
  await output('features', { datasetHash, model: provider.descriptor, representation: service.getEmbeddingCoverage().spaceId, elapsedMs: performance.now() - start, features });
  console.log(JSON.stringify({ stage: 'encoded', documents: 32, pairs: features.length, output: root }));
} else {
  const inputRoot = values.stage === 'replay' ? resolve('reports/k5') : root;
  const featureFile = JSON.parse(await readFile(`${inputRoot}/features.json`, 'utf8'));
  assert.equal(featureFile.datasetHash, datasetHash);
  const features = featureFile.features as PairFeatures[];
  if (values.stage === 'calibrate') {
    const labels = fixture.labels.filter(l => l.split === 'dev');
    const calibration = calibrateOnDevelopment(labels, features);
    const decision = { schemaVersion: 1, createdAt: new Date().toISOString(), datasetHash, model: featureFile.model, developmentLabelHash: identity.hash(JSON.stringify(labels)), selectedUsing: 'dev labels only; 120 graded pairs', calibration,
      scorePolicy: 'mention-explicit-v1 unchanged', releaseStatus: 'experimental synthetic-reference calibration; not installed as the production default', labelProtocol: fixture.labelProtocol };
    // Do not silently overwrite a locked decision after the final test has been inspected.
    await writeFile(`${root}/locked-policy.json`, JSON.stringify(decision, null, 2) + '\n', { flag: 'wx' });
    await output('development', ['mention-explicit', 'semantic', 'hybrid'].map(method => evaluateRelations(labels, features, calibration.selected, method as 'hybrid')));
    console.log(JSON.stringify(decision, null, 2));
  } else if (values.stage === 'test' || values.stage === 'replay') {
    const locked = JSON.parse(await readFile(`${inputRoot}/locked-policy.json`, 'utf8'));
    assert.equal(locked.datasetHash, datasetHash); assert.deepEqual(locked.model, featureFile.model);
    assert.equal(locked.developmentLabelHash, identity.hash(JSON.stringify(fixture.labels.filter(l => l.split === 'dev'))));
    const labels = fixture.labels.filter(l => l.split === 'test'), mapping = locked.calibration.selected as Mapping;
    const methods = ['mention-explicit', 'semantic', 'hybrid'] as const;
    const baseline = methods.map(method => evaluateRelations(labels, features, { min: 0.2, max: 0.9 }, method));
    const calibrated = methods.map(method => evaluateRelations(labels, features, mapping, method));
    const report = { generatedAt: new Date().toISOString(), datasetHash, lockedPolicyHash: identity.hash(JSON.stringify(locked)), labelProtocol: fixture.labelProtocol,
      model: featureFile.model, method: 'Disjoint test document cohort; every center scores the same 15 fully judged candidates; grade >=2 relevant; macro P@3/nDCG@3 over queries with relevant answers; zero-answer centers evaluated separately; equal-score ties by pair ID', baseline, calibrated };
    await output(values.stage === 'replay' ? 'replay-results' : 'test-results', report);
    console.log(JSON.stringify({ output: `${root}/${values.stage === 'replay' ? 'replay-results' : 'test-results'}.json`, mapping, metrics: calibrated.map(({ method, precisionAtK, ndcgAtK, hardNegativeVisibleRate }) => ({ method, precisionAtK, ndcgAtK, hardNegativeVisibleRate })) }, null, 2));
  } else throw new Error('stage must be encode, calibrate, test or replay');
}
