import test from 'node:test';
import assert from 'node:assert/strict';
import { document, kernel } from './helpers.js';
import { DEFAULT_SCORE_POLICY, relationKey } from '../packages/core/relation.js';
import { KnowledgeService } from '../packages/core/service.js';
import { MemoryStorage, NodeIdentityProvider, RemarkMarkdownParser } from '../packages/adapters/node/index.js';

test('a directed mention creates symmetric discovery with identical scores, preserving the actual signal direction', () => {
  const service = kernel(document('a', '# Alpha\n\nBeta'), document('b', '# Beta'));
  const relation = service.getRelations('a')[0]!;
  assert.deepEqual(service.getRelations('b')[0], relation);
  assert.deepEqual(relation.signals.map(s => [s.kind, s.from, s.to]), [['mention', 'a', 'b']]);
  assert.equal(relation.components.semantic.status, 'not-configured');
  assert.equal(service.findMentions({ sourceDocumentId: 'b', targetDocumentId: 'a' }).length, 0);
});

test('repeat frequency saturates; distinct sections contribute bounded increments', () => {
  const service = kernel(document('a', '# Alpha\n\n' + 'Beta '.repeat(100)), document('b', '# Beta'));
  assert.equal(service.getRelations('a')[0]!.score, 0.5);
  service.ingestDocument(document('a', '# Alpha\n\nBeta\n## One\nBeta\n## Two\nBeta'));
  assert.equal(service.getRelations('a')[0]!.score, 0.7);
  service.ingestDocument(document('a', '# Alpha\n\nBeta' + Array.from({ length: 20 }, (_, i) => `\n## S${i}\nBeta`).join('')));
  assert.equal(service.getRelations('a')[0]!.score, 0.8);
});

test('explicit-only candidates survive without natural mentions and boosts follow versioned baseline', () => {
  const service = kernel(document('a', '# Alpha\n\n[[Beta|另一种机制]]'), document('b', '# Beta'));
  assert.equal(service.getRelations('a')[0]!.score, 0.3);
  assert.equal(service.getRelations('a')[0]!.components.mention, 0);
  service.ingestDocument(document('a', '# Alpha\n\nBeta 与 [[Beta|另一种机制]]'));
  assert.equal(service.getRelations('a')[0]!.score, 0.65);
  const signals = service.getRelations('a')[0]!.signals;
  assert.deepEqual(signals.map(s => s.rawValue), [1, 1]);
  assert.ok(signals.flatMap(s => s.evidence).every(e => service.getEvidence(e).status === 'valid'));
});

test('user hide and pin are durable declarations, never score mutations, and hide wins', () => {
  const storage = new MemoryStorage();
  const dependencies = { storage, parser: new RemarkMarkdownParser(), identity: new NodeIdentityProvider() };
  const service = new KnowledgeService(dependencies);
  service.ingestDocuments([document('a', '# Alpha\nBeta'), document('b', '# Beta')]);
  const score = service.getRelations('a')[0]!.score;
  service.setRelationOverride('a', 'b', { pinned: true, hidden: true, note: '暂不看' });
  assert.equal(service.getRelations('a').length, 0);
  assert.equal(service.getRelations('a', { includeHidden: true })[0]!.score, score);
  const resumed = new KnowledgeService(dependencies);
  assert.equal(resumed.exportUserDeclarations().relations[relationKey('a', 'b')]!.note, '暂不看');
  const snapshot = resumed.createExplorationSnapshot('a', { lensValue: 0 });
  assert.equal(resumed.getVisibleRelations(snapshot).relations.length, 0);
  resumed.setRelationOverride('a', 'b', { hidden: false });
  assert.equal(resumed.getVisibleRelations(snapshot).relations.length, 1);
  assert.equal(resumed.getVisibleRelations(snapshot).relations[0]!.score, score);
});

test('policy replacement requires a new version; old snapshots keep frozen scores', () => {
  const service = kernel(document('a', '# Alpha\nBeta'), document('b', '# Beta'));
  const snapshot = service.createExplorationSnapshot('a', { lensValue: 100 });
  assert.throws(() => service.setScorePolicy({ ...DEFAULT_SCORE_POLICY, mentionBase: 0.7 }), /new version/);
  service.setScorePolicy({ ...DEFAULT_SCORE_POLICY, version: 'custom-v2', mentionBase: 0.7 });
  assert.equal(service.getRelations('a')[0]!.score, 0.7);
  assert.equal(service.getVisibleRelations(snapshot).relations[0]!.score, 0.5);
  assert.ok(service.getVisibleRelations(snapshot).reasons.includes('score-policy-changed'));
});

test('public data is detached from internal state, including snapshots and declarations', () => {
  const service = kernel(document('a', '# Alpha\nBeta'), document('b', '# Beta'));
  service.getNode('a')!.markdown = 'corrupted';
  service.getRelations('a')[0]!.signals.length = 0;
  service.exportUserDeclarations().aliases.push({ name: 'alias', target: { documentId: 'a' } });
  assert.equal(service.getNode('a')!.markdown, '# Alpha\nBeta');
  assert.ok(service.getRelations('a')[0]!.signals.length);
  assert.equal(service.resolveEntity('alias').status, 'missing');
});
