import { KnowledgeService } from '../../core/service.js';
import type { KernelState, ScorePolicy } from '../../core/model.js';
import { MemoryStorage } from '../storage-memory/index.js';
import { RemarkMarkdownParser } from '../parser-markdown/index.js';
import { NodeIdentityProvider } from '../runtime-node/index.js';

export { MemoryStorage, RemarkMarkdownParser, NodeIdentityProvider };
export function createNodeKernel(options: { initialState?: KernelState; scorePolicy?: ScorePolicy } = {}): KnowledgeService {
  return new KnowledgeService({ storage: new MemoryStorage(options.initialState), parser: new RemarkMarkdownParser(), identity: new NodeIdentityProvider() }, options.scorePolicy);
}
export { SqliteStorage } from '../storage-sqlite/index.js';
export { openSqliteVault } from '../filesystem/sqlite-workspace.js';
