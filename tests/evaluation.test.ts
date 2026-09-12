import test from 'node:test';
import { validateReview, summarizeReviews } from '../packages/eval/review.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calibrateOnDevelopment, evaluateRelations, type PairLabel, type PairFeatures } from '../packages/eval/relations.js';
import { combineSignalScores, DEFAULT_SCORE_POLICY } from '../packages/core/relation.js';

const labels: PairLabel[] = [
  { nodes: ['a', 'b'], split: 'dev', grade: 3, hardNegative: false, rationale: 'fixture positive', labelSource: 'test', reviewStatus: 'fixture' },
  { nodes: ['a', 'c'], split: 'dev', grade: 0, hardNegative: true, rationale: 'fixture negative', labelSource: 'test', reviewStatus: 'fixture' },
  { nodes: ['b', 'c'], split: 'dev', grade: 0, hardNegative: false, rationale: 'fixture negative', labelSource: 'test', reviewStatus: 'fixture' },
];
const features: PairFeatures[] = [
  { nodes: ['a', 'b'], mention: 0.5, explicit: 1, cosine: 0.85 },
  { nodes: ['a', 'c'], mention: 0, explicit: 0, cosine: 0.4 },
  { nodes: ['b', 'c'], mention: 0, explicit: 0, cosine: 0.1 },
];
test('eval metrics use the same candidate pool, correct graded DCG and a fixed K denominator; empty-answer centers are separate', () => {
  const result = evaluateRelations(labels, features, { min: 0.5, max: 0.9 }, 'hybrid', 2);
  assert.equal(result.candidateBudget, 2); assert.equal(result.precisionAtK, 0.5); assert.equal(result.ndcgAtK, 1);
  assert.equal(result.zeroRelevantQueries, 1); assert.equal(result.hardNegativeVisibleRate, 0);
  assert.equal(result.perQuery[0]!.top[0]!.score, combineSignalScores(0.5, 1, 0.875, DEFAULT_SCORE_POLICY));
  const noSignal = evaluateRelations(labels, features.map(f => ({ ...f, mention: 0, explicit: 0 })), { min: 0.5, max: 0.9 }, 'mention-explicit', 2);
  assert.equal(noSignal.precisionAtK, 0); assert.equal(noSignal.ndcgAtK, 0); assert.equal(noSignal.perQuery[0]!.returned, 0);
});
test('calibration rejects test labels and incomplete or duplicate candidate judgments instead of silently leaking or dropping pairs', () => {
  assert.throws(() => calibrateOnDevelopment(labels.map(l => ({ ...l, split: 'test' })), features), /test labels/);
  assert.throws(() => evaluateRelations([...labels, labels[0]!], features, { min: 0.2, max: 0.9 }, 'hybrid'), /duplicate/);
  assert.throws(() => evaluateRelations(labels.slice(0, 2), features, { min: 0.2, max: 0.9 }, 'hybrid'), /fully judged/);
  assert.throws(() => evaluateRelations(labels, features.slice(0, 1), { min: 0.2, max: 0.9 }, 'hybrid'), /Missing features/);
});
test('the fixed 240-pair reference has disjoint documents, all four grades and explicit synthetic provenance', async () => {
  const fixture = JSON.parse(await readFile('fixtures/eval/reference-v1.json', 'utf8'));
  assert.equal(fixture.documents.length, 32); assert.equal(fixture.labels.length, 240); assert.equal(fixture.labelProtocol.humanReviewed, false);
  const splits = new Map(fixture.documents.map((d: any) => [d.id, d.split]));
  for (const label of fixture.labels) { assert.ok(label.nodes.every((id: string) => splits.get(id) === label.split)); assert.equal(label.reviewStatus, 'unreviewed'); }
  assert.deepEqual([...new Set(fixture.labels.map((l: any) => l.grade))].sort(), [0, 1, 2, 3]);
  assert.equal(fixture.labels.filter((l: any) => l.hardNegative).length, 24);
});

test('unexpected useful discoveries require explicit human judgments and cannot be inferred from high model scores', async () => {
  const allowed = new Set(['pair']);
  assert.throws(() => validateReview({ relationId: 'pair', grade: 3 }, allowed), /Review must/);
  const review = { relationId: 'pair', grade: 2 as const, previouslyKnown: false, wouldHaveSearched: false, usefulAfterReading: true, reviewer: 'fixture-human', reviewedAt: '2026-09-12T00:00:00Z' };
  validateReview(review, allowed); assert.deepEqual(summarizeReviews([review]).unexpectedUseful, ['pair']);
  assert.deepEqual(summarizeReviews([{ ...review, wouldHaveSearched: true }]).unexpectedUseful, []);
});
