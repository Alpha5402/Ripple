import { EntityIndex, normalizePath } from './entity.js';
import { extractReferences } from './mention.js';
import { compareRelations, DEFAULT_SCORE_POLICY, generateCandidates, relationKey, scoreCandidate, validateScorePolicy } from './relation.js';
import { DEFAULT_LENS_MAPPING, thresholdFor, validateBudget, validateLens, validateSnapshot } from './exploration.js';
import { validateDeclarations } from './declarations.js';
import type { IdentityProvider, KnowledgeStorage, MarkdownParser } from './ports.js';
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
  private relations: Relation[] = [];
  private documentsById = new Map<string, Document>();
  private validReferences = new Set<string>();
  private policy: ScorePolicy;
  constructor(private readonly dependencies: { storage: KnowledgeStorage; parser: MarkdownParser; identity: IdentityProvider }, policy: ScorePolicy = DEFAULT_SCORE_POLICY) {
    validateScorePolicy(policy); this.policy = structuredClone(policy);
    this.state = dependencies.storage.load(); validateDeclarations(this.state.declarations); this.rebuild();
  }
  get indexRevision(): number { return this.state.indexRevision; }
  get scorePolicy(): ScorePolicy { return structuredClone(this.policy); }
  get capabilities(): { semantic: 'not-configured'; storage: 'adapter'; deterministicRelations: true } {
    return { semantic: 'not-configured', storage: 'adapter', deterministicRelations: true };
  }
  private rebuild(): void {
    this.documentsById = new Map(this.state.documents.map(doc => [doc.id, doc]));
    this.entities = new EntityIndex(this.state.documents, this.state.declarations.aliases);
    this.mentions = []; this.wikiLinks = [];
    for (const doc of this.state.documents) {
      const refs = extractReferences(doc, this.entities);
      this.mentions.push(...refs.mentions); this.wikiLinks.push(...refs.wikiLinks);
    }
    this.relations = generateCandidates(this.mentions, this.wikiLinks)
      .map(candidate => scoreCandidate(candidate, this.policy, this.state.declarations)).sort(compareRelations);
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
      this.dependencies.storage.save(next);
    } catch (error) { this.state = previous; this.rebuild(); throw error; }
  }
  ingestDocument(input: DocumentInput): Document { return this.ingestDocuments([input])[0]!; }
  /** Batch updates are atomic, and unchanged source documents reuse their parsed AST projection. */
  ingestDocuments(inputs: DocumentInput[]): Document[] {
    const next = structuredClone(this.state);
    const ids: string[] = [];
    let changed = false;
    for (const input of inputs) {
      const path = normalizePath(input.path);
      const pathOwner = next.documents.find(doc => doc.path === path);
      const id = input.id ?? pathOwner?.id ?? this.dependencies.identity.newId();
      if (!id.trim() || Object.hasOwn(Object.prototype, id)) throw new KernelError('INVALID_INPUT', 'Document ID cannot be empty or a reserved Object key');
      if (pathOwner && pathOwner.id !== id) throw new KernelError('CONFLICT', `Path already belongs to ${pathOwner.id}`);
      const old = next.documents.find(doc => doc.id === id);
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
      next.documents = next.documents.filter(existing => existing.id !== id);
      next.documents.push(doc); next.revisions[id] = revision;
      next.validityEpochs[id] = (next.validityEpochs[id] ?? 0) + 1;
      ids.push(id); changed = true;
    }
    if (changed) { next.indexRevision++; this.commit(next); }
    return ids.map(id => this.getNode(id)!);
  }
  reindexChanged(inputs: DocumentInput[]): { changedCount: number; indexRevision: number } {
    const before = { ...this.state.revisions };
    const docs = this.ingestDocuments(inputs);
    return { changedCount: new Set(docs.filter(d => before[d.id] !== d.revision).map(d => d.id)).size, indexRevision: this.indexRevision };
  }
  removeDocument(id: string): boolean {
    if (!this.state.documents.some(doc => doc.id === id)) return false;
    const next = structuredClone(this.state);
    next.documents = next.documents.filter(doc => doc.id !== id);
    next.validityEpochs[id] = (next.validityEpochs[id] ?? 0) + 1;
    next.indexRevision++; this.commit(next); return true;
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
  getRelations(nodeId: string, options: { includeHidden?: boolean } = {}): Relation[] {
    this.requireNode(nodeId);
    return structuredClone(this.relations.filter(r => r.nodes.includes(nodeId) && (options.includeHidden || !r.override.hidden)));
  }
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
    const candidateSet = this.getRelations(focusNode, { includeHidden: true });
    const ranked = candidateSet.filter(r => !r.override.hidden);
    // Default targets roughly 3–6 eligible neighbors; ties and weak-only centers can differ.
    const threshold = Math.max(0.5, ranked[2]?.score ?? ranked.at(-1)?.score ?? 0.5);
    const lensValue = options.lensValue ?? (1 - threshold) * 100;
    const visibleBudget = options.visibleBudget ?? 40;
    validateLens(lensValue); validateBudget(visibleBudget);
    const ids = new Set([focusNode, ...candidateSet.flatMap(r => r.nodes)]);
    return {
      schemaVersion: 1, id: this.dependencies.identity.newId(), focusNode, focusRevision: focus.revision,
      candidateSet, candidateRevisions: Object.fromEntries([...ids].map(id => [id, this.requireNode(id).revision])),
      candidateVersion: this.dependencies.identity.hash(JSON.stringify([this.indexRevision, this.policy.version, candidateSet])),
      candidateBudget: { deterministic: 'all', semantic: 0 }, relationScoreVersion: this.policy.version,
      indexRevision: this.indexRevision, lensValue, lensMapping: { ...DEFAULT_LENS_MAPPING }, visibleBudget,
      userOverrides: structuredClone(this.state.declarations.relations),
      validityEpochs: { ...this.state.validityEpochs }, userPolicyRevision: this.state.userPolicyRevision,
    };
  }
  setLens(snapshot: Snapshot, lensValue: number): Snapshot {
    validateSnapshot(snapshot); validateLens(lensValue); return { ...structuredClone(snapshot), lensValue };
  }
  setVisibleBudget(snapshot: Snapshot, visibleBudget: number): Snapshot {
    validateSnapshot(snapshot); validateBudget(visibleBudget); return { ...structuredClone(snapshot), visibleBudget };
  }
  getVisibleRelations(snapshot: Snapshot): VisibleRelations {
    validateSnapshot(snapshot);
    const threshold = thresholdFor(snapshot.lensValue, snapshot.lensMapping);
    const focus = this.documentsById.get(snapshot.focusNode);
    const reasons: string[] = [];
    if (!focus || focus.revision !== snapshot.focusRevision) {
      return { status: 'invalid', reasons: [focus ? 'focus-revision-changed' : 'focus-removed'], threshold, relations: [], eligibleCount: 0, remainingCount: 0, pinnedCount: 0, invalidatedCount: snapshot.candidateSet.length };
    }
    if (snapshot.indexRevision !== this.indexRevision) reasons.push('index-revision-changed');
    if (snapshot.relationScoreVersion !== this.policy.version) reasons.push('score-policy-changed');
    if (snapshot.userPolicyRevision !== this.state.userPolicyRevision) reasons.push('user-declarations-changed');
    let invalidatedCount = 0;
    const eligible = snapshot.candidateSet.filter(relation => {
      if (relation.nodes.some(id => !this.documentsById.has(id)
        || snapshot.validityEpochs[id] !== this.state.validityEpochs[id])
        || relation.signals.some(signal => signal.evidence.some(evidence => !this.validReferences.has(JSON.stringify([signal.kind, signal.from, signal.to, evidence.revision, evidence.start, evidence.end]))))) {
        invalidatedCount++; return false;
      }
      return true;
    }).map(relation => ({ ...relation, override: { ...this.state.declarations.relations[relation.id] } }))
      .filter(r => !r.override.hidden && (r.score >= threshold || r.override.pinned));
    const pinned = eligible.filter(r => r.override.pinned).sort(compareRelations);
    const regular = eligible.filter(r => !r.override.pinned).sort(compareRelations);
    // Pins are explicit view exceptions outside the regular page budget.
    const visible = [...pinned, ...regular.slice(0, snapshot.visibleBudget)].sort(compareRelations);
    if (invalidatedCount) reasons.push('candidate-evidence-invalidated');
    return { status: reasons.length ? 'stale' : 'current', reasons, threshold, relations: structuredClone(visible),
      eligibleCount: eligible.length, remainingCount: regular.length - Math.min(regular.length, snapshot.visibleBudget),
      pinnedCount: pinned.length, invalidatedCount };
  }
  private requireNode(id: string): Document {
    const doc = this.documentsById.get(id);
    if (!doc) throw new KernelError('NOT_FOUND', `Unknown document: ${id}`);
    return doc;
  }
}
