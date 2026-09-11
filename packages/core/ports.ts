import type { KernelState, ParsedDocument } from './model.js';

export interface MarkdownParser {
  readonly version: string;
  parse(documentId: string, path: string, markdown: string): ParsedDocument;
}
/** Adapters must return/save detached values. User declarations are durable data, not cache. */
export interface KnowledgeStorage { load(): KernelState; save(state: KernelState): void }
export interface IdentityProvider { newId(): string; hash(text: string): string }
