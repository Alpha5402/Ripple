import { z } from 'zod';
import { HttpEmbeddingProvider } from '../adapters/embedding-http/index.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../core/embedding/config.js';
import { EmbeddingError, type EmbeddingConfig } from '../core/embedding/model.js';

export const embeddingConnectionSchema = z.object({
  protocol: z.enum(['ripple', 'openai-compatible']),
  baseUrl: z.string().url().max(2048),
  apiKey: z.string().max(4096).default(''),
  model: z.string().max(256).default(''),
  revision: z.string().max(256).default('default'),
  maxInputTokens: z.number().int().min(64).max(1048576).default(8192),
  chunkTokens: z.number().int().min(64).max(8192).default(512),
  batchSize: z.number().int().min(1).max(8).default(1),
});
export type EmbeddingConnection = z.infer<typeof embeddingConnectionSchema>;
export type SafeEmbeddingConnection = Omit<EmbeddingConnection, 'apiKey'>;

/** Probe with fixed public text before activating. Never use a user's note as a connection test. */
export async function connectEmbedding(raw: EmbeddingConnection) {
  const settings = embeddingConnectionSchema.parse(raw);
  const baseUrl = settings.baseUrl.trim().replace(/\/$/, '').replace(/\/v1(?:\/embeddings)?$/, '');
  if (settings.protocol === 'openai-compatible' && !settings.model.trim()) throw new EmbeddingError('CONFIG', '请填写模型名称');
  const options = { protocol: settings.protocol, baseUrl, apiKey: settings.apiKey, timeoutMs: 25000 };
  let provider = await HttpEmbeddingProvider.connect({ ...options, ...(settings.protocol === 'openai-compatible' ? { descriptor: {
    model: settings.model.trim(), revision: settings.revision || 'default', dimensions: 1, normalized: false,
    modalities: ['text' as const], maxInputTokens: settings.maxInputTokens, representation: 'document-text-v1', tokenizer: 'utf8-upper-bound-v1',
  } } : {}) });
  const signal = AbortSignal.timeout(25000);
  const input = [{ text: 'Ripple connection test', images: [] }];
  await provider.countTokens(input, { signal });
  const vectors = await provider.embed(input, { signal });
  const vector = vectors[0];
  if (!vector?.length || vector.some(value => !Number.isFinite(value)) || !vector.some(value => value !== 0)
    || (settings.protocol === 'ripple' && vector.length !== provider.descriptor.dimensions)) throw new EmbeddingError('INVALID_RESPONSE', '模型返回了无效向量');
  if (settings.protocol === 'openai-compatible') provider = await HttpEmbeddingProvider.connect({ ...options, descriptor: { ...provider.descriptor, dimensions: vector.length } });
  const config: EmbeddingConfig = structuredClone(DEFAULT_EMBEDDING_CONFIG);
  config.chunking.maxTokens = Math.min(settings.chunkTokens, provider.descriptor.maxInputTokens);
  config.execution.batchSize = settings.batchSize;
  const { apiKey: _key, ...safe } = settings;
  return { provider, config, settings: { ...safe, baseUrl, model: provider.descriptor.model, maxInputTokens: provider.descriptor.maxInputTokens } };
}

export function embeddingErrorMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    AUTH: '认证失败，请检查 API Key。', NETWORK: '连接失败：请确认服务地址、网络和跨域许可（CORS）；HTTPS 网页也可能限制访问本地 HTTP 服务。',
    RATE_LIMIT: '服务请求过于频繁，请稍后重试。', LIMIT: '服务输入长度超限，请降低分块大小。',
    SPACE_MISMATCH: '返回的模型身份与配置不一致，请检查模型名称。', INVALID_RESPONSE: '服务未返回有效的 Embedding 向量。',
    CONFIG: '配置无效，请检查服务地址、模型名称和输入限制。', CAPABILITY: '模型不支持当前文本索引配置。',
    CANCELLED: '索引已取消，已完成的向量仍可继续使用。', HTTP: '模型服务返回错误，请检查服务状态。',
  };
  return messages[code ?? ''] ?? '操作失败，请检查配置或服务状态后重试。';
}
