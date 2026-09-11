import { KernelError, type Mention, type Relation, type RelationCandidate, type ScorePolicy, type UserDeclarations, type WikiLink } from './model.js';

export const DEFAULT_SCORE_POLICY: Readonly<ScorePolicy> = Object.freeze({
  version: 'mention-explicit-v1', mentionBase: 0.5, sectionIncrement: 0.1, mentionCap: 0.8, explicitBoost: 0.3,
});
export const relationKey = (a: string, b: string): string => JSON.stringify([a, b].sort());
export function validateScorePolicy(policy: ScorePolicy): void {
  if (!policy.version || [policy.mentionBase, policy.sectionIncrement, policy.mentionCap, policy.explicitBoost]
    .some(n => !Number.isFinite(n) || n < 0 || n > 1) || policy.mentionBase > policy.mentionCap) {
    throw new KernelError('INVALID_INPUT', 'Invalid score policy');
  }
}
export function generateCandidates(mentions: Mention[], links: WikiLink[]): RelationCandidate[] {
  const pairs = new Map<string, RelationCandidate>();
  for (const [kind, references] of [['mention', mentions], ['explicit', links]] as const) {
    for (const reference of references) {
      if (reference.resolution.status !== 'resolved') continue;
      const from = reference.sourceDocumentId;
      const to = reference.resolution.candidates[0]!.documentId;
      if (from === to) continue;
      const id = relationKey(from, to);
      const candidate = pairs.get(id) ?? { id, nodes: [from, to].sort() as [string, string], signals: [] };
      let signal = candidate.signals.find(s => s.kind === kind && s.from === from && s.to === to);
      if (!signal) { signal = { kind, from, to, evidence: [], rawValue: 0 }; candidate.signals.push(signal); }
      signal.evidence.push(reference.evidence);
      signal.rawValue += 1;
      pairs.set(id, candidate);
    }
  }
  return [...pairs.values()];
}
export function scoreCandidate(candidate: RelationCandidate, policy: ScorePolicy, declarations: UserDeclarations): Relation {
  const sections = new Set(candidate.signals.filter(s => s.kind === 'mention')
    .flatMap(s => s.evidence.map(e => `${e.documentId}:${e.sectionId}`)));
  const mention = sections.size ? Math.min(policy.mentionCap, policy.mentionBase + (sections.size - 1) * policy.sectionIncrement) : 0;
  const explicit = candidate.signals.some(s => s.kind === 'explicit') ? 1 : 0;
  const score = Number((mention + policy.explicitBoost * explicit * (1 - mention)).toFixed(12));
  return {
    ...candidate, score, scoreVersion: policy.version,
    components: { mention, explicit, semantic: { status: 'not-configured' } },
    override: { ...declarations.relations[candidate.id] },
  };
}
export const compareRelations = (a: Relation, b: Relation): number => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
