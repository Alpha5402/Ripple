import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readVault } from '../packages/adapters/filesystem/index.js';
import { openSqliteVault } from '../packages/adapters/node/index.js';
import { configureEmbeddingFromFile } from '../packages/adapters/embedding-http/config.js';
import { validateReview, summarizeReviews, type HumanRelationReview } from '../packages/eval/review.js';
const { values } = parseArgs({ options: { vault: { type: 'string' }, annotations: { type: 'string' } } });
const outputRoot = resolve('reports/local/wiki-eval'); await mkdir(outputRoot, { recursive: true });
if (values.annotations) {
  const submitted = JSON.parse(await readFile(values.annotations, 'utf8')) as HumanRelationReview[];
  const queue = JSON.parse(await readFile(join(outputRoot, 'review-queue.json'), 'utf8'));
  const allowed = new Set<string>(queue.candidates.map((c: { id: string }) => c.id));
  for (const review of submitted) validateReview(review, allowed);
  assert.equal(new Set(submitted.map(r => r.relationId)).size, submitted.length, 'Duplicate review entries');
  await writeFile(join(outputRoot, 'human-reviews.json'), JSON.stringify({ importedAt: new Date().toISOString(), source: resolve(values.annotations), summary: summarizeReviews(submitted), reviews: submitted }, null, 2) + '\n');
  console.log(summarizeReviews(submitted));
} else {
  if (!values.vault) throw new Error('--vault is required');
  const before = await readVault(values.vault);
  const workspace = await openSqliteVault(values.vault, { stateDir: join(outputRoot, 'state') });
  try {
    // The fixed loopback configuration is intentionally used for the private source corpus.
    await configureEmbeddingFromFile(workspace.service, resolve('configs/embedding.wemm-local.json'), values.vault);
    let encoded = 0, reused = 0;
    for (const doc of workspace.service.listDocuments()) {
      const result = await workspace.service.indexEmbeddings({ documentIds: [doc.id] });
      encoded += result.encoded; reused += result.reused;
      console.log(`${doc.path}: ${result.documents[doc.id]?.status}, encoded=${result.encoded} reused=${result.reused}`);
    }
    const relations = [...new Map(workspace.service.listDocuments().flatMap(doc => workspace.service.getRelations(doc.id)).map(r => [r.id, r])).values()];
    const semanticOnly = relations.filter(r => r.signals.every(s => s.kind === 'semantic')).sort((a, b) => b.score - a.score);
    const seen = new Map<string, number>();
    const candidates = semanticOnly.filter(r => {
      if (r.nodes.some(id => (seen.get(id) ?? 0) >= 3)) return false;
      for (const id of r.nodes) seen.set(id, (seen.get(id) ?? 0) + 1); return true;
    }).slice(0, 40).map(r => ({ id: r.id, titles: r.nodes.map(id => workspace.service.getNode(id)!.parsed.title), paths: r.nodes.map(id => workspace.service.getNode(id)!.path), score: r.score,
      cosine: r.signals[0]?.rawValue, evidence: r.signals.flatMap(s => s.evidence).map(e => workspace.service.getEvidence(e)),
      review: { relationId: r.id, grade: null, previouslyKnown: null, wouldHaveSearched: null, usefulAfterReading: null, reviewer: null, reviewedAt: null, note: null } }));
    const after = await readVault(values.vault); assert.deepEqual(after.files, before.files);
    const coverage = workspace.service.getEmbeddingCoverage();
    const report = { generatedAt: new Date().toISOString(), sourceBytesUnchanged: true, documents: workspace.service.listDocuments().length, units: workspace.service.getKnowledgeUnits().length, encoded, reused,
      sourceHashes: before.files, coverage, semanticOnlyPairs: semanticOnly.length, confirmedUnexpectedUseful: 0, status: 'awaiting-human-review',
      note: 'Ranking uses the existing uncalibrated production mapping. No artificial reference grades are assigned to private Wiki pairs. Candidate scores and excerpts are private local artifacts.', candidates };
    await writeFile(join(outputRoot, 'review-queue.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: join(outputRoot, 'review-queue.json'), documents: report.documents, units: report.units, semanticOnlyPairs: report.semanticOnlyPairs, candidateReviews: candidates.length }));
  } finally { workspace.close(); }
}
