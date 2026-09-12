import type { KernelState, ParsedDocument } from './model.js';

export interface MarkdownParser {
  readonly version: string;
  parse(documentId: string, path: string, markdown: string): ParsedDocument;
}
/** Adapters must return/save detached values. User declarations are durable data, not cache. */
export interface KnowledgeStorage {
  readonly storageCapabilities?: StorageCapabilities;
  load(): KernelState; save(state: KernelState, options?: StorageWriteOptions): void;
}
/** The caller guarantees that space contents are unchanged since the last successful load/save.
 * KnowledgeService supplies this only when immutable internal space objects retain identity. */
export interface StorageWriteOptions { embeddingSpacesUnchanged?: true }
export interface IdentityProvider { newId(): string; hash(text: string): string }

export type SearchMode = 'text' | 'literal' | 'exact';
export interface SearchOptions { mode?: SearchMode; limit?: number }
export interface SearchHit {
  documentId: string; revision: number; path: string; title: string; score: number;
  excerpt: string; match?: { start: number; end: number };
}
export interface KnowledgeSearch {
  readonly searchCapabilities: { engine: string; modes: readonly SearchMode[] };
  search(query: string, options?: SearchOptions): SearchHit[];
}
export interface StorageCapabilities { kind: string; persistent: boolean; concurrency: 'single-instance' | 'optimistic' }
