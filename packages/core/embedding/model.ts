import type { Document, EvidenceLocator, RelationSignal } from '../model.js';

export type IndexMode = 'text-only' | 'multimodal';
export type Modality = 'text' | 'image';
export type ModalityPair = 'text-text' | 'text-image' | 'image-image';
export interface MediaReference { source: string; alt: string; start: number; end: number; sectionId: string }
export interface EmbeddingImage { dataUrl: string; contentHash: string; mimeType: string }
export interface EmbeddingInput { text: string; images: EmbeddingImage[] }
export interface ModelDescriptor {
  model: string; revision: string; dimensions: number; normalized: boolean;
  modalities: Modality[]; maxInputTokens: number;
  representation: string; tokenizer: string;
}
export interface EmbeddingProvider {
  readonly descriptor: ModelDescriptor;
  countTokens(inputs: EmbeddingInput[], options: { signal: AbortSignal }): Promise<number[]>;
  embed(inputs: EmbeddingInput[], options: { signal: AbortSignal }): Promise<number[][]>;
}
export interface MediaResolver {
  resolve(document: Document, reference: MediaReference, signal: AbortSignal): Promise<EmbeddingImage>;
}
export interface EmbeddingConfig {
  mode: IndexMode;
  chunking: { version: string; maxTokens: number; imageContextChars: number };
  retrieval: {
    version: string; candidateBudget: number; aggregation: 'max' | 'top-mean'; topMatches: number;
    mappings: Record<ModalityPair, { min: number; max: number }>;
    boundary?: import('../relation/relation-boundary.js').RelationBoundaryConfig;
  };
  execution: { batchSize: number; maxRetries: number; retryDelayMs: number };
}
export interface EmbeddingSpace {
  id: string; descriptor: ModelDescriptor; mode: IndexMode;
  chunking: EmbeddingConfig['chunking'];
}
export interface KnowledgeUnit {
  id: string; documentId: string; revision: number; kind: 'text' | 'image-context';
  contentHash: string; text: string; tokenCount: number; evidence: EvidenceLocator;
  media: { source: string; contentHash: string; evidence: EvidenceLocator }[];
}
export interface PreparedUnit { unit: KnowledgeUnit; input: EmbeddingInput }
export interface VectorRecord { unit: KnowledgeUnit; vector: number[] }
export type DocumentEmbeddingStatus = 'ready' | 'partial' | 'error' | 'stale' | 'pending' | 'cancelled' | 'limit-exceeded' | 'unsupported';
export interface EmbeddingDocumentState {
  revision: number; status: DocumentEmbeddingStatus; unitCount: number; readyCount: number;
  errors: { code: string; message: string }[];
}
export interface EmbeddingSpaceCache {
  space: EmbeddingSpace; config: EmbeddingConfig; records: VectorRecord[];
  documents: Record<string, EmbeddingDocumentState>;
}
export interface EmbeddingCache { schemaVersion: 1; activeSpaceId?: string; spaces: Record<string, EmbeddingSpaceCache> }
export type SemanticState = { status: 'not-configured' } | {
  status: 'ready' | 'pending' | 'partial' | 'stale' | 'error' | 'cancelled' | 'limit-exceeded' | 'unsupported' | 'not-recalled';
  spaceId: string; strength?: number; cosine?: number;
};
export interface SemanticContribution {
  unitIds: [string, string]; unitHashes: [string, string]; cosine: number; modalityPair: ModalityPair;
  evidence: [EvidenceLocator, EvidenceLocator];
  media: KnowledgeUnit['media'];
}
export interface SemanticMetadata {
  spaceId: string; strength: number; modalityPair: ModalityPair | 'mixed';
  aggregation: 'max' | 'top-mean'; contributions: SemanticContribution[];
}
export interface EmbeddingRunReport {
  spaceId: string; encoded: number; reused: number; discarded: number; cancelled: boolean;
  documents: Record<string, EmbeddingDocumentState>;
}
export interface EmbeddingCoverage {
  status: 'not-configured' | DocumentEmbeddingStatus; spaceId?: string;
  documents: Record<string, EmbeddingDocumentState>; readyUnits: number; totalUnits: number;
}
export class EmbeddingError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); this.name = 'EmbeddingError'; }
}
export type SemanticSignal = RelationSignal & { kind: 'semantic'; semantic: SemanticMetadata };
