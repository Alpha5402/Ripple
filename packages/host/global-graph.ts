import type { KnowledgeService } from '../core/service.js';
import type { GlobalGraph } from './contract.js';

/** Union every center, including disconnected notes; honor hidden relation overrides. */
export function collectGlobalGraph(service: Pick<KnowledgeService, 'listDocuments' | 'getRelations' | 'getIndexCoverage'>): GlobalGraph {
  const documents = service.listDocuments().map(d => ({ id: d.id, path: d.path, title: d.parsed.title, revision: d.revision }));
  const ids = new Set(documents.map(d => d.id));
  const relations = new Map<string, GlobalGraph['relations'][number]>();
  for (const document of documents) for (const relation of service.getRelations(document.id)) {
    if (relation.override.hidden || !relation.nodes.every(id => ids.has(id))) continue;
    const old = relations.get(relation.id);
    if (!old || relation.score > old.score) relations.set(relation.id, relation);
  }
  return { documents, relations: [...relations.values()], indexRevision: service.getIndexCoverage().indexRevision };
}
