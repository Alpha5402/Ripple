import type { KnowledgeStorage } from '../../core/ports.js';
import type { KernelState } from '../../core/model.js';

export class MemoryStorage implements KnowledgeStorage {
  readonly storageCapabilities = { kind: 'memory', persistent: false, concurrency: 'single-instance' as const };
  private state: KernelState;
  constructor(initial?: KernelState) {
    this.state = structuredClone(initial ?? {
      documents: [], revisions: {}, validityEpochs: {}, indexRevision: 0, userPolicyRevision: 0,
      declarations: { schemaVersion: 1, aliases: [], relations: {} },
    });
  }
  load(): KernelState { return structuredClone(this.state); }
  save(state: KernelState): void { this.state = structuredClone(state); }
}
