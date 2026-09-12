import { retrieveSemanticCandidates, acceptedSemanticSignal, type SemanticCandidatePool } from './relation/semantic-candidate.js';
import { applyRelationBoundary, defaultBoundaryConfig, adaptiveGapStrategy, type RelationBoundary, type RelationBoundaryStrategy } from './relation/relation-boundary.js';
import { visibleSnapshot } from './visibility.js';
import { EntityIndex, normalizePath } from './entity.js';
import { extractReferences, NameMatcher } from './mention.js';
import { compareRelations, DEFAULT_SCORE_POLICY, generateCandidates, relationKey, scoreCandidate, validateScorePolicy } from './relation.js';
import { DEFAULT_LENS_MAPPING, localLensMapping, thresholdFor, validateBudget, validateLens, validateSnapshot } from './exploration.js';
import { validateDeclarations } from './declarations.js';
import { EmbeddingEngine } from './embedding/engine.js';
import { DEFAULT_EMBEDDING_CONFIG, stableStringify } from './embedding/config.js';
import { activeSpace, semanticPairState, semanticSignalValid, validRecords } from './embedding/relations.js';
import { EmbeddingError, type EmbeddingCache, type EmbeddingConfig, type EmbeddingCoverage, type EmbeddingProvider, type EmbeddingRunReport, type KnowledgeUnit, type MediaResolver } from './embedding/model.js';
import type { IdentityProvider, KnowledgeSearch, KnowledgeStorage, MarkdownParser, SearchOptions, SearchHit } from './ports.js';
import {
  KernelError, type Document, type DocumentInput, type EvidenceLocator, type KernelState, type Mention,
  type Relation, type RelationOverride, type Resolution, type ScorePolicy, type Snapshot, type UserDeclarations,
  type VisibleRelations, type WikiLink,
} from './model.js';

export class KnowledgeService {
  private state: KernelState;
  private entities!: EntityIndex;
  private mentions: Mention[] = [];
  private wikiLinks: WikiLink[] = [];
  private relationsByNode = new Map<string, Relation[]>();
  private relationQueryCache = new Map<string, { relations: Relation[]; pool: SemanticCandidatePool; boundary: RelationBoundary }>();
  private referenceCache = new Map<string, { revision: number; refs: ReturnType<typeof extractReferences> }>();
  private entitySignature = '';
  private matcher!: NameMatcher;
  private semanticUnitHashes = new Map<string, string>();
  private documentsById = new Map<string, Document>();
  private validReferences = new Set<string>();
  private policy: ScorePolicy;
  private embeddingEngine: EmbeddingEngine | undefined;
  private embeddingGeneration = 0;
  constructor(private readonly dependencies: { storage: KnowledgeStorage; parser: MarkdownParser; identity: IdentityProvider; search?: KnowledgeSearch; relationBoundaryStrategy?: RelationBoundaryStrategy; semanticRetriever?: typeof retrieveSemanticCandidates }, policy?: ScorePolicy) {
    this.state = dependencies.storage.load();
    this.policy = structuredClone(policy ?? this.state.scorePolicy ?? DEFAULT_SCORE_POLICY);
    validateScorePolicy(this.policy);
    // Persisted vectors are reusable caches; selecting an active provider/mode remains an explicit action.
    if (this.state.embedding) delete this.state.embedding.activeSpaceId;
    validateDeclarations(this.state.declarations); this.rebuild();
  }
  get indexRevision(): number { return this.state.indexRevision; }
  get scorePolicy(): ScorePolicy { return structuredClone(this.policy); }
  get capabilities() {
    return { protocolVersion: 1 as const, deterministicRelations: true as const,
      semantic: this.getEmbeddingCoverage().status,
      storage: this.dependencies.storage.storageCapabilities ?? { kind: 'custom', persistent: false, concurrency: 'single-instance' as const },
      search: this.dependencies.search?.searchCapabilities ?? { engine: 'unavailable', modes: [] },
    };
  }
  getIndexCoverage() {
    return { indexRevision: this.indexRevision,
      deterministic: { status: 'ready' as const, documents: this.state.documents.length, mentions: this.mentions.length, wikiLinks: this.wikiLinks.length },
      semantic: this.getEmbeddingCoverage(),
      search: { status: this.dependencies.search ? 'ready' as const : 'not-configured' as const, ...this.capabilities.search } };
  }
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    if (!this.dependencies.search) throw new KernelError('SEARCH_UNAVAILABLE', 'Configure a KnowledgeSearch adapter');
    const hits = this.dependencies.search.search(query, options);
    if (hits.some(h => this.documentsById.get(h.documentId)?.revision !== h.revision)) throw new KernelError('STALE_INDEX', 'Search storage changed; reopen the kernel');
    return structuredClone(hits);
  }
  exportState(): KernelState { return structuredClone({ ...this.state, scorePolicy: this.policy }); }
  private get effectiveScoreVersion(): string {
    const space = activeSpace(this.state.embedding);
    return space ? `${this.policy.version}+${space.config.retrieval.version}:${this.dependencies.identity.hash(stableStringify([space.config.retrieval, this.boundaryConfig, this.boundaryStrategy.id, this.boundaryStrategy.version])).slice(0, 16)}` : `${this.policy.version}+boundary-v1`;
  }
  private rebuild(): void {
    this.documentsById = new Map(this.state.documents.map(doc => [doc.id, doc]));
    const signature = stableStringify([this.state.documents.map(d => [d.id, d.path, d.parsed.names, d.parsed.sections.map(s => [s.id, s.title, s.depth])]), this.state.declarations.aliases]);
    if (signature !== this.entitySignature) {
      this.entities = new EntityIndex(this.state.documents, this.state.declarations.aliases);
      this.matcher = new NameMatcher(this.entities); this.referenceCache.clear(); this.entitySignature = signature;
    }
    for (const id of this.referenceCache.keys()) if (!this.documentsById.has(id)) this.referenceCache.delete(id);
    this.mentions = []; this.wikiLinks = [];
    for (const doc of this.state.documents) {
      const cached = this.referenceCache.get(doc.id);
      const refs = cached?.revision === doc.revision ? cached.refs : extractReferences(doc, this.entities, this.matcher);
      this.referenceCache.set(doc.id, { revision: doc.revision, refs });
      this.mentions.push(...refs.mentions); this.wikiLinks.push(...refs.wikiLinks);
    }
    const candidates = new Map(generateCandidates(this.mentions, this.wikiLinks).map(candidate => [candidate.id, candidate]));
    this.relationsByNode.clear(); this.relationQueryCache.clear();
    const space = activeSpace(this.state.embedding);
    this.semanticUnitHashes = new Map(space ? validRecords(space, this.state.documents).map(r => [r.unit.id, r.unit.contentHash]) : []);
    const policy = { ...this.policy, version: this.effectiveScoreVersion };
    for (const candidate of candidates.values()) {
      const relation = scoreCandidate(candidate, policy,
        this.state.declarations, semanticPairState(this.state.embedding, candidate.nodes, this.documentsById));
      for (const id of candidate.nodes) {
        const list = this.relationsByNode.get(id) ?? []; list.push(relation); this.relationsByNode.set(id, list);
      }
    }
    this.validReferences = new Set([
      ...this.mentions.filter(m => m.resolution.status === 'resolved').map(m => JSON.stringify(['mention', m.sourceDocumentId, m.resolution.candidates[0]!.documentId, m.evidence.revision, m.evidence.start, m.evidence.end])),
      ...this.wikiLinks.filter(l => l.resolution.status === 'resolved').map(l => JSON.stringify(['explicit', l.sourceDocumentId, l.resolution.candidates[0]!.documentId, l.evidence.revision, l.evidence.start, l.evidence.end])),
    ]);
  }
  private commit(next: KernelState): void {
    const previous = this.state;
    this.state = next;
    try {
      this.rebuild();
      next.scorePolicy = structuredClone(this.policy);
      this.dependencies.storage.save(next, next.embedding?.spaces === previous.embedding?.spaces ? { embeddingSpacesUnchanged: true } : {});
      this.embeddingEngine?.invalidateChangedDocuments();
    } catch (error) { this.state = previous; this.rebuild(); throw error; }
  }
  ingestDocument(input: DocumentInput): Document { return this.ingestDocuments([input])[0]!; }
  /** Batch updates are atomic, and unchanged source documents reuse their parsed AST projection. */
  ingestDocuments(inputs: DocumentInput[]): Document[] {
    const next = { ...this.state, revisions: { ...this.state.revisions }, validityEpochs: { ...this.state.validityEpochs } };
    const docs = new Map(this.state.documents.map(doc => [doc.id, doc]));
    const paths = new Map(this.state.documents.map(doc => [doc.path, doc]));
    const ids: string[] = [];
    let changed = false;
    for (const input of inputs) {
      const path = normalizePath(input.path);
      const pathOwner = paths.get(path);
      const id = input.id ?? pathOwner?.id ?? this.dependencies.identity.newId();
      if (!id.trim() || Object.hasOwn(Object.prototype, id)) throw new KernelError('INVALID_INPUT', 'Document ID cannot be empty or a reserved Object key');
      if (pathOwner && pathOwner.id !== id) throw new KernelError('CONFLICT', `Path already belongs to ${pathOwner.id}`);
      const old = docs.get(id);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (next.revisions[id] ?? 0)) {
        throw new KernelError('CONFLICT', `Revision conflict for ${id}`);
      }
      const contentHash = this.dependencies.identity.hash(input.markdown);
      if (old && old.contentHash === contentHash && old.path === path && old.parsed.parserVersion === this.dependencies.parser.version) { ids.push(id); continue; }
      const revision = (next.revisions[id] ?? 0) + 1;
      const doc: Document = {
        id, path, markdown: input.markdown, revision, contentHash,
        parsed: this.dependencies.parser.parse(id, path, input.markdown),
      };
      if (old) paths.delete(old.path);
      docs.set(id, doc); paths.set(path, doc); next.revisions[id] = revision;
      next.validityEpochs[id] = (next.validityEpochs[id] ?? 0) + 1;
      ids.push(id); changed = true;
    }
    if (changed) { next.documents = [...docs.values()]; next.indexRevision++; this.commit(next); }
    return ids.map(id => this.getNode(id)!);
  }
  reindexChanged(inputs: DocumentInput[]): { changedCount: number; indexRevision: number } {
    const before = { ...this.state.revisions };
    const docs = this.ingestDocuments(inputs);
    return { changedCount: new Set(docs.filter(d => before[d.id] !== d.revision).map(d => d.id)).size, indexRevision: this.indexRevision };
  }
  removeDocument(id: string): boolean { return this.removeDocuments([id]) > 0; }
  removeDocuments(ids: string[]): number {
    const removing = new Set(ids.filter(id => this.documentsById.has(id)));
    if (!removing.size) return 0;
    const next = { ...this.state, documents: this.state.documents.filter(doc => !removing.has(doc.id)), validityEpochs: { ...this.state.validityEpochs } };
    for (const id of removing) next.validityEpochs[id] = (next.validityEpochs[id] ?? 0) + 1;
    if (next.embedding) {
      next.embedding = structuredClone(next.embedding);
      for (const space of Object.values(next.embedding.spaces)) {
        space.records = space.records.filter(record => !removing.has(record.unit.documentId));
        for (const id of removing) delete space.documents[id];
      }
    }
    next.indexRevision++; this.commit(next); return removing.size;
  }
  getNode(id: string): Document | undefined { return structuredClone(this.documentsById.get(id)); }
  listDocuments(): Document[] { return structuredClone(this.state.documents); }
  resolveEntity(name: string, sourceDocumentId?: string): Resolution { return structuredClone(this.entities.resolveLink(name, sourceDocumentId)); }
  findMentions(query: { sourceDocumentId?: string; targetDocumentId?: string } = {}): Mention[] {
    return structuredClone(this.mentions.filter(m => (!query.sourceDocumentId || m.sourceDocumentId === query.sourceDocumentId)
      && (!query.targetDocumentId || (m.resolution.status === 'resolved' && m.resolution.candidates.some(t => t.documentId === query.targetDocumentId)))));
  }
  findWikiLinks(query: { sourceDocumentId?: string; targetDocumentId?: string } = {}): WikiLink[] {
    return structuredClone(this.wikiLinks.filter(l => (!query.sourceDocumentId || l.sourceDocumentId === query.sourceDocumentId)
      && (!query.targetDocumentId || (l.resolution.status === 'resolved' && l.resolution.candidates.some(t => t.documentId === query.targetDocumentId)))));
  }
  private get boundaryStrategy(): RelationBoundaryStrategy { return this.dependencies.relationBoundaryStrategy ?? adaptiveGapStrategy; }
  private get boundaryConfig() { const space = activeSpace(this.state.embedding); return space?.config.retrieval.boundary ?? { ...defaultBoundaryConfig(space?.space.descriptor.model ?? ''), strategy: this.boundaryStrategy.id }; }
  private neighborhood(nodeId: string) {
    this.requireNode(nodeId);
    let result = this.relationQueryCache.get(nodeId);
    if (!result) {
      const pool = (this.dependencies.semanticRetriever ?? retrieveSemanticCandidates)(this.state.embedding, this.state.documents, nodeId);
      const boundary = applyRelationBoundary(pool, this.boundaryConfig, this.boundaryStrategy);
      const accepted = new Set(boundary.decisions.filter(d => d.accepted).map(d => d.id));
      const candidates = new Map((this.relationsByNode.get(nodeId) ?? []).map(r => [r.id, { id: r.id, nodes: r.nodes, signals: [...r.signals] }]));
      for (const candidate of pool.candidates) {
        if (!accepted.has(candidate.id)) continue;
        const existing = candidates.get(candidate.id);
        const signal = acceptedSemanticSignal(candidate, activeSpace(this.state.embedding)!.config.retrieval.mappings);
        if (existing) existing.signals.push(signal); else candidates.set(candidate.id, { id: candidate.id, nodes: candidate.nodes, signals: [signal] });
      }
      const policy = { ...this.policy, version: this.effectiveScoreVersion };
      const relations = [...candidates.values()].map(c => scoreCandidate(c, policy, this.state.declarations, semanticPairState(this.state.embedding, c.nodes, this.documentsById))).sort(compareRelations);
      result = { relations, pool, boundary };
      if (this.relationQueryCache.size >= 128) this.relationQueryCache.delete(this.relationQueryCache.keys().next().value!);
      this.relationQueryCache.set(nodeId, result);
    }
    return result;
  }
  getRelations(nodeId: string, options: { includeHidden?: boolean } = {}): Relation[] {
    return structuredClone(this.neighborhood(nodeId).relations.filter(r => options.includeHidden || !r.override.hidden));
  }
  getSemanticNeighborhood(nodeId: string): { pool: SemanticCandidatePool; boundary: RelationBoundary } {
    const { pool, boundary } = this.neighborhood(nodeId); return structuredClone({ pool, boundary });
  }
  configureEmbedding(provider: EmbeddingProvider, config: EmbeddingConfig = structuredClone(DEFAULT_EMBEDDING_CONFIG), resolver?: MediaResolver): void {
    const generation = this.embeddingGeneration + 1;
    const engine = new EmbeddingEngine(provider, structuredClone(config), this.dependencies.identity, () => this.state.documents,
      cache => { if (this.embeddingGeneration === generation) this.commit({ ...this.state, embedding: cache, indexRevision: this.indexRevision + 1 }); }, this.state.embedding, resolver);
    const previousEngine = this.embeddingEngine, previousGeneration = this.embeddingGeneration;
    this.embeddingGeneration = generation; this.embeddingEngine = engine;
    try { engine.activate(); previousEngine?.stop(); }
    catch (error) { engine.stop(); this.embeddingEngine = previousEngine; this.embeddingGeneration = previousGeneration; throw error; }
  }
  disableEmbedding(): void {
    if (this.state.embedding) {
      const embedding = structuredClone(this.state.embedding); delete embedding.activeSpaceId;
      this.commit({ ...this.state, embedding, indexRevision: this.indexRevision + 1 });
    }
    this.embeddingEngine?.stop(); this.embeddingEngine = undefined; this.embeddingGeneration++;
  }
  cancelEmbeddings(): void { this.embeddingEngine?.cancel(); }
  async indexEmbeddings(options: { documentIds?: string[]; signal?: AbortSignal } = {}): Promise<EmbeddingRunReport> {
    if (!this.embeddingEngine) throw new EmbeddingError('NOT_CONFIGURED', 'Configure an EmbeddingProvider before indexing');
    return this.embeddingEngine.index(options);
  }
  getEmbeddingCoverage(): EmbeddingCoverage {
    return this.embeddingEngine?.coverage() ?? { status: 'not-configured', documents: {}, readyUnits: 0, totalUnits: 0 };
  }
  getKnowledgeUnits(documentId?: string): KnowledgeUnit[] {
    return structuredClone((activeSpace(this.state.embedding)?.records ?? []).filter(record => (!documentId || record.unit.documentId === documentId)
      && this.documentsById.get(record.unit.documentId)?.revision === record.unit.revision).map(record => record.unit));
  }
  exportEmbeddingCache(): EmbeddingCache | undefined { return structuredClone(this.state.embedding); }
  getEvidence(locator: EvidenceLocator): { status: 'valid' | 'stale' | 'missing'; locator: EvidenceLocator; text?: string; excerpt?: string; path?: string } {
    const doc = this.documentsById.get(locator.documentId);
    if (!doc) return { status: 'missing', locator: structuredClone(locator) };
    if (doc.revision !== locator.revision) return { status: 'stale', locator: structuredClone(locator) };
    if (!Number.isInteger(locator.start) || !Number.isInteger(locator.end) || locator.start < 0 || locator.end <= locator.start
      || locator.end > doc.markdown.length || !doc.parsed.sections.some(s => s.id === locator.sectionId && s.start <= locator.start && s.end >= locator.end)) {
      throw new KernelError('INVALID_INPUT', 'Invalid evidence range or section');
    }
    return { status: 'valid', locator: structuredClone(locator), path: doc.path,
      text: doc.markdown.slice(locator.start, locator.end),
      excerpt: doc.markdown.slice(Math.max(0, locator.start - 80), Math.min(doc.markdown.length, locator.end + 80)) };
  }
  exportUserDeclarations(): UserDeclarations { return structuredClone(this.state.declarations); }
  importUserDeclarations(declarations: UserDeclarations): void {
    validateDeclarations(declarations);
    const next = structuredClone(this.state);
    next.declarations = structuredClone(declarations); next.userPolicyRevision++; next.indexRevision++;
    this.commit(next);
  }
  setRelationOverride(a: string, b: string, override: RelationOverride): void {
    this.requireNode(a); this.requireNode(b);
    const declarations = this.exportUserDeclarations();
    declarations.relations[relationKey(a, b)] = { ...declarations.relations[relationKey(a, b)], ...override };
    this.importUserDeclarations(declarations);
  }
  setScorePolicy(policy: ScorePolicy): void {
    validateScorePolicy(policy);
    if (JSON.stringify(policy) === JSON.stringify(this.policy)) return;
    if (policy.version === this.policy.version) throw new KernelError('CONFLICT', 'Changed scoring rules require a new version');
    const previousPolicy = this.policy;
    this.policy = structuredClone(policy);
    const next = structuredClone(this.state); next.indexRevision++;
    try { this.commit(next); } catch (error) { this.policy = previousPolicy; this.rebuild(); throw error; }
  }
  createExplorationSnapshot(focusNode: string, options: { lensValue?: number; visibleBudget?: number } = {}): Snapshot {
    const focus = this.requireNode(focusNode);
    const neighborhood = this.neighborhood(focusNode);
    const candidateSet = structuredClone(neighborhood.relations);
    const lensValue = options.lensValue ?? 50;
    const visibleBudget = options.visibleBudget ?? Math.max(1, candidateSet.length);
    const neighborIds = [...new Set(candidateSet.filter(r => !r.override.hidden).flatMap(r => r.nodes).filter(id => id !== focusNode))];
    const neighborSet = new Set(neighborIds), cross = new Map<string, Relation>();
    // Only already-gated relations, confirmed at both endpoints; no pair synthesis for visual density.
    for (const id of neighborIds) for (const relation of this.neighborhood(id).relations) {
      if (relation.override.hidden || relation.nodes.includes(focusNode) || !relation.nodes.every(node => neighborSet.has(node))) continue;
      const other = relation.nodes.find(node => node !== id)!;
      const reciprocal = this.neighborhood(other).relations.find(r => r.id === relation.id && !r.override.hidden);
      if (reciprocal) cross.set(relation.id, { ...structuredClone(relation), score: Math.min(relation.score, reciprocal.score) });
    }
    const neighborhoodRelations = [...cross.values()].sort(compareRelations);
    validateLens(lensValue); validateBudget(visibleBudget);
    const ids = new Set([focusNode, ...candidateSet.flatMap(r => r.nodes)]);
    return {
      schemaVersion: 2, id: this.dependencies.identity.newId(), focusNode, focusRevision: focus.revision,
      candidateSet, semanticCandidatePool: structuredClone(neighborhood.pool), relationBoundary: structuredClone(neighborhood.boundary),
      validSemanticNeighborhood: neighborhood.pool.candidates.filter(c => neighborhood.boundary.decisions.some(d => d.id === c.id && d.accepted)).map(c => c.nodes.find(id => id !== focusNode)!),
      neighborhoodRelations, candidateRevisions: Object.fromEntries([...ids].map(id => [id, this.requireNode(id).revision])),
      candidateVersion: this.dependencies.identity.hash(JSON.stringify([this.indexRevision, this.effectiveScoreVersion, candidateSet, neighborhood.boundary, neighborhoodRelations])),
      candidateBudget: { deterministic: 'all', semantic: activeSpace(this.state.embedding)?.config.retrieval.candidateBudget ?? 0 }, relationScoreVersion: this.effectiveScoreVersion,
      ...(activeSpace(this.state.embedding) ? { embeddingSpaceId: activeSpace(this.state.embedding)!.space.id } : {}),
      indexRevision: this.indexRevision, lensValue, lensMapping: localLensMapping(candidateSet), visibleBudget,
      userOverrides: structuredClone(this.state.declarations.relations),
      validityEpochs: Object.fromEntries([...ids].map(id => [id, this.state.validityEpochs[id]!])), userPolicyRevision: this.state.userPolicyRevision,
    };
  }
  setLens(snapshot: Snapshot, lensValue: number): Snapshot {
    validateSnapshot(snapshot); validateLens(lensValue); return { ...structuredClone(snapshot), lensValue };
  }
  setVisibleBudget(snapshot: Snapshot, visibleBudget: number): Snapshot {
    validateSnapshot(snapshot); validateBudget(visibleBudget); return { ...structuredClone(snapshot), visibleBudget };
  }
  getVisibleRelations(snapshot: Snapshot): VisibleRelations {
    return visibleSnapshot(snapshot, {
      indexRevision: this.indexRevision, relationScoreVersion: this.effectiveScoreVersion,
      ...(activeSpace(this.state.embedding) ? { embeddingSpaceId: activeSpace(this.state.embedding)!.space.id } : {}),
      userPolicyRevision: this.state.userPolicyRevision,
      revision: id => this.documentsById.get(id)?.revision,
      validityEpoch: id => this.state.validityEpochs[id],
      override: id => ({ ...this.state.declarations.relations[id] }),
      signalValid: signal => signal.kind === 'semantic' ? semanticSignalValid(signal, this.state.embedding, this.state.documents, this.semanticUnitHashes)
        : signal.evidence.every(e => this.validReferences.has(JSON.stringify([signal.kind, signal.from, signal.to, e.revision, e.start, e.end]))),
    });
  }

  private requireNode(id: string): Document {
    const doc = this.documentsById.get(id);
    if (!doc) throw new KernelError('NOT_FOUND', `Unknown document: ${id}`);
    return doc;
  }
}
