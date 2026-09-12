import { KnowledgeService } from '../../core/service.js';
import { MemoryStorage } from '../storage-memory/index.js';
import { RemarkMarkdownParser } from '../parser-markdown/index.js';
import { KernelError, type DocumentInput, type Relation, type RelationSignal, type Snapshot } from '../../core/model.js';
import type { KnowledgeStorage, IdentityProvider } from '../../core/ports.js';
import { scoreCandidate, relationKey, compareRelations } from '../../core/relation.js';
import { visibleSnapshot } from '../../core/visibility.js';
import type { PublicBundle } from './model.js';
import { validateSnapshot } from '../../core/exploration.js';

/** Precomputed semantic evidence is immutable. Browser edits rebuild M/E and invalidate touched semantic pairs. */
export class PublicKnowledgeService {
  readonly kernel: KnowledgeService;
  private readonly originalHashes: Map<string, string>;
  private readonly semanticSignatures = new Set<string>();
  private readonly bundle: PublicBundle;
  constructor(bundle: PublicBundle, identity: IdentityProvider, storage?: KnowledgeStorage) {
    if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.documents) || bundle.documents.length > 1000) throw new KernelError('INVALID_INPUT', 'Invalid public package');
    this.bundle = structuredClone(bundle);
    this.kernel = new KnowledgeService({ storage: storage ?? new MemoryStorage(), parser: new RemarkMarkdownParser(), identity }, bundle.scorePolicy);
    this.kernel.ingestDocuments(bundle.documents);
    this.originalHashes = new Map(this.kernel.listDocuments().map(d => [d.id, d.contentHash]));
    for (const signal of bundle.semantic?.signals ?? []) {
      if (signal.kind !== 'semantic' || !signal.semantic || signal.semantic.spaceId !== bundle.semantic?.spaceId || signal.evidence.some(e => this.kernel.getEvidence(e).status !== 'valid')) throw new KernelError('INVALID_INPUT', 'Public semantic evidence is invalid');
      this.semanticSignatures.add(JSON.stringify(signal));
    }
    for (const doc of this.kernel.listDocuments()) this.createExplorationSnapshot(doc.id);
  }
  getNode(id: string) { return this.kernel.getNode(id); }
  listDocuments() { return this.kernel.listDocuments(); }
  resolveEntity(name: string, sourceId?: string) { return this.kernel.resolveEntity(name, sourceId); }
  findMentions(query: Parameters<KnowledgeService['findMentions']>[0] = {}) { return this.kernel.findMentions(query); }
  findWikiLinks(query: Parameters<KnowledgeService['findWikiLinks']>[0] = {}) { return this.kernel.findWikiLinks(query); }
  getEvidence(locator: Parameters<KnowledgeService['getEvidence']>[0]) { return this.kernel.getEvidence(locator); }
  ingestDocument(input: DocumentInput) { return this.kernel.ingestDocument(input); }
  getIndexCoverage() {
    const coverage = this.kernel.getIndexCoverage();
    if (this.bundle.semantic) {
      const readyUnits = new Set(this.bundle.semantic.signals.filter(s => this.semanticValid(s)).flatMap(s => s.semantic!.contributions.flatMap(c => c.unitIds))).size;
      coverage.semantic = { status: readyUnits ? 'ready' : 'stale', spaceId: this.bundle.semantic.spaceId, documents: {}, readyUnits, totalUnits: new Set(this.bundle.semantic.signals.flatMap(s => s.semantic!.contributions.flatMap(c => c.unitIds))).size };
    }
    return coverage;
  }
  private semanticValid(signal: RelationSignal): boolean {
    return this.semanticSignatures.has(JSON.stringify(signal)) && [signal.from, signal.to].every(id => this.kernel.getNode(id)?.contentHash === this.originalHashes.get(id)) && signal.evidence.every(e => this.kernel.getEvidence(e).status === 'valid');
  }
  private get scoreVersion() { return `${this.bundle.scorePolicy.version}/public-${this.bundle.id}`; }
  getRelations(id: string): Relation[] {
    const pairs = new Map(this.kernel.getRelations(id).map(r => [r.id, { id: r.id, nodes: r.nodes, signals: r.signals }]));
    for (const signal of this.bundle.semantic?.signals ?? []) {
      if (![signal.from, signal.to].includes(id) || !this.semanticValid(signal)) continue;
      const key = relationKey(signal.from, signal.to);
      const candidate = pairs.get(key) ?? { id: key, nodes: [signal.from, signal.to].sort() as [string, string], signals: [] };
      candidate.signals.push(structuredClone(signal)); pairs.set(key, candidate);
    }
    return [...pairs.values()].map(c => ({ ...scoreCandidate(c, this.bundle.scorePolicy, { schemaVersion: 1, aliases: [], relations: {} }), scoreVersion: this.scoreVersion })).sort(compareRelations);
  }
  createExplorationSnapshot(id: string, options: { lensValue?: number; visibleBudget?: number } = {}): Snapshot {
    const base = this.kernel.createExplorationSnapshot(id, options);
    const candidates = this.getRelations(id);
    const semantic = new Set(candidates.filter(r => r.signals.some(s => s.kind === 'semantic')).slice(0, 100).map(r => r.id));
    base.candidateSet = candidates.filter(r => semantic.has(r.id) || r.signals.some(s => s.kind !== 'semantic'));
    base.relationScoreVersion = this.scoreVersion;
    base.candidateBudget.semantic = 100;
    base.candidateVersion += `/public-${this.bundle.id}`;
    if (this.bundle.semantic) base.embeddingSpaceId = this.bundle.semantic.spaceId;
    const state = this.kernel.exportState();
    for (const docId of new Set([id, ...base.candidateSet.flatMap(r => r.nodes)])) { base.candidateRevisions[docId] = this.kernel.getNode(docId)!.revision; base.validityEpochs[docId] = state.validityEpochs[docId]!; }
    validateSnapshot(base); return base;
  }
  setLens(snapshot: Snapshot, value: number) { return this.kernel.setLens(snapshot, value); }
  setVisibleBudget(snapshot: Snapshot, value: number) { return this.kernel.setVisibleBudget(snapshot, value); }
  getVisibleRelations(snapshot: Snapshot) {
    const state = this.kernel.exportState();
    const deterministic = new Set(this.kernel.getRelations(snapshot.focusNode).flatMap(r => r.signals).map(s => JSON.stringify(s)));
    return visibleSnapshot(snapshot, { indexRevision: state.indexRevision, relationScoreVersion: this.scoreVersion, userPolicyRevision: 0,
      ...(this.bundle.semantic ? { embeddingSpaceId: this.bundle.semantic.spaceId } : {}), revision: id => this.kernel.getNode(id)?.revision,
      validityEpoch: id => state.validityEpochs[id], override: () => ({}),
      signalValid: signal => signal.kind === 'semantic' ? this.semanticValid(signal) : deterministic.has(JSON.stringify(signal)),
    });
  }
}
