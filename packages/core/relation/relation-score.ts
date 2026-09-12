import type { Relation, RelationCandidate, ScorePolicy, UserDeclarations } from '../model.js';
import type { SemanticState } from '../embedding/model.js';

export function combineSignalScores(mention: number, explicit: 0 | 1, semanticStrength: number, policy: ScorePolicy): number {
  const base = Math.max(mention, semanticStrength);
  return Number((base + policy.explicitBoost * explicit * (1 - base)).toFixed(12));
}
export function scoreCandidate(candidate: RelationCandidate, policy: ScorePolicy, declarations: UserDeclarations, semanticState: SemanticState = { status: 'not-configured' }): Relation {
  const sections = new Set(candidate.signals.filter(s => s.kind === 'mention')
    .flatMap(s => s.evidence.map(e => `${e.documentId}:${e.sectionId}`)));
  const mention = sections.size ? Math.min(policy.mentionCap, policy.mentionBase + (sections.size - 1) * policy.sectionIncrement) : 0;
  const explicit = candidate.signals.some(s => s.kind === 'explicit') ? 1 : 0;
  const semantic = candidate.signals.filter(s => s.kind === 'semantic').sort((a, b) => (b.semantic?.strength ?? 0) - (a.semantic?.strength ?? 0))[0];
  const score = combineSignalScores(mention, explicit, semantic?.semantic?.strength ?? 0, policy);
  return {
    ...candidate, score, scoreVersion: policy.version,
    components: { mention, explicit, semantic: semantic?.semantic ? { status: 'ready', spaceId: semantic.semantic.spaceId, strength: semantic.semantic.strength, cosine: semantic.rawValue } : semanticState },
    override: { ...declarations.relations[candidate.id] },
  };
}
export const compareRelations = (a: Relation, b: Relation): number => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
