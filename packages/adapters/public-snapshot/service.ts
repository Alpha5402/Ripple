import { applyRelationBoundary, defaultBoundaryConfig, adaptiveGapStrategy } from '../../core/relation/relation-boundary.js';
import { acceptedSemanticSignal, compareSemanticCandidates, type SemanticCandidate, type SemanticCandidatePool } from '../../core/relation/semantic-candidate.js';
import { DEFAULT_EMBEDDING_CONFIG, stableStringify } from '../../core/embedding/config.js';
import { localLensMapping } from '../../core/exploration/lens.js';
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
  private queryRevision = -1;
  private readonly queryCache = new Map<string, { relations: Relation[]; pool: SemanticCandidatePool; boundary: ReturnType<typeof applyRelationBoundary> }>();
  private readonly bundle: PublicBundle;
  constructor(bundle: PublicBundle, private readonly identity: IdentityProvider, storage?: KnowledgeStorage) {
    if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.documents) || bundle.documents.length > 1000) throw new KernelError('INVALID_INPUT', 'Invalid public package');
    this.bundle = structuredClone(bundle);
    this.kernel = new KnowledgeService({ storage: storage ?? new MemoryStorage(), parser: new RemarkMarkdownParser(), identity }, bundle.scorePolicy);
    this.kernel.ingestDocuments(bundle.documents);
    this.originalHashes = new Map(this.kernel.listDocuments().map(d => [d.id, d.contentHash]));
    for (const signal of bundle.semantic?.signals ?? []) {
      if (signal.kind !== 'semantic' || !signal.semantic || signal.semantic.spaceId !== bundle.semantic?.spaceId || signal.evidence.some(e => this.kernel.getEvidence(e).status !== 'valid')) throw new KernelError('INVALID_INPUT', 'Public semantic evidence is invalid');
      this.semanticSignatures.add(stableStringify({ ...signal, semantic: { ...signal.semantic, strength: 0 } }));
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
    return this.semanticSignatures.has(stableStringify({ ...signal, semantic: signal.semantic ? { ...signal.semantic, strength: 0 } : undefined })) && [signal.from, signal.to].every(id => this.kernel.getNode(id)?.contentHash === this.originalHashes.get(id)) && signal.evidence.every(e => this.kernel.getEvidence(e).status === 'valid');
  }
  private get boundaryConfig() { return this.bundle.semantic?.retrieval?.boundary ?? defaultBoundaryConfig(this.bundle.semantic?.descriptor.model ?? ''); }
  private get scoreVersion() { return `${this.bundle.scorePolicy.version}/public-${this.bundle.id}:boundary-v1:${this.identity.hash(stableStringify([this.boundaryConfig, this.bundle.semantic?.retrieval, adaptiveGapStrategy.version])).slice(0, 16)}`; }
  private neighborhood(id: string) {
    if (this.queryRevision !== this.kernel.indexRevision) { this.queryCache.clear(); this.queryRevision = this.kernel.indexRevision; }
    const cached = this.queryCache.get(id); if (cached) return cached;
    const candidates = new Map<string, SemanticCandidate>();
    for (const signal of this.bundle.semantic?.signals ?? []) {
      if (![signal.from, signal.to].includes(id) || !this.semanticValid(signal)) continue;
      const key = relationKey(signal.from, signal.to), { strength: _strength, ...metadata } = signal.semantic!;
      const candidate: SemanticCandidate = { id: key, nodes: [signal.from, signal.to].sort() as [string, string], similarity: signal.rawValue, metadata: structuredClone(metadata), evidence: structuredClone(signal.evidence) };
      if (!candidates.has(key) || candidates.get(key)!.similarity < candidate.similarity) candidates.set(key, candidate);
    }
    const retrieval = this.bundle.semantic?.retrieval ?? DEFAULT_EMBEDDING_CONFIG.retrieval;
    const pool: SemanticCandidatePool = { focusNode: id, model: this.bundle.semantic?.descriptor.model ?? '', retrievalVersion: retrieval.version,
      candidateBudget: retrieval.candidateBudget, totalCandidates: candidates.size, candidates: [...candidates.values()].sort(compareSemanticCandidates).slice(0, retrieval.candidateBudget) };
    const boundary = applyRelationBoundary(pool, this.boundaryConfig);
    const accepted = new Set(boundary.decisions.filter(d => d.accepted).map(d => d.id));
    const pairs = new Map(this.kernel.getRelations(id).map(r => [r.id, { id: r.id, nodes: r.nodes, signals: r.signals }]));
    for (const candidate of pool.candidates) if (accepted.has(candidate.id)) {
      const pair = pairs.get(candidate.id) ?? { id: candidate.id, nodes: candidate.nodes, signals: [] };
      pair.signals.push(acceptedSemanticSignal(candidate, retrieval.mappings)); pairs.set(candidate.id, pair);
    }
    const relations = [...pairs.values()].map(c => scoreCandidate(c, { ...this.bundle.scorePolicy, version: this.scoreVersion }, { schemaVersion: 1, aliases: [], relations: {} })).sort(compareRelations);
    const result = { relations, pool, boundary }; this.queryCache.set(id, result); return result;
  }
  getRelations(id: string): Relation[] { return structuredClone(this.neighborhood(id).relations); }
  createExplorationSnapshot(id: string, options: { lensValue?: number; visibleBudget?: number } = {}): Snapshot {
    const base = this.kernel.createExplorationSnapshot(id, options), neighborhood = this.neighborhood(id);
    base.candidateSet = structuredClone(neighborhood.relations);
    base.semanticCandidatePool = structuredClone(neighborhood.pool); base.relationBoundary = structuredClone(neighborhood.boundary);
    const accepted = new Set(neighborhood.boundary.decisions.filter(d => d.accepted).map(d => d.id));
    base.validSemanticNeighborhood = neighborhood.pool.candidates.filter(c => accepted.has(c.id)).map(c => c.nodes.find(node => node !== id)!);
    const nodes = new Set(base.candidateSet.flatMap(r => r.nodes).filter(node => node !== id));
    const cross = new Map<string, Relation>();
    for (const node of nodes) for (const relation of this.neighborhood(node).relations) {
      if (!relation.nodes.every(n => nodes.has(n))) continue;
      const other = relation.nodes.find(n => n !== node)!;
      if (this.neighborhood(other).relations.some(r => r.id === relation.id)) cross.set(relation.id, relation);
    }
    base.neighborhoodRelations = structuredClone([...cross.values()].sort(compareRelations));
    base.relationScoreVersion = this.scoreVersion;
    base.candidateBudget.semantic = neighborhood.pool.candidateBudget;
    base.candidateVersion = this.identity.hash(stableStringify([base.indexRevision, this.scoreVersion, base.candidateSet, base.relationBoundary, base.neighborhoodRelations]));
    base.lensMapping = localLensMapping(base.candidateSet); base.visibleBudget = options.visibleBudget ?? Math.max(1, base.candidateSet.length);
    if (this.bundle.semantic) base.embeddingSpaceId = this.bundle.semantic.spaceId;
    const state = this.kernel.exportState();
    for (const docId of new Set([id, ...base.candidateSet.flatMap(r => r.nodes)])) { base.candidateRevisions[docId] = this.kernel.getNode(docId)!.revision; base.validityEpochs[docId] = state.validityEpochs[docId]!; }
    validateSnapshot(base); return base;
  }
  setLens(snapshot: Snapshot, value: number) { return this.kernel.setLens(snapshot, value); }
  setVisibleBudget(snapshot: Snapshot, value: number) { return this.kernel.setVisibleBudget(snapshot, value); }
  getVisibleRelations(snapshot: Snapshot) {
    const state = this.kernel.exportState();
    const deterministic = new Set<string>();
    for (const [kind, references] of [['mention', this.kernel.findMentions()], ['explicit', this.kernel.findWikiLinks()]] as const) for (const reference of references) {
      if (reference.resolution.status !== 'resolved') continue;
      const e = reference.evidence;
      deterministic.add(JSON.stringify([kind, reference.sourceDocumentId, reference.resolution.candidates[0]!.documentId, e.revision, e.start, e.end]));
    }
    return visibleSnapshot(snapshot, { indexRevision: state.indexRevision, relationScoreVersion: this.scoreVersion, userPolicyRevision: 0,
      ...(this.bundle.semantic ? { embeddingSpaceId: this.bundle.semantic.spaceId } : {}), revision: id => this.kernel.getNode(id)?.revision,
      validityEpoch: id => state.validityEpochs[id], override: () => ({}),
      signalValid: signal => signal.kind === 'semantic' ? this.semanticValid(signal) : signal.evidence.every(e => deterministic.has(JSON.stringify([signal.kind, signal.from, signal.to, e.revision, e.start, e.end]))),
    });
  }
}
