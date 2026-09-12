import { z } from 'zod';
import { embeddingConnectionSchema, type SafeEmbeddingConnection } from './embedding-connection.js';
import type { Relation, Document, EvidenceLocator, ExplorationHistoryState, Mention, WikiLink, VisibleRelations } from '../core/model.js';
import type { KnowledgeService } from '../core/service.js';

const id = z.string().min(1).max(200);
const point = z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) });
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state') }),
  z.object({ type: z.literal('global-graph') }),
  z.object({ type: z.literal('focus'), id }),
  z.object({ type: z.literal('read'), id }),
  z.object({ type: z.literal('lens'), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('more') }),
  z.object({ type: z.literal('search'), query: z.string().max(256) }),
  z.object({ type: z.literal('evidence'), locator: z.object({ documentId: id, revision: z.number().int().positive(), sectionId: z.string().max(500), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }) }),
  z.object({ type: z.literal('save'), id, expectedHash: z.string().max(200), markdown: z.string().max(4 * 1024 * 1024) }),
  z.object({ type: z.literal('view'), layout: z.record(id, point).optional(), camera: point.extend({ zoom: z.number().min(0.2).max(4) }).optional(), reading: z.object({ documentId: id, offset: z.number().nonnegative().max(10000000) }).nullable().optional() }),
  z.object({ type: z.literal('configure-embedding'), settings: embeddingConnectionSchema }),
  z.object({ type: z.literal('index') }),
  z.object({ type: z.literal('cancel-index') }),
]);
export type HostCommand = z.infer<typeof commandSchema>;
export interface DocumentSummary { id: string; path: string; title: string; revision: number }
export interface GlobalGraph { documents: DocumentSummary[]; relations: Relation[]; indexRevision: number }
export interface ReadingDocument { document: Document; mentions: Mention[]; links: WikiLink[] }
export interface WorkbenchState {
  label: string;
  mode: 'desktop' | 'public' | 'harness';
  readOnly: boolean;
  documents: DocumentSummary[];
  current: ExplorationHistoryState | null;
  visible: VisibleRelations | null;
  canBack: boolean;
  coverage: ReturnType<KnowledgeService['getIndexCoverage']>;
  indexing: boolean;
  embeddingConnection?: SafeEmbeddingConnection | undefined;
  notices: string[];
}
export interface WorkbenchBridge {
  supportsEmbedding?: boolean;
  supportsGlobalGraph?: boolean;
  command(command: HostCommand): Promise<unknown>;
  subscribe(listener: () => void): () => void;
  chooseFolder?(readOnly: boolean): Promise<boolean>;
  chooseEmbedding?(): Promise<boolean>;
  setDirty?(dirty: boolean): void;
}
export type EvidenceResult = { status: 'valid' | 'stale' | 'missing'; locator: EvidenceLocator; text?: string; excerpt?: string; path?: string };
