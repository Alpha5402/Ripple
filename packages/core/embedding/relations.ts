import type { Document, RelationCandidate, RelationSignal } from '../model.js';
import { relationKey } from '../relation.js';
import type { EmbeddingCache, EmbeddingSpaceCache, ModalityPair, SemanticContribution, SemanticState, VectorRecord } from './model.js';

export function activeSpace(cache: EmbeddingCache | undefined): EmbeddingSpaceCache | undefined { return cache?.activeSpaceId ? cache.spaces[cache.activeSpaceId] : undefined; }
export function validRecords(space: EmbeddingSpaceCache, documents: Document[]): VectorRecord[] {
  const revisions = new Map(documents.map(doc => [doc.id, doc.revision]));
  return space.records.filter(record => revisions.get(record.unit.documentId) === record.unit.revision);
}
export function semanticPairState(cache: EmbeddingCache | undefined, nodes: [string, string], documents: Document[] | Map<string, Document>): SemanticState {
  const space = activeSpace(cache);
  if (!space) return { status: 'not-configured' };
  const revisions = documents instanceof Map ? documents : new Map(documents.map(doc => [doc.id, doc]));
  const statuses = nodes.map(id => space.documents[id]);
  const context = { spaceId: space.space.id };
  if (statuses.some(status => !status)) return { ...context, status: 'pending' };
  if (nodes.some((id, i) => statuses[i]!.revision !== revisions.get(id)?.revision)) return { ...context, status: 'stale' };
  const bad = statuses.find(status => status!.status !== 'ready');
  return { ...context, status: bad?.status ?? 'not-recalled' };
}
export function semanticSignalValid(signal: RelationSignal, cache: EmbeddingCache | undefined, documents: Document[], unitHashes?: Map<string, string>): boolean {
  const space = activeSpace(cache);
  if (!signal.semantic || !space || signal.semantic.spaceId !== space.space.id) return false;
  const hashes = unitHashes ?? new Map(validRecords(space, documents).map(record => [record.unit.id, record.unit.contentHash]));
  return signal.semantic.contributions.every(match => match.unitIds.every((id, i) => hashes.get(id) === match.unitHashes[i]));
}
