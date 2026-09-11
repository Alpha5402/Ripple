import { KernelError, type ExplorationHistoryState, type VisibleRelations } from '../core/model.js';
import { validateSnapshot } from '../core/exploration.js';
import { KnowledgeService } from '../core/service.js';

export interface SessionState { schemaVersion: 1; current: ExplorationHistoryState | null; backStack: ExplorationHistoryState[] }
/** Host-owned view coordinates and reading offsets round-trip without any DOM or graph dependency. */
export class ExplorationSession {
  private state: SessionState = { schemaVersion: 1, current: null, backStack: [] };
  constructor(private readonly knowledge: KnowledgeService) {}
  focus(nodeId: string, options: { lensValue?: number; visibleBudget?: number } = {}): ExplorationHistoryState {
    const snapshot = this.knowledge.createExplorationSnapshot(nodeId, options);
    if (this.state.current) this.state.backStack.push(structuredClone(this.state.current));
    this.state.current = {
      schemaVersion: 1, snapshot, layout: {}, camera: { x: 0, y: 0, zoom: 1 }, reading: null,
      visited: [...new Set([...(this.state.current?.visited ?? []), nodeId])],
    };
    return this.current!;
  }
  get current(): ExplorationHistoryState | null { return structuredClone(this.state.current); }
  private requireCurrent(): ExplorationHistoryState {
    if (!this.state.current) throw new KernelError('NOT_FOUND', 'No active focus');
    return this.state.current;
  }
  setLens(value: number): VisibleRelations {
    const current = this.requireCurrent(); current.snapshot = this.knowledge.setLens(current.snapshot, value); return this.visible();
  }
  loadMore(count = 40): VisibleRelations {
    if (!Number.isSafeInteger(count) || count < 1) throw new KernelError('INVALID_INPUT', 'Load count must be a positive integer');
    const current = this.requireCurrent();
    current.snapshot = this.knowledge.setVisibleBudget(current.snapshot, current.snapshot.visibleBudget + count);
    return this.visible();
  }
  visible(): VisibleRelations { return this.knowledge.getVisibleRelations(this.requireCurrent().snapshot); }
  back(): { state: ExplorationHistoryState; view: VisibleRelations } | null {
    const previous = this.state.backStack.pop();
    if (!previous) return null;
    this.state.current = previous;
    return { state: this.current!, view: this.visible() };
  }
  refresh(): VisibleRelations {
    const current = this.requireCurrent();
    const oldSnapshot = current.snapshot;
    current.snapshot = this.knowledge.createExplorationSnapshot(current.snapshot.focusNode, {
      lensValue: current.snapshot.lensValue, visibleBudget: current.snapshot.visibleBudget,
    });
    if (current.reading && oldSnapshot.candidateRevisions[current.reading.documentId] !== this.knowledge.getNode(current.reading.documentId)?.revision) current.reading = null;
    return this.visible();
  }
  setViewState(view: Partial<Pick<ExplorationHistoryState, 'layout' | 'camera' | 'reading'>>): void {
    const current = this.requireCurrent();
    this.state.current = { ...current, ...structuredClone(view) };
  }
  exportState(): SessionState { return structuredClone(this.state); }
  importState(state: SessionState): void {
    if (state?.schemaVersion !== 1 || !Array.isArray(state.backStack)) throw new KernelError('INVALID_SNAPSHOT', 'Unsupported session state');
    for (const entry of [...state.backStack, ...(state.current ? [state.current] : [])]) {
      if (entry.schemaVersion !== 1 || !entry.layout || !entry.camera || !Array.isArray(entry.visited)) throw new KernelError('INVALID_SNAPSHOT', 'Invalid history entry');
      validateSnapshot(entry.snapshot);
    }
    this.state = structuredClone(state);
  }
}
