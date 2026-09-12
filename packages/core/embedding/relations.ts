import type { Document, RelationCandidate, RelationSignal } from '../model.js';
import { relationKey } from '../relation.js';
import type { EmbeddingCache, EmbeddingSpaceCache, ModalityPair, SemanticContribution, SemanticState, VectorRecord } from './model.js';

export function activeSpace(cache: EmbeddingCache | undefined): EmbeddingSpaceCache | undefined { return cache?.activeSpaceId ? cache.spaces[cache.activeSpaceId] : undefined; }
export function validRecords(space: EmbeddingSpaceCache, documents: Document[]): VectorRecord[] {
  const revisions = new Map(documents.map(doc => [doc.id, doc.revision]));
  return space.records.filter(record => revisions.get(record.unit.documentId) === record.unit.revision);
}
const modalityPair = (a: VectorRecord, b: VectorRecord): ModalityPair => a.unit.kind === 'text' && b.unit.kind === 'text' ? 'text-text'
  : a.unit.kind !== 'text' && b.unit.kind !== 'text' ? 'image-image' : 'text-image';
export function generateSemanticCandidates(cache: EmbeddingCache | undefined, documents: Document[], focusId?: string): RelationCandidate[] {
  const space = activeSpace(cache);
  if (!space) return [];
  const records = validRecords(space, documents);
  const pairs = new Map<string, { nodes: [string, string]; matches: { contribution: SemanticContribution; pair: ModalityPair; strength: number }[] }>();
  const leftRecords = focusId ? records.filter(r => r.unit.documentId === focusId) : records;
  const rightRecords = focusId ? records.filter(r => r.unit.documentId !== focusId) : records;
  for (let i = 0; i < leftRecords.length; i++) for (let j = focusId ? 0 : i + 1; j < rightRecords.length; j++) {
    let left = leftRecords[i]!, right = rightRecords[j]!;
    if (left.unit.documentId === right.unit.documentId) continue;
    if (left.unit.documentId > right.unit.documentId) [left, right] = [right, left];
    let cosine = 0;
    for (let k = 0; k < left.vector.length; k++) cosine += left.vector[k]! * right.vector[k]!;
    cosine = Math.max(-1, Math.min(1, cosine));
    const pair = modalityPair(left, right), mapping = space.config.retrieval.mappings[pair];
    if (cosine < mapping.min) continue;
    const strength = Math.min(1, Math.max(0, (cosine - mapping.min) / (mapping.max - mapping.min)));
    const id = relationKey(left.unit.documentId, right.unit.documentId);
    const current = pairs.get(id) ?? { nodes: [left.unit.documentId, right.unit.documentId], matches: [] };
    current.matches.push({ pair, strength, contribution: {
      unitIds: [left.unit.id, right.unit.id], unitHashes: [left.unit.contentHash, right.unit.contentHash], cosine, modalityPair: pair,
      evidence: [left.unit.evidence, right.unit.evidence], media: [...left.unit.media, ...right.unit.media],
    } });
    pairs.set(id, current);
  }
  return [...pairs].map(([id, pair]) => {
    pair.matches.sort((a, b) => b.strength - a.strength || a.contribution.unitIds.join('').localeCompare(b.contribution.unitIds.join('')));
    const selected = [] as typeof pair.matches;
    const usedLeft = new Set<string>(), usedRight = new Set<string>();
    for (const match of pair.matches) {
      const [left, right] = match.contribution.evidence.map(e => e.sectionId) as [string, string];
      if (usedLeft.has(left) || usedRight.has(right)) continue;
      selected.push(match); usedLeft.add(left); usedRight.add(right);
      if (selected.length >= (space.config.retrieval.aggregation === 'max' ? 1 : space.config.retrieval.topMatches)) break;
    }
    const strength = selected.reduce((n, match) => n + match.strength, 0) / selected.length;
    const cosine = selected.reduce((n, match) => n + match.contribution.cosine, 0) / selected.length;
    const signal: RelationSignal = { kind: 'semantic', from: pair.nodes[0], to: pair.nodes[1], rawValue: cosine,
      evidence: selected.flatMap(match => match.contribution.evidence),
      semantic: { spaceId: space.space.id, strength, modalityPair: new Set(selected.map(match => match.pair)).size > 1 ? 'mixed' : selected[0]!.pair,
        aggregation: space.config.retrieval.aggregation, contributions: selected.map(match => match.contribution) } };
    return { id, nodes: pair.nodes, signals: [signal] };
  });
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
