import type { ExplorationHistoryState } from '../core/model.js';
import type { Relation } from '../core/model.js';

/** A local-range position, independent of candidate count. */
export function initialLens(_relations: Relation[], position = 50): number { return position; }

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
