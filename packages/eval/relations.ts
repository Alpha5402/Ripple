import { combineSignalScores, DEFAULT_SCORE_POLICY, relationKey } from '../core/relation.js';
import { KernelError } from '../core/model.js';
export interface PairLabel { nodes: [string, string]; split: 'dev' | 'test'; grade: 0 | 1 | 2 | 3; hardNegative: boolean; rationale: string; labelSource: string; reviewStatus: string }
export interface PairFeatures { nodes: [string, string]; mention: number; explicit: 0 | 1; cosine?: number }
export type EvalMethod = 'mention-explicit' | 'semantic' | 'hybrid';
export interface Mapping { min: number; max: number }
export const semanticStrength = (cosine: number | undefined, mapping: Mapping): number => cosine === undefined || cosine < mapping.min ? 0 : Math.min(1, Math.max(0, (cosine - mapping.min) / (mapping.max - mapping.min)));
export function evaluateRelations(labels: PairLabel[], features: PairFeatures[], mapping: Mapping, method: EvalMethod, k = 3, threshold = 0.5) {
  if (!(mapping.min < mapping.max) || !Number.isFinite(mapping.min) || !Number.isFinite(mapping.max) || !Number.isInteger(k) || k < 1) throw new KernelError('INVALID_INPUT', 'Invalid evaluation configuration');
  if (!labels.length || new Set(labels.map(l => l.split)).size !== 1) throw new KernelError('INVALID_INPUT', 'Evaluate one nonempty split at a time');
  const lookup = new Map(features.map(f => [relationKey(...f.nodes), f]));
  const seen = new Set<string>();
  const rows = labels.map(label => {
    const id = relationKey(...label.nodes);
    if (seen.has(id) || label.nodes[0] === label.nodes[1] || ![0, 1, 2, 3].includes(label.grade)) throw new KernelError('INVALID_INPUT', 'Invalid or duplicate graded pair');
    seen.add(id);
    const feature = lookup.get(id);
    if (!feature) throw new KernelError('INVALID_INPUT', `Missing features for ${id}`);
    const semantic = method === 'mention-explicit' ? 0 : semanticStrength(feature.cosine, mapping);
    const score = method === 'semantic' ? semantic : combineSignalScores(feature.mention, feature.explicit, semantic, DEFAULT_SCORE_POLICY);
    return { ...label, ...feature, score };
  });
  const centers = [...new Set(rows.flatMap(r => r.nodes))].sort();
  const dcg = (grades: number[]) => grades.reduce((n, grade, i) => n + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const queries = centers.map(center => {
    const pool = rows.filter(row => row.nodes.includes(center));
    if (pool.length !== centers.length - 1) throw new KernelError('INVALID_INPUT', 'Each center needs a fully judged candidate pool');
    const ranked = pool.filter(row => row.score > 0).sort((a, b) => b.score - a.score || relationKey(...a.nodes).localeCompare(relationKey(...b.nodes)));
    const ideal = pool.map(row => row.grade).sort((a, b) => b - a), idealDcg = dcg(ideal.slice(0, k));
    const relevant = pool.filter(row => row.grade >= 2).length;
    const visible = ranked.filter(row => row.score >= threshold);
    return { center, candidates: pool.length, relevant, returned: ranked.length,
      precisionAtK: ranked.slice(0, k).filter(row => row.grade >= 2).length / k,
      oraclePrecisionAtK: Math.min(k, relevant) / k,
      ndcgAtK: idealDcg ? dcg(ranked.slice(0, k).map(row => row.grade)) / idealDcg : null,
      visible: visible.length, irrelevantVisible: visible.filter(r => r.grade === 0).length,
      top: ranked.slice(0, k).map(row => ({ nodes: row.nodes, score: row.score, grade: row.grade, hardNegative: row.hardNegative })),
    };
  });
  const relevantQueries = queries.filter(q => q.relevant > 0);
  const mean = (items: number[]) => items.length ? items.reduce((a, b) => a + b, 0) / items.length : 0;
  const hardNegatives = rows.filter(r => r.hardNegative), zeroRelevant = queries.filter(q => q.relevant === 0);
  return { method, k, threshold, candidateBudget: centers.length - 1, queries: queries.length, gradedPairs: rows.length,
    scoredQueries: relevantQueries.length, zeroRelevantQueries: zeroRelevant.length,
    precisionAtK: mean(relevantQueries.map(q => q.precisionAtK)), oraclePrecisionAtK: mean(relevantQueries.map(q => q.oraclePrecisionAtK)),
    ndcgAtK: mean(relevantQueries.map(q => q.ndcgAtK ?? 0)),
    hardNegativeVisibleRate: mean(hardNegatives.map(r => r.score >= threshold ? 1 : 0)),
    irrelevantVisibleRate: mean(rows.filter(r => r.grade === 0).map(r => r.score >= threshold ? 1 : 0)),
    zeroRelevantQueryFalsePositiveRate: mean(zeroRelevant.map(q => q.visible > 0 ? 1 : 0)),
    perQuery: queries, failures: rows.filter(r => r.grade === 0 && r.score >= threshold),
    missedUseful: rows.filter(r => r.grade >= 2 && r.score < threshold),
  };
}
export function calibrateOnDevelopment(labels: PairLabel[], features: PairFeatures[]) {
  if (labels.some(label => label.split !== 'dev')) throw new KernelError('INVALID_INPUT', 'Final test labels must never select a mapping');
  const grid = [0.2, 0.35, 0.5, 0.65].map(min => {
    const mapping = { min, max: 0.9 }, result = evaluateRelations(labels, features, mapping, 'hybrid');
    return { mapping, objective: result.ndcgAtK + 0.5 * result.precisionAtK - 0.5 * result.hardNegativeVisibleRate - 0.25 * result.zeroRelevantQueryFalsePositiveRate,
      metrics: { ndcgAt3: result.ndcgAtK, precisionAt3: result.precisionAtK, hardNegativeVisibleRate: result.hardNegativeVisibleRate, zeroRelevantQueryFalsePositiveRate: result.zeroRelevantQueryFalsePositiveRate } };
  });
  grid.sort((a, b) => b.objective - a.objective || a.mapping.min - b.mapping.min);
  return { selected: grid[0]!.mapping, objective: 'nDCG@3 + 0.5 P@3 - 0.5 hardNegativeVisibleRate - 0.25 zeroRelevantQueryFalsePositiveRate', grid };
}
