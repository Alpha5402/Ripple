import { createNodeKernel } from '../packages/adapters/node/index.js';
import type { DocumentInput } from '../packages/core/model.js';

export const document = (id: string, markdown: string, path = `${id}.md`): DocumentInput => ({ id, path, markdown });
export function kernel(...documents: DocumentInput[]) {
  const service = createNodeKernel(); service.ingestDocuments(documents); return service;
}
