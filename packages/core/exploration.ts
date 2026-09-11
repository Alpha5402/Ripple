import { KernelError, type LensMapping, type Snapshot } from './model.js';

export const DEFAULT_LENS_MAPPING: Readonly<LensMapping> = Object.freeze({ kind: 'linear', minThreshold: 0, maxThreshold: 1 });
export function validateLens(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new KernelError('INVALID_INPUT', 'Lens must be between 0 and 100');
}
export function validateBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new KernelError('INVALID_INPUT', 'Visible budget must be a positive integer');
}
export function thresholdFor(lensValue: number, mapping: LensMapping): number {
  validateLens(lensValue);
  // Remove arithmetic noise at boundaries such as 1 - 0.7, without breaking score ties.
  return Number((mapping.maxThreshold - (mapping.maxThreshold - mapping.minThreshold) * lensValue / 100).toFixed(12));
}
export function validateSnapshot(snapshot: Snapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.candidateSet)
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
  for (const relation of snapshot.candidateSet) {
    if (!relation || !Array.isArray(relation.nodes) || relation.nodes.length !== 2 || !relation.nodes.includes(snapshot.focusNode)
      || !Number.isFinite(relation.score) || relation.score < 0 || relation.score > 1 || relation.scoreVersion !== snapshot.relationScoreVersion
      || !Array.isArray(relation.signals) || !relation.signals.length
      || relation.signals.some(signal => !['mention', 'explicit', 'semantic'].includes(signal.kind) || !Array.isArray(signal.evidence) || !signal.evidence.length
        || (signal.kind === 'semantic' && (!signal.semantic || !signal.semantic.contributions.length)))) {
      throw new KernelError('INVALID_SNAPSHOT', 'Malformed snapshot relation');
    }
  }
}
