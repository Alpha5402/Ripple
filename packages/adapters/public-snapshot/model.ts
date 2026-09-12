import type { RelationSignal, ScorePolicy } from '../../core/model.js';
import type { ModelDescriptor } from '../../core/embedding/model.js';
export interface PublicBundle {
  schemaVersion: 1;
  id: string;
  title: string;
  generatedAt: string;
  documents: { id: string; path: string; markdown: string }[];
  scorePolicy: ScorePolicy;
  semantic?: { descriptor: ModelDescriptor; spaceId: string; signals: RelationSignal[]; omittedChangedDocuments: number };
}
