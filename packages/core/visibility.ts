import { thresholdFor, validateSnapshot } from './exploration.js';
import { compareRelations } from './relation.js';
import type { Snapshot, VisibleRelations, RelationSignal, RelationOverride } from './model.js';

/** A live kernel and a public precomputed projection share precisely the same Lens rules. */
export interface SnapshotContext {
  indexRevision: number;
  relationScoreVersion: string;
  embeddingSpaceId?: string;
  userPolicyRevision: number;
  revision(id: string): number | undefined;
  validityEpoch(id: string): number | undefined;
  override(relationId: string): RelationOverride;
  signalValid(signal: RelationSignal): boolean;
}
export function visibleSnapshot(snapshot: Snapshot, context: SnapshotContext): VisibleRelations {
  validateSnapshot(snapshot);
  const threshold = thresholdFor(snapshot.lensValue, snapshot.lensMapping);
  const focusRevision = context.revision(snapshot.focusNode);
  const reasons: string[] = [];
  if (!focusRevision || focusRevision !== snapshot.focusRevision) {
    return { status: 'invalid', reasons: [focusRevision ? 'focus-revision-changed' : 'focus-removed'], threshold, relations: [], graphRelations: [], eligibleCount: 0, remainingCount: 0, pinnedCount: 0, invalidatedCount: snapshot.candidateSet.length };
  }
  if (snapshot.indexRevision !== context.indexRevision) reasons.push('index-revision-changed');
  if (snapshot.relationScoreVersion !== context.relationScoreVersion) reasons.push('score-policy-changed');
  if (snapshot.embeddingSpaceId !== context.embeddingSpaceId) reasons.push('embedding-space-changed');
  if (snapshot.userPolicyRevision !== context.userPolicyRevision) reasons.push('user-declarations-changed');
  let invalidatedCount = 0;
  const eligible = snapshot.candidateSet.filter(relation => {
    if (relation.nodes.some(id => !context.revision(id) || snapshot.validityEpochs[id] !== context.validityEpoch(id)) || relation.signals.some(signal => !context.signalValid(signal))) { invalidatedCount++; return false; }
    return true;
  }).map(relation => ({ ...relation, override: context.override(relation.id) }))
    .filter(r => !r.override.hidden && (r.score >= threshold || r.override.pinned));
  const pinned = eligible.filter(r => r.override.pinned).sort(compareRelations);
  const regular = eligible.filter(r => !r.override.pinned).sort(compareRelations);
  const visible = [...pinned, ...regular.slice(0, snapshot.visibleBudget)].sort(compareRelations);
  const visibleNodes = new Set([snapshot.focusNode, ...visible.flatMap(r => r.nodes)]);
  const cross = snapshot.neighborhoodRelations.filter(relation => {
    if (!relation.nodes.every(id => visibleNodes.has(id))) return false;
    if (relation.nodes.some(id => !context.revision(id) || snapshot.validityEpochs[id] !== context.validityEpoch(id)) || relation.signals.some(signal => !context.signalValid(signal))) { invalidatedCount++; return false; }
    return !context.override(relation.id).hidden;
  });
  if (invalidatedCount) reasons.push('candidate-evidence-invalidated');
  return { status: reasons.length ? 'stale' : 'current', reasons, threshold, relations: structuredClone(visible), graphRelations: structuredClone([...visible, ...cross].sort(compareRelations)), eligibleCount: eligible.length,
    remainingCount: regular.length - Math.min(regular.length, snapshot.visibleBudget), pinnedCount: pinned.length, invalidatedCount };
}
