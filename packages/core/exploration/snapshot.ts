import { KernelError, type Snapshot } from '../model.js';
import { validateLens, validateBudget } from './lens.js';

export function validateSnapshot(snapshot: Snapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.candidateSet)
    || !Array.isArray(snapshot.validSemanticNeighborhood) || !Array.isArray(snapshot.neighborhoodRelations)
    || !snapshot.semanticCandidatePool || !Array.isArray(snapshot.semanticCandidatePool.candidates) || !snapshot.relationBoundary || !Array.isArray(snapshot.relationBoundary.decisions)
    || typeof snapshot.focusNode !== 'string' || !Number.isSafeInteger(snapshot.focusRevision) || snapshot.focusRevision < 1
    || !Number.isSafeInteger(snapshot.indexRevision) || snapshot.indexRevision < 0
    || !snapshot.userOverrides || !snapshot.candidateRevisions || !snapshot.validityEpochs
    || snapshot.lensMapping?.kind !== 'linear'
    || !Number.isFinite(snapshot.lensMapping.minThreshold) || !Number.isFinite(snapshot.lensMapping.maxThreshold)
    || snapshot.lensMapping.minThreshold < 0 || snapshot.lensMapping.maxThreshold > 1
    || snapshot.lensMapping.minThreshold > snapshot.lensMapping.maxThreshold) {
    throw new KernelError('INVALID_SNAPSHOT', 'Unsupported or malformed exploration snapshot');
  }
  validateLens(snapshot.lensValue); validateBudget(snapshot.visibleBudget);
  for (const relation of [...snapshot.candidateSet, ...snapshot.neighborhoodRelations]) {
    if (!relation || !Array.isArray(relation.nodes) || relation.nodes.length !== 2
      || !Number.isFinite(relation.score) || relation.score < 0 || relation.score > 1 || relation.scoreVersion !== snapshot.relationScoreVersion
      || !Array.isArray(relation.signals) || !relation.signals.length
      || relation.signals.some(signal => !['mention', 'explicit', 'semantic'].includes(signal.kind) || !Array.isArray(signal.evidence) || !signal.evidence.length
        || (signal.kind === 'semantic' && (!signal.semantic || !signal.semantic.contributions.length)))) {
      throw new KernelError('INVALID_SNAPSHOT', 'Malformed snapshot relation');
    }
  }
  const accepted = new Set(snapshot.relationBoundary.decisions.filter(d => d.accepted).map(d => d.id));
  const neighbors = new Set([snapshot.focusNode, ...snapshot.candidateSet.flatMap(r => r.nodes)]);
  if (snapshot.candidateSet.some(r => !r.nodes.includes(snapshot.focusNode) || (r.signals.some(s => s.kind === 'semantic') && !accepted.has(r.id)))
    || snapshot.neighborhoodRelations.some(r => r.nodes.includes(snapshot.focusNode) || r.nodes.some(id => !neighbors.has(id)))) throw new KernelError('INVALID_SNAPSHOT', 'Relations escaped the frozen neighborhood');
}
