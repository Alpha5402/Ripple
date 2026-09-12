import type { ExplorationHistoryState } from '../core/model.js';
import type { Relation } from '../core/model.js';

/** Start with about five qualified neighbors without lowering the default quality floor. Ties stay together. */
export function initialLens(relations: Relation[], maximum = 45): number {
  const qualified = relations.filter(r => !r.override.hidden && r.score >= 1 - maximum / 100).sort((a, b) => b.score - a.score);
  return qualified.length > 6 ? Math.min(maximum, Math.ceil((1 - qualified[4]!.score) * 100)) : maximum;
}

/** Place the complete candidate set once. Filtering never moves surviving nodes. */
export function completeLayout(state: ExplorationHistoryState): ExplorationHistoryState['layout'] {
  const layout = { ...state.layout, [state.snapshot.focusNode]: state.layout[state.snapshot.focusNode] ?? { x: 0, y: 0 } };
  const nodes = state.snapshot.candidateSet.map(r => r.nodes.find(id => id !== state.snapshot.focusNode)!);
  let ring = 0, start = 0;
  for (let i = 0; i < nodes.length; i++) {
    const capacity = 6 + ring * 6;
    if (i - start >= capacity) { start += capacity; ring++; }
    const count = 6 + ring * 6;
    const angle = -Math.PI / 2 + (i - start) / count * Math.PI * 2 + ring * 0.17;
    const radius = 195 + ring * 160;
    layout[nodes[i]!] ??= { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }
  return layout;
}
