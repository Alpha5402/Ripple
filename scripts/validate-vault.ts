import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { arch, platform, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { openVault } from '../packages/adapters/filesystem/workspace.js';
import { readVault } from '../packages/adapters/filesystem/index.js';
import { ExplorationSession } from '../packages/sdk/index.js';

const root = process.argv[2];
if (!root) throw new Error('Usage: npm run validate:vault -- <read-only vault directory>');
const started = performance.now();
const { service, sources } = await openVault(root);
const ingestionMs = performance.now() - started;
const documents = service.listDocuments();
assert.ok(documents.length > 0, 'Vault contains no Markdown documents');
const relationMap = new Map(documents.flatMap(doc => service.getRelations(doc.id)).map(r => [r.id, r]));
let checkedEvidence = 0;
for (const relation of relationMap.values()) {
  assert.deepEqual(service.getRelations(relation.nodes[0]).find(r => r.id === relation.id), service.getRelations(relation.nodes[1]).find(r => r.id === relation.id));
  for (const signal of relation.signals) for (const locator of signal.evidence) {
    const evidence = service.getEvidence(locator);
    assert.equal(evidence.status, 'valid');
    assert.equal(evidence.text, service.getNode(locator.documentId)!.markdown.slice(locator.start, locator.end));
    checkedEvidence++;
  }
}
const requestedCenters = ['CSRF', 'SSRF', 'Event Loop', 'Vite', 'Promise'];
const centers = requestedCenters.flatMap(name => {
  const result = service.resolveEntity(name);
  return result.status === 'resolved' ? [{ name, id: result.candidates[0]!.documentId }] : [];
});
if (!centers.length) centers.push({ name: documents[0]!.parsed.title, id: documents[0]!.id });
const curves = [];
const filterTimes: number[] = [];
for (const center of centers) {
  const snapshot = service.createExplorationSnapshot(center.id);
  let previous: string[] = [];
  const curve = [];
  for (let lens = 0; lens <= 100; lens++) {
    const state = service.setLens(snapshot, lens);
    const before = performance.now();
    const view = service.getVisibleRelations(state);
    filterTimes.push(performance.now() - before);
    assert.equal(view.status, 'current');
    assert.ok(previous.every(id => view.relations.some(r => r.id === id)), `Non-monotonic expansion for ${center.name}`);
    if (!lens || previous.length !== view.relations.length) curve.push({ lens, visible: view.relations.length, eligible: view.eligibleCount, remaining: view.remainingCount });
    previous = view.relations.map(r => r.id);
  }
  const session = new ExplorationSession(service);
  session.focus(center.id, { lensValue: 70 });
  session.setViewState({ camera: { x: 10, y: 20, zoom: 2 }, reading: { documentId: center.id, offset: 0 } });
  const state = session.current;
  const next = session.visible().relations[0]?.nodes.find(id => id !== center.id);
  if (next) { session.focus(next); assert.deepEqual(session.back()!.state, state); }
  curves.push({ center: center.name, candidates: snapshot.candidateSet.length, curve });
}
const unchangedRevision = service.indexRevision;
assert.equal(service.reindexChanged(sources.inputs).changedCount, 0);
assert.equal(service.indexRevision, unchangedRevision);
const chosen = centers[0]!;
const current = service.getNode(chosen.id)!;
const oldSnapshot = service.createExplorationSnapshot(chosen.id, { lensValue: 100 });
service.ingestDocument({ id: current.id, path: current.path, markdown: current.markdown + '\n', expectedRevision: current.revision });
assert.equal(service.getVisibleRelations(oldSnapshot).status, 'invalid');
assert.throws(() => service.ingestDocument({ id: current.id, path: current.path, markdown: current.markdown, expectedRevision: current.revision }), /Revision conflict/);
const after = await readVault(root);
assert.deepEqual(after.files, sources.files, 'Source bytes or file list changed during validation');
filterTimes.sort((a, b) => a - b);
const links = service.findWikiLinks();
const report = {
  generatedAt: new Date().toISOString(), scope: 'K1–K3 deterministic correctness smoke test, not recommendation-quality evaluation',
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  corpus: { documents: documents.length, bytes: sources.files.reduce((sum, f) => sum + f.bytes, 0), selection: 'Wiki/ when present; otherwise all visible Markdown files' },
  results: {
    relations: relationMap.size, verifiedDirectionalEvidence: checkedEvidence,
    mentions: service.findMentions().length,
    ambiguousMentions: service.findMentions().filter(m => m.resolution.status === 'ambiguous').length,
    wikiLinks: links.length, resolvedWikiLinks: links.filter(l => l.resolution.status === 'resolved').length,
    unresolvedWikiLinks: links.filter(l => l.resolution.status !== 'resolved').map(l => ({ source: service.getNode(l.sourceDocumentId)!.path, target: l.targetText, status: l.resolution.status })),
    isolatedDocuments: documents.filter(doc => service.getRelations(doc.id).length === 0).map(doc => doc.path),
    sourceBytesUnchanged: true, bidirectionalDiscoveryChecked: true, frozenLensMonotonicityChecked: true,
    historyRestorationChecked: true, noOpReindexChecked: true, oldRevisionRejected: true,
  },
  timings: { ingestionMs, localFilterP95Ms: filterTimes[Math.ceil(filterTimes.length * 0.95) - 1], filterSamples: filterTimes.length, includesUIOrLayout: false },
  curves, warnings: sources.warnings,
};
const output = resolve('reports/local/iwiki-validation.json');
await mkdir(resolve('reports/local'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, documents: documents.length, relations: relationMap.size, verifiedEvidence: checkedEvidence, unresolvedWikiLinks: report.results.unresolvedWikiLinks.length, sourceBytesUnchanged: true, timings: report.timings, curves }, null, 2));
