import { KernelError, type LensMapping, type Relation } from '../model.js';

export const DEFAULT_LENS_MAPPING: Readonly<LensMapping> = Object.freeze({ kind: 'linear', minThreshold: 0, maxThreshold: 1 });
export function validateLens(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new KernelError('INVALID_INPUT', 'Lens must be between 0 and 100');
}
export function validateBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new KernelError('INVALID_INPUT', 'Visible budget must be a positive integer');
}
/** Freeze the admitted local score range. No retrieval, global cosine threshold or top-N target. */
export function localLensMapping(relations: Relation[]): LensMapping {
  const scores = relations.filter(r => !r.override.hidden).map(r => r.score);
  return scores.length ? { kind: 'linear', minThreshold: Math.min(...scores), maxThreshold: Math.max(...scores) } : { ...DEFAULT_LENS_MAPPING };
}
export function thresholdFor(lensValue: number, mapping: LensMapping): number {
  validateLens(lensValue);
  return Number((mapping.maxThreshold - (mapping.maxThreshold - mapping.minThreshold) * lensValue / 100).toFixed(12));
}
export function localScore(score: number, mapping: LensMapping): number {
  return mapping.maxThreshold === mapping.minThreshold ? 1 : Math.max(0, Math.min(1, (score - mapping.minThreshold) / (mapping.maxThreshold - mapping.minThreshold)));
}
