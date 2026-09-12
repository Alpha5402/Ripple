import type { SemanticCandidatePool } from './semantic-candidate.js';
import { DEFAULT_GAP_OPTIONS, detectSignificantGap, type GapDiagnostics, type GapOptions } from './gap-detector.js';

export interface RelationBoundaryConfig {
  strategy: string;
  qualityFloor: number;
  gap: GapOptions;
}
export interface BoundarySelection { ids: string[]; cutRank: number | null; gap?: GapDiagnostics }
/** Strategies are hypotheses about useful neighborhoods, not claims that excluded notes are unrelated. */
export interface RelationBoundaryStrategy {
  readonly id: string;
  readonly version: string;
  select(pool: SemanticCandidatePool, config: RelationBoundaryConfig): BoundarySelection;
}
export const adaptiveGapStrategy: RelationBoundaryStrategy = {
  id: 'adaptive-gap', version: 'median-mad-v1',
  select(pool, config) {
    const gap = detectSignificantGap(pool.candidates.map(c => c.similarity), config.gap);
    return { ids: pool.candidates.slice(0, gap.boundaryRank ?? pool.candidates.length).map(c => c.id), cutRank: gap.boundaryRank, gap };
  },
};
export interface RelationBoundary {
  strategy: string; strategyVersion: string; config: RelationBoundaryConfig;
  poolSize: number; totalCandidates: number; poolTruncated: boolean;
  cutRank: number | null; gap?: GapDiagnostics;
  decisions: { id: string; similarity: number; accepted: boolean; reason: 'accepted' | 'quality-floor' | 'strategy-boundary' }[];
}
/** Initial model defaults are evaluation starting points; callers may override the floor per model. */
export function defaultBoundaryConfig(model: string): RelationBoundaryConfig {
  const modelFloors: Record<string, number> = { 'tencent/WeMM-Embedding-2B': 0.55 };
  return { strategy: 'adaptive-gap', qualityFloor: modelFloors[model] ?? 0.55, gap: { ...DEFAULT_GAP_OPTIONS } };
}
export function validateBoundaryConfig(config: RelationBoundaryConfig): void {
  if (!config.strategy || !Number.isFinite(config.qualityFloor) || config.qualityFloor < -1 || config.qualityFloor > 1
    || !config.gap || !Number.isFinite(config.gap.madMultiplier) || config.gap.madMultiplier < 0
    || !Number.isFinite(config.gap.minimumGap) || config.gap.minimumGap <= 0 || config.gap.minimumGap > 2
    || !Number.isSafeInteger(config.gap.minimumBoundaryRank) || config.gap.minimumBoundaryRank < 2
    || !Number.isSafeInteger(config.gap.minimumCandidates) || config.gap.minimumCandidates < 2) throw new Error('Invalid relation boundary configuration');
}
export function applyRelationBoundary(pool: SemanticCandidatePool, config: RelationBoundaryConfig, strategy: RelationBoundaryStrategy = adaptiveGapStrategy): RelationBoundary {
  validateBoundaryConfig(config);
  if (strategy.id !== config.strategy) throw new Error(`Relation boundary strategy is not installed: ${config.strategy}`);
  const selected = strategy.select(structuredClone(pool), structuredClone(config));
  const ids = new Set(selected.ids);
  if (selected.ids.some(id => !pool.candidates.some(c => c.id === id))) throw new Error('Boundary strategy selected a candidate outside its pool');
  return { strategy: strategy.id, strategyVersion: strategy.version, config: structuredClone(config), poolSize: pool.candidates.length,
    totalCandidates: pool.totalCandidates, poolTruncated: pool.totalCandidates > pool.candidates.length,
    cutRank: selected.cutRank, ...(selected.gap ? { gap: selected.gap } : {}),
    decisions: pool.candidates.map(c => ({ id: c.id, similarity: c.similarity, accepted: ids.has(c.id) && c.similarity >= config.qualityFloor,
      reason: c.similarity < config.qualityFloor ? 'quality-floor' : ids.has(c.id) ? 'accepted' : 'strategy-boundary' })) };
}
