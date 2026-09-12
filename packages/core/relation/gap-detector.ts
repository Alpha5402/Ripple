export interface GapOptions { madMultiplier: number; minimumGap: number; minimumBoundaryRank: number; minimumCandidates: number }
export interface GapDiagnostics {
  gaps: number[]; median: number; mad: number; significanceThreshold: number;
  significantRanks: number[]; boundaryRank: number | null;
}
export const DEFAULT_GAP_OPTIONS: Readonly<GapOptions> = { madMultiplier: 3.5, minimumGap: 0.01, minimumBoundaryRank: 2, minimumCandidates: 4 };
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
/** A significant discontinuity, not the largest ordinary fluctuation. Rank-one outliers do not cut the neighborhood. */
export function detectSignificantGap(scores: readonly number[], options: GapOptions = DEFAULT_GAP_OPTIONS): GapDiagnostics {
  if (scores.some((score, i) => !Number.isFinite(score) || (i > 0 && score > scores[i - 1]!))) throw new Error('Gap scores must be finite and descending');
  const gaps = scores.slice(0, -1).map((score, i) => Math.max(0, score - scores[i + 1]!));
  const center = median(gaps), mad = median(gaps.map(gap => Math.abs(gap - center)));
  const significanceThreshold = center + Math.max(options.minimumGap, options.madMultiplier * 1.4826 * mad);
  const significantRanks = scores.length < options.minimumCandidates ? [] : gaps.flatMap((gap, i) => i + 1 >= options.minimumBoundaryRank && gap > significanceThreshold + 1e-12 ? [i + 1] : []);
  return { gaps, median: center, mad, significanceThreshold, significantRanks, boundaryRank: significantRanks[0] ?? null };
}
