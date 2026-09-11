import type { Document } from '../model.js';
import type { IdentityProvider } from '../ports.js';
import { createEmbeddingSpace } from './config.js';
import { prepareKnowledgeUnits } from './chunk.js';
import {
  EmbeddingError, type EmbeddingCache, type EmbeddingConfig, type EmbeddingCoverage, type EmbeddingDocumentState,
  type EmbeddingProvider, type EmbeddingRunReport, type EmbeddingSpace, type MediaResolver, type PreparedUnit, type VectorRecord,
} from './model.js';

export function checkedVector(vector: number[], dimensions: number, normalized: boolean): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new EmbeddingError('INVALID_RESPONSE', 'Provider returned invalid vector dimensions or values');
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(norm) || norm <= 1e-12) throw new EmbeddingError('INVALID_RESPONSE', 'Provider returned a zero or invalid vector');
  if (normalized && Math.abs(norm - 1) > 0.03) throw new EmbeddingError('INVALID_RESPONSE', 'Provider violated its normalized-vector contract');
  return vector.map(n => n / norm);
}
const details = (error: unknown): { code: string; message: string } => ({ code: error instanceof EmbeddingError ? error.code : 'PROVIDER', message: error instanceof Error ? error.message : 'Unknown provider failure' });
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new EmbeddingError('CANCELLED', 'Embedding cancelled');
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => { clearTimeout(timer); reject(new EmbeddingError('CANCELLED', 'Embedding cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export class EmbeddingEngine {
  readonly space: EmbeddingSpace;
  private cache: EmbeddingCache;
  private stopped = false;
  private sequence = 0;
  private jobs = new Map<string, { sequence: number; revision: number; controller: AbortController }>();
  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly config: EmbeddingConfig,
    private readonly identity: IdentityProvider,
    private readonly documents: () => Document[],
    private readonly publish: (cache: EmbeddingCache) => void,
    initial: EmbeddingCache | undefined,
    private readonly resolver?: MediaResolver,
  ) {
    this.space = createEmbeddingSpace(provider.descriptor, config, identity);
    this.cache = structuredClone(initial ?? { schemaVersion: 1, spaces: {} });
    const previous = this.cache.spaces[this.space.id];
    this.cache.spaces[this.space.id] = previous ?? { space: this.space, config: structuredClone(config), records: [], documents: {} };
    const stored = this.cache.spaces[this.space.id]!;
    stored.config = structuredClone(config);
    // A vector cache is disposable. Bad vectors must not contaminate scores or prevent deterministic use.
    stored.records = stored.records.filter(record => {
      try { checkedVector(record.vector, this.space.descriptor.dimensions, true); return true; }
      catch {
        const status = stored.documents[record.unit.documentId];
        if (status) { status.status = 'pending'; status.readyCount = Math.max(0, status.readyCount - 1); }
        return false;
      }
    });
    this.cache.activeSpaceId = this.space.id;
  }
  activate(): void { this.publish(structuredClone(this.cache)); }
  stop(): void { this.stopped = true; for (const job of this.jobs.values()) job.controller.abort(); }
  cancel(): void { for (const job of this.jobs.values()) job.controller.abort(); }
  invalidateChangedDocuments(): void {
    const documents = new Map(this.documents().map(doc => [doc.id, doc]));
    for (const [id, job] of this.jobs) if (documents.get(id)?.revision !== job.revision) job.controller.abort();
  }
  coverage(): EmbeddingCoverage {
    const stored = this.cache.spaces[this.space.id]!;
    const documents: Record<string, EmbeddingDocumentState> = {};
    for (const doc of this.documents()) {
      const previous = stored.documents[doc.id];
      documents[doc.id] = !previous ? { revision: doc.revision, status: 'pending', unitCount: 0, readyCount: 0, errors: [] }
        : previous.revision !== doc.revision ? { ...previous, status: 'stale', readyCount: 0 }
          : structuredClone(previous);
    }
    const statuses = Object.values(documents);
    const readyUnits = statuses.reduce((n, d) => n + d.readyCount, 0);
    return { spaceId: this.space.id, documents, readyUnits, totalUnits: statuses.reduce((n, d) => n + d.unitCount, 0),
      status: statuses.every(d => d.status === 'ready') ? 'ready' : readyUnits ? 'partial' : statuses.some(d => d.errors.length) ? 'error' : 'pending' };
  }
  private current(id: string, revision: number, sequence: number): boolean {
    return !this.stopped && this.jobs.get(id)?.sequence === sequence && this.documents().some(doc => doc.id === id && doc.revision === revision);
  }
  private async retry<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new EmbeddingError('CANCELLED', 'Embedding cancelled');
      try { return await operation(); }
      catch (error) {
        if (signal.aborted) throw new EmbeddingError('CANCELLED', 'Embedding cancelled');
        if (!(error instanceof EmbeddingError) || !error.retryable || attempt >= this.config.execution.maxRetries) throw error;
        await delay(Math.min(60_000, this.config.execution.retryDelayMs * 2 ** attempt), signal);
      }
    }
  }
  async index(options: { documentIds?: string[]; signal?: AbortSignal } = {}): Promise<EmbeddingRunReport> {
    const report: EmbeddingRunReport = { spaceId: this.space.id, encoded: 0, reused: 0, discarded: 0, cancelled: false, documents: {} };
    const selected = this.documents().filter(doc => !options.documentIds || options.documentIds.includes(doc.id));
    if (options.documentIds?.some(id => !selected.some(doc => doc.id === id))) throw new EmbeddingError('NOT_FOUND', 'Unknown document selected for embedding');
    // Reserve all selected document jobs before awaiting: later runs supersede this run, including queued documents.
    const reservations = new Map(selected.map(doc => {
      this.jobs.get(doc.id)?.controller.abort();
      const job = { sequence: ++this.sequence, revision: doc.revision, controller: new AbortController() };
      this.jobs.set(doc.id, job); return [doc.id, job] as const;
    }));
    for (const doc of selected) {
      const job = reservations.get(doc.id)!;
      const signal = options.signal ? AbortSignal.any([options.signal, job.controller.signal]) : job.controller.signal;
      const state: EmbeddingDocumentState = { revision: doc.revision, status: 'pending', unitCount: 0, readyCount: 0, errors: [] };
      let prepared: PreparedUnit[] = [];
      const ready: VectorRecord[] = [];
      const oldRecords = this.cache.spaces[this.space.id]!.records.filter(record => record.unit.documentId === doc.id);
      let preparationComplete = false;
      try {
        if (!this.current(doc.id, doc.revision, job.sequence) || signal.aborted) throw new EmbeddingError('CANCELLED', 'Document task superseded or cancelled');
        const retryingProvider: EmbeddingProvider = { descriptor: this.provider.descriptor,
          countTokens: (inputs, opts) => this.retry(() => this.provider.countTokens(inputs, opts), opts.signal),
          embed: (inputs, opts) => this.retry(() => this.provider.embed(inputs, opts), opts.signal) };
        const result = await prepareKnowledgeUnits(doc, retryingProvider, this.config, this.identity, signal, this.resolver);
        prepared = result.units; state.errors.push(...result.errors); state.unitCount = prepared.length;
        preparationComplete = true;
        const oldByHash = new Map(oldRecords.map(record => [record.unit.contentHash, record]));
        const pending: PreparedUnit[] = [];
        for (const unit of prepared) {
          const cached = oldByHash.get(unit.unit.contentHash);
          if (cached) { ready.push({ unit: unit.unit, vector: cached.vector }); report.reused++; }
          else pending.push(unit);
        }
        for (let offset = 0; offset < pending.length; offset += this.config.execution.batchSize) {
          const batch = pending.slice(offset, offset + this.config.execution.batchSize);
          try {
            const vectors = await this.retry(() => this.provider.embed(batch.map(unit => unit.input), { signal }), signal);
            if (!this.current(doc.id, doc.revision, job.sequence) || signal.aborted) throw new EmbeddingError('CANCELLED', 'Late embedding response discarded');
            if (vectors.length !== batch.length) throw new EmbeddingError('INVALID_RESPONSE', 'Provider returned a different batch size');
            const validated = vectors.map(vector => checkedVector(vector, this.space.descriptor.dimensions, this.space.descriptor.normalized));
            batch.forEach((item, i) => ready.push({ unit: item.unit, vector: validated[i]! }));
            report.encoded += batch.length;
          } catch (error) { if (signal.aborted || !this.current(doc.id, doc.revision, job.sequence)) throw error; state.errors.push(details(error)); }
        }
        state.readyCount = ready.length;
        state.status = state.errors.length ? (ready.length ? 'partial' : 'error') : 'ready';
      } catch (error) {
        // Tokenization outages or cancellation do not invalidate vectors for unchanged source revisions.
        if (!preparationComplete || signal.aborted) {
          for (const record of oldRecords) if (record.unit.revision === doc.revision && !ready.some(item => item.unit.id === record.unit.id)) ready.push(record);
          state.unitCount = Math.max(state.unitCount, ready.length);
        }
        state.errors.push(details(error));
        state.status = signal.aborted || this.stopped ? 'cancelled' : error instanceof EmbeddingError && error.code === 'LIMIT' ? 'limit-exceeded'
          : error instanceof EmbeddingError && error.code === 'CAPABILITY' ? 'unsupported' : ready.length ? 'partial' : 'error';
        state.readyCount = ready.length;
        if (state.status === 'cancelled') report.cancelled = true;
      }
      report.documents[doc.id] = state;
      if (this.current(doc.id, doc.revision, job.sequence)) {
        const stored = this.cache.spaces[this.space.id]!;
        const nextRecords = [...stored.records.filter(record => record.unit.documentId !== doc.id), ...ready].sort((a, b) => a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0);
        if (JSON.stringify(stored.documents[doc.id]) !== JSON.stringify(state) || JSON.stringify(stored.records) !== JSON.stringify(nextRecords)) {
          stored.records = nextRecords; stored.documents[doc.id] = structuredClone(state);
          this.publish(structuredClone(this.cache));
        }
      } else report.discarded += prepared.length;
      if (this.jobs.get(doc.id)?.sequence === job.sequence) this.jobs.delete(doc.id);
    }
    return report;
  }
}
