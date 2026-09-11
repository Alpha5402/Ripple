export type DocumentId = string;
export type IndexRevision = number;
export type ResolutionStatus = 'resolved' | 'ambiguous' | 'missing' | 'suppressed';
export interface Target { documentId: DocumentId; sectionId?: string }
export interface Resolution { status: ResolutionStatus; candidates: Target[]; reason?: string }
export interface SourceRange { start: number; end: number }
export interface EvidenceLocator extends SourceRange {
  documentId: DocumentId;
  revision: number;
  sectionId: string;
}
export interface Section extends SourceRange { id: string; title: string; path: string[]; depth: number }
export interface TextSpan extends SourceRange { sectionId: string; blockId: string }
export interface ParsedWikiLink extends SourceRange {
  target: string; label: string; sectionId: string; blockId: string;
}
export interface ParsedDocument {
  title: string;
  names: { name: string; source: 'filename' | 'heading' | 'frontmatter' | 'alias' }[];
  sections: Section[];
  textSpans: TextSpan[];
  wikiLinks: ParsedWikiLink[];
  parserVersion: string;
  warnings: string[];
  contentStart?: number;
  media?: MediaReference[];
}
export interface Document {
  id: DocumentId;
  path: string;
  markdown: string;
  revision: number;
  contentHash: string;
  parsed: ParsedDocument;
}
export interface DocumentInput { id?: DocumentId; path: string; markdown: string; expectedRevision?: number }
export interface EntityDefinition {
  name: string;
  target: Target;
  source: ParsedDocument['names'][number]['source'] | 'user';
  allowShort: boolean;
}
export interface Mention {
  id: string; sourceDocumentId: DocumentId; text: string;
  resolution: Resolution; evidence: EvidenceLocator; blockId: string;
  decorate: boolean;
}
export interface WikiLink {
  id: string; sourceDocumentId: DocumentId; text: string; targetText: string;
  resolution: Resolution; evidence: EvidenceLocator;
}
export interface UserAlias { name: string; target: Target; allowShort?: boolean }
export interface RelationOverride { hidden?: boolean; pinned?: boolean; note?: string }
export interface UserDeclarations {
  schemaVersion: 1;
  aliases: UserAlias[];
  relations: Record<string, RelationOverride>;
}
export interface RelationSignal {
  kind: 'mention' | 'explicit' | 'semantic';
  from: DocumentId; to: DocumentId;
  evidence: EvidenceLocator[];
  rawValue: number;
  semantic?: SemanticMetadata;
}
export interface RelationCandidate { id: string; nodes: [DocumentId, DocumentId]; signals: RelationSignal[] }
export interface Relation extends RelationCandidate {
  score: number;
  scoreVersion: string;
  components: { mention: number; explicit: 0 | 1; semantic: SemanticState };
  override: RelationOverride;
}
export interface ScorePolicy {
  version: string;
  mentionBase: number;
  sectionIncrement: number;
  mentionCap: number;
  explicitBoost: number;
}
export interface LensMapping { kind: 'linear'; minThreshold: number; maxThreshold: number }
export interface Snapshot {
  schemaVersion: 1;
  id: string;
  focusNode: DocumentId;
  focusRevision: number;
  candidateSet: Relation[];
  candidateRevisions: Record<DocumentId, number>;
  candidateVersion: string;
  candidateBudget: { deterministic: 'all'; semantic: number };
  embeddingSpaceId?: string;
  relationScoreVersion: string;
  indexRevision: IndexRevision;
  lensValue: number;
  lensMapping: LensMapping;
  visibleBudget: number;
  userOverrides: Record<string, RelationOverride>;
  validityEpochs: Record<DocumentId, number>;
  userPolicyRevision: number;
}
export interface VisibleRelations {
  status: 'current' | 'stale' | 'invalid';
  reasons: string[];
  threshold: number;
  relations: Relation[];
  eligibleCount: number;
  remainingCount: number;
  pinnedCount: number;
  invalidatedCount: number;
}
export interface ExplorationHistoryState {
  schemaVersion: 1;
  snapshot: Snapshot;
  layout: Record<DocumentId, { x: number; y: number }>;
  camera: { x: number; y: number; zoom: number };
  reading: { documentId: DocumentId; offset: number } | null;
  visited: DocumentId[];
}
export interface KernelState {
  documents: Document[];
  revisions: Record<DocumentId, number>;
  validityEpochs: Record<DocumentId, number>;
  indexRevision: number;
  userPolicyRevision: number;
  declarations: UserDeclarations;
  embedding?: EmbeddingCache;
}
export class KernelError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'INVALID_SNAPSHOT', message: string) {
    super(message); this.name = 'KernelError';
  }
}
import type { EmbeddingCache, MediaReference, SemanticMetadata, SemanticState } from './embedding/model.js';
