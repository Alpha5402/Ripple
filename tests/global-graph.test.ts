import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeKernel } from '../packages/adapters/node/index.js';
import { collectGlobalGraph } from '../packages/host/global-graph.js';
import { createPublicBridge } from '../packages/workbench/public-bridge.js';
import { DEFAULT_SCORE_POLICY } from '../packages/core/relation.js';
import type { GlobalGraph, WorkbenchState } from '../packages/host/contract.js';

const documents = [
  { id: 'a', path: 'Alpha.md', markdown: '# Alpha\n[[Beta]]' },
  { id: 'b', path: 'Beta.md', markdown: '# Beta\n[[Gamma]]' },
  { id: 'c', path: 'Gamma.md', markdown: '# Gamma\n[[Beta]]' },
  { id: 'd', path: 'Island.md', markdown: '# Island\nStandalone.' },
];
test('global network includes isolated documents and relations away from focus, deduplicates pairs and honors hidden overrides', () => {
  const service = createNodeKernel(); service.ingestDocuments(documents);
  const graph = collectGlobalGraph(service);
  assert.equal(graph.documents.length, 4); assert.equal(graph.relations.length, 2);
  assert.ok(graph.relations.some(r => r.nodes.includes('b') && r.nodes.includes('c')));
  assert.equal(new Set(graph.relations.map(r => r.id)).size, 2);
  service.setRelationOverride('b', 'c', { hidden: true });
  assert.equal(collectGlobalGraph(service).relations.length, 1);
});
test('browser global command preserves local history', async () => {
  const bridge = createPublicBridge({ schemaVersion: 1, id: 'global-test', generatedAt: new Date().toISOString(), scorePolicy: DEFAULT_SCORE_POLICY, title: 'Global test', documents });
  const before = await bridge.command({ type: 'state' }) as WorkbenchState;
  const graph = await bridge.command({ type: 'global-graph' }) as GlobalGraph;
  assert.equal(graph.documents.length, 4); assert.equal(graph.relations.length, 2);
  const after = await bridge.command({ type: 'state' }) as WorkbenchState;
  assert.deepEqual(after.current, before.current); assert.equal(after.canBack, false);
});
