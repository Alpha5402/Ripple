import test from 'node:test';
import assert from 'node:assert/strict';
import { document, kernel } from './helpers.js';
import { ExplorationSession } from '../packages/sdk/session.js';

function neighborhood(size: number) {
  return kernel(
    document('center', '# Center'),
    ...Array.from({ length: size }, (_, i) => document(`n${i}`, `# Neighbor${i}\n\n${i % 5 === 0 ? '[[Center|作者目标]]' : 'Center'}${Array.from({ length: i % 4 }, (_, j) => `\n## Section${j}\nCenter`).join('')}`)),
  );
}

test('property: all 101 lens values monotonically expand across many candidate sets and visible budgets', () => {
  for (const size of [0, 1, 4, 11, 53]) for (const budget of [1, 3, 40, 100]) {
    const service = neighborhood(size);
    const snapshot = service.createExplorationSnapshot('center', { lensValue: 0, visibleBudget: budget });
    let previous: string[] = [];
    for (let lens = 0; lens <= 100; lens++) {
      const view = service.getVisibleRelations(service.setLens(snapshot, lens));
      const ids = view.relations.map(r => r.id);
      assert.ok(previous.every(id => ids.includes(id)), `Lost neighbor: size=${size}, budget=${budget}, lens=${lens}`);
      assert.equal(view.eligibleCount, ids.length + view.remainingCount);
      previous = ids;
    }
    assert.equal(previous.length, Math.min(size, budget));
  }
});

test('equal-score nodes cross together; visible cap paginates without replacing existing neighbors', () => {
  const service = kernel(document('center', '# Center'), ...['aa', 'bb', 'cc', 'dd'].map(id => document(id, `# ${id}\nCenter`)));
  const snapshot = service.createExplorationSnapshot('center', { lensValue: 49, visibleBudget: 2 });
  assert.equal(service.getVisibleRelations(snapshot).eligibleCount, 0);
  const expanded = service.setLens(snapshot, 50);
  const view = service.getVisibleRelations(expanded);
  assert.equal(view.eligibleCount, 4); assert.equal(view.relations.length, 2); assert.equal(view.remainingCount, 2);
  const more = service.getVisibleRelations(service.setVisibleBudget(expanded, 4));
  assert.deepEqual(more.relations.slice(0, 2), view.relations);
  assert.equal(more.remainingCount, 0);
});

test('decimal threshold boundaries include exact ties without a one-step delay', () => {
  const service = kernel(document('a', '# Alpha\n[[Beta|目标]]'), document('b', '# Beta'));
  const snapshot = service.createExplorationSnapshot('a', { lensValue: 70 });
  const view = service.getVisibleRelations(snapshot);
  assert.equal(view.threshold, 0.3);
  assert.equal(view.relations.length, 1);
  assert.equal(service.getVisibleRelations(service.setLens(snapshot, 69.999)).relations.length, 0);
});

test('default focus shows fewer than three qualified neighbors without lowering the quality floor', () => {
  const service = kernel(document('a', '# Alpha\nBeta [[Gamma|弱信号]]'), document('b', '# Beta'), document('c', '# Gamma'));
  const view = service.getVisibleRelations(service.createExplorationSnapshot('a'));
  assert.equal(view.relations.length, 1);
  assert.deepEqual(view.relations[0]!.nodes, ['a', 'b']);
});

test('neighbors of neighbors cannot enter until the user explicitly changes focus', () => {
  const service = kernel(document('a', '# Alpha\nBeta'), document('b', '# Beta\nGamma'), document('c', '# Gamma'));
  const fromA = service.getVisibleRelations(service.createExplorationSnapshot('a', { lensValue: 100 }));
  assert.equal(fromA.relations.length, 1);
  assert.ok(fromA.relations.every(r => !r.nodes.includes('c')));
  assert.equal(service.getVisibleRelations(service.createExplorationSnapshot('b', { lensValue: 100 })).relations.length, 2);
});

test('new index candidates mark stale but do not leak into the frozen snapshot or remove old valid relations', () => {
  const service = kernel(document('a', '# Alpha\nBeta and Gamma'), document('b', '# Beta'));
  const snapshot = service.createExplorationSnapshot('a', { lensValue: 100 });
  service.ingestDocument(document('c', '# Gamma'));
  const old = service.getVisibleRelations(snapshot);
  assert.equal(old.status, 'stale');
  assert.equal(old.relations.length, 1);
  assert.deepEqual(old.relations[0]!.nodes, ['a', 'b']);
  assert.equal(service.getVisibleRelations(service.createExplorationSnapshot('a', { lensValue: 100 })).relations.length, 2);
});

test('new homonym immediately invalidates the old deterministic reference without re-ranking the snapshot', () => {
  const service = kernel(document('a', '# Alpha\nBeta and Gamma'), document('b', '# Beta'), document('c', '# Gamma'));
  const snapshot = service.createExplorationSnapshot('a', { lensValue: 100 });
  service.ingestDocument(document('b2', '# Beta'));
  const view = service.getVisibleRelations(snapshot);
  assert.equal(view.invalidatedCount, 1);
  assert.deepEqual(view.relations[0]!.nodes, ['a', 'c']);
});

test('hide/delete/content changes apply immediately, and delete/re-add cannot resurrect an old snapshot', () => {
  const service = neighborhood(3);
  const snapshot = service.createExplorationSnapshot('center', { lensValue: 100 });
  service.setRelationOverride('center', 'n0', { hidden: true });
  assert.equal(service.getVisibleRelations(snapshot).relations.length, 2);
  service.removeDocument('n1');
  assert.equal(service.getVisibleRelations(snapshot).relations.length, 1);
  service.ingestDocument(document('n1', '# Neighbor1\nCenter'));
  assert.equal(service.getVisibleRelations(snapshot).relations.length, 1);
  service.ingestDocument(document('center', '# Center\nChanged'));
  assert.equal(service.getVisibleRelations(snapshot).status, 'invalid');
  assert.equal(service.getVisibleRelations(snapshot).relations.length, 0);
});

test('pinned exceptions remain visible without changing score or displacing regular budget; hidden wins', () => {
  const service = neighborhood(4);
  const snapshot = service.createExplorationSnapshot('center', { lensValue: 100, visibleBudget: 1 });
  const regular = service.getVisibleRelations(snapshot).relations[0]!.id;
  service.setRelationOverride('center', 'n0', { pinned: true });
  const pinned = service.getVisibleRelations(snapshot);
  assert.equal(pinned.relations.length, 2);
  assert.ok(pinned.relations.some(r => r.id === regular));
  assert.equal(pinned.pinnedCount, 1);
  service.setRelationOverride('center', 'n0', { hidden: true });
  assert.equal(service.getVisibleRelations(snapshot).pinnedCount, 0);
});

test('history round-trips lens, budget, layout, camera and reading position through JSON', () => {
  const service = neighborhood(8);
  const session = new ExplorationSession(service);
  session.focus('center', { lensValue: 77, visibleBudget: 4 });
  session.setViewState({ layout: { n1: { x: 20, y: 30 } }, camera: { x: 10, y: 12, zoom: 2 }, reading: { documentId: 'center', offset: 3 } });
  const previous = session.current;
  session.focus('n1');
  const resumed = new ExplorationSession(service);
  resumed.importState(JSON.parse(JSON.stringify(session.exportState())));
  assert.deepEqual(resumed.back()!.state, previous);
  assert.equal(resumed.visible().status, 'current');
  assert.deepEqual(resumed.visible(), service.getVisibleRelations(previous!.snapshot));
});

test('stale history is explicit; an isolated center stays empty without fabricated neighbors', () => {
  const service = neighborhood(0);
  service.ingestDocument(document('isolated', '# Isolated'));
  const session = new ExplorationSession(service);
  session.focus('center'); session.focus('isolated');
  assert.equal(session.visible().relations.length, 0);
  service.ingestDocument(document('n', '# New\nCenter'));
  assert.equal(session.back()!.view.status, 'stale');
  assert.equal(session.visible().relations.length, 0);
  session.setLens(100); assert.equal(session.refresh().relations.length, 1);
});

test('lens and budget validation rejects NaN, infinity and invalid serialized versions', () => {
  const service = neighborhood(1);
  const snapshot = service.createExplorationSnapshot('center');
  for (const value of [-1, 101, NaN, Infinity]) assert.throws(() => service.setLens(snapshot, value));
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => service.setVisibleBudget(snapshot, value));
  assert.throws(() => service.getVisibleRelations({ ...snapshot, schemaVersion: 9 } as never), /snapshot/);
});
