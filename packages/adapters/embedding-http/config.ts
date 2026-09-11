import { readFile } from 'node:fs/promises';
import { DEFAULT_EMBEDDING_CONFIG } from '../../core/embedding/config.js';
import { EmbeddingError, type EmbeddingConfig, type ModelDescriptor } from '../../core/embedding/model.js';
import { HttpEmbeddingProvider } from './index.js';
import { LocalMediaResolver } from '../filesystem/media.js';
import type { KnowledgeService } from '../../core/service.js';

export interface EmbeddingFileConfig {
  provider: { protocol: 'ripple' | 'openai-compatible'; baseUrl: string; apiKeyEnv?: string; descriptor?: ModelDescriptor; timeoutMs?: number };
  indexing?: {
    mode?: EmbeddingConfig['mode']; chunking?: Partial<EmbeddingConfig['chunking']>;
    retrieval?: Partial<EmbeddingConfig['retrieval']>; execution?: Partial<EmbeddingConfig['execution']>;
  };
}
export async function configureEmbeddingFromFile(service: KnowledgeService, file: string, vaultRoot: string): Promise<void> {
  const config = JSON.parse(await readFile(file, 'utf8')) as EmbeddingFileConfig;
  const apiKey = config.provider.apiKeyEnv ? process.env[config.provider.apiKeyEnv] : undefined;
  if (config.provider.apiKeyEnv && !apiKey) throw new EmbeddingError('AUTH', `Missing API key environment variable: ${config.provider.apiKeyEnv}`);
  const provider = await HttpEmbeddingProvider.connect({ ...config.provider, ...(apiKey ? { apiKey } : {}) });
  const indexing = config.indexing ?? {};
  service.configureEmbedding(provider, {
    mode: indexing.mode ?? 'text-only',
    chunking: { ...DEFAULT_EMBEDDING_CONFIG.chunking, maxTokens: Math.min(512, provider.descriptor.maxInputTokens), ...indexing.chunking },
    retrieval: { ...structuredClone(DEFAULT_EMBEDDING_CONFIG.retrieval), ...indexing.retrieval },
    execution: { ...DEFAULT_EMBEDDING_CONFIG.execution, ...indexing.execution },
  }, new LocalMediaResolver(vaultRoot));
}
