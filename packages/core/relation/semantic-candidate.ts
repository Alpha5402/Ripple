import type { Document, EvidenceLocator, RelationSignal } from '../model.js';
import type { EmbeddingCache, ModalityPair, SemanticContribution, SemanticMetadata, VectorRecord, EmbeddingConfig } from '../embedding/model.js';
import { activeSpace, validRecords } from '../embedding/relations.js';
import { relationKey } from '../relation.js';

/** Unscored retrieval evidence. A candidate has no relation signals and is never itself a graph edge. */
export interface SemanticCandidate {
  id: string; nodes: [string, string]; similarity: number;
  evidence: EvidenceLocator[]; metadata: Omit<SemanticMetadata, 'strength'>;
}
export interface SemanticCandidatePool {
  focusNode: string; model: string; retrievalVersion: string; candidateBudget: number;
  totalCandidates: number; candidates: SemanticCandidate[];
}
export const compareSemanticCandidates = (a: SemanticCandidate, b: SemanticCandidate): number => b.similarity - a.similarity || a.id.localeCompare(b.id);
const modalityPair = (a: VectorRecord, b: VectorRecord): ModalityPair => a.unit.kind === 'text' && b.unit.kind === 'text' ? 'text-text'
  : a.unit.kind !== 'text' && b.unit.kind !== 'text' ? 'image-image' : 'text-image';

/** Exact cosine retrieval observes the distribution before any quality floor or gap filtering. */
export function retrieveSemanticCandidates(cache: EmbeddingCache | undefined, documents: Document[], focusNode: string): SemanticCandidatePool {
  const space = activeSpace(cache);
  const empty: SemanticCandidatePool = { focusNode, model: space?.space.descriptor.model ?? '', retrievalVersion: space?.config.retrieval.version ?? 'not-configured', candidateBudget: space?.config.retrieval.candidateBudget ?? 0, totalCandidates: 0, candidates: [] };
  if (!space) return empty;
  const records = validRecords(space, documents), leftRecords = records.filter(r => r.unit.documentId === focusNode), rightRecords = records.filter(r => r.unit.documentId !== focusNode);
  const pairs = new Map<string, { nodes: [string, string]; matches: SemanticContribution[] }>();
  for (const leftRecord of leftRecords) for (const rightRecord of rightRecords) {
    let left = leftRecord, right = rightRecord;
    if (left.unit.documentId > right.unit.documentId) [left, right] = [right, left];
    let cosine = 0;
    for (let k = 0; k < left.vector.length; k++) cosine += left.vector[k]! * right.vector[k]!;
    cosine = Math.max(-1, Math.min(1, cosine));
    const id = relationKey(left.unit.documentId, right.unit.documentId);
    const current = pairs.get(id) ?? { nodes: [left.unit.documentId, right.unit.documentId], matches: [] };
    current.matches.push({ unitIds: [left.unit.id, right.unit.id], unitHashes: [left.unit.contentHash, right.unit.contentHash], cosine,
      modalityPair: modalityPair(left, right), evidence: [left.unit.evidence, right.unit.evidence], media: [...left.unit.media, ...right.unit.media] });
    pairs.set(id, current);
  }
  const candidates: SemanticCandidate[] = [...pairs].map(([id, pair]): SemanticCandidate => {
    pair.matches.sort((a, b) => b.cosine - a.cosine || a.unitIds.join('').localeCompare(b.unitIds.join('')));
    const selected: SemanticContribution[] = [], usedLeft = new Set<string>(), usedRight = new Set<string>();
    for (const match of pair.matches) {
      const [left, right] = match.evidence;
      if (usedLeft.has(left.sectionId) || usedRight.has(right.sectionId)) continue;
      selected.push(match); usedLeft.add(left.sectionId); usedRight.add(right.sectionId);
      if (selected.length >= (space.config.retrieval.aggregation === 'max' ? 1 : space.config.retrieval.topMatches)) break;
    }
    const similarity = selected.reduce((n, m) => n + m.cosine, 0) / selected.length;
    return { id, nodes: pair.nodes, similarity, evidence: selected.flatMap(m => m.evidence), metadata: { spaceId: space.space.id,
      modalityPair: new Set(selected.map(m => m.modalityPair)).size > 1 ? 'mixed' : selected[0]!.modalityPair, aggregation: space.config.retrieval.aggregation, contributions: selected } };
  }).sort(compareSemanticCandidates);
  return { ...empty, totalCandidates: candidates.length, candidates: candidates.slice(0, empty.candidateBudget) };
}
/** The caller must supply only candidates that its relation boundary accepted. */
export function acceptedSemanticSignal(candidate: SemanticCandidate, mappings: EmbeddingConfig['retrieval']['mappings']): RelationSignal {
  const strength = candidate.metadata.contributions.reduce((n, contribution) => { const mapping = mappings[contribution.modalityPair]; return n + Math.min(1, Math.max(0, (contribution.cosine - mapping.min) / (mapping.max - mapping.min))); }, 0) / candidate.metadata.contributions.length;
  return { kind: 'semantic', from: candidate.nodes[0], to: candidate.nodes[1], evidence: structuredClone(candidate.evidence), rawValue: candidate.similarity, semantic: { ...structuredClone(candidate.metadata), strength } };
}
