import type { IdentityProvider } from '../ports.js';
import { EmbeddingError, type EmbeddingConfig, type EmbeddingSpace, type ModelDescriptor } from './model.js';

export const DEFAULT_EMBEDDING_CONFIG: Readonly<EmbeddingConfig> = {
  mode: 'text-only', chunking: { version: 'section-tokens-v1', maxTokens: 512, imageContextChars: 400 },
  retrieval: { version: 'cosine-baseline-v1', candidateBudget: 100, aggregation: 'max', topMatches: 3,
    mappings: { 'text-text': { min: 0.2, max: 0.9 }, 'text-image': { min: 0.15, max: 0.9 }, 'image-image': { min: 0.2, max: 0.95 } } },
  execution: { batchSize: 4, maxRetries: 2, retryDelayMs: 100 },
};
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function validateEmbeddingConfig(config: EmbeddingConfig, descriptor: ModelDescriptor): void {
  if (!['text-only', 'multimodal'].includes(config.mode) || !descriptor.model || !descriptor.revision || !descriptor.representation || !descriptor.tokenizer
    || !Number.isSafeInteger(descriptor.dimensions) || descriptor.dimensions < 1 || !Number.isSafeInteger(descriptor.maxInputTokens) || descriptor.maxInputTokens < 1
    || typeof descriptor.normalized !== 'boolean' || !Array.isArray(descriptor.modalities)
    || descriptor.modalities.some(mode => !['text', 'image'].includes(mode))
    || !descriptor.modalities.includes('text') || (config.mode === 'multimodal' && !descriptor.modalities.includes('image')))
    throw new EmbeddingError('CAPABILITY', 'Provider descriptor does not support the requested indexing mode');
  const integers = [config.chunking.maxTokens, config.retrieval.candidateBudget, config.retrieval.topMatches, config.execution.batchSize];
  if (integers.some(n => !Number.isSafeInteger(n) || n < 1) || config.chunking.maxTokens > descriptor.maxInputTokens
    || !Number.isSafeInteger(config.chunking.imageContextChars) || config.chunking.imageContextChars < 0
    || !Number.isSafeInteger(config.execution.maxRetries) || config.execution.maxRetries < 0 || config.execution.maxRetries > 5
    || !Number.isFinite(config.execution.retryDelayMs) || config.execution.retryDelayMs < 0 || config.execution.retryDelayMs > 60_000
    || !config.chunking.version || !config.retrieval.version || !['max', 'top-mean'].includes(config.retrieval.aggregation))
    throw new EmbeddingError('CONFIG', 'Invalid chunk, candidate or execution budget');
  for (const pair of ['text-text', 'text-image', 'image-image'] as const) {
    const mapping = config.retrieval.mappings[pair];
    if (!mapping || !Number.isFinite(mapping.min) || !Number.isFinite(mapping.max) || mapping.min < -1 || mapping.max > 1 || mapping.min >= mapping.max)
      throw new EmbeddingError('CONFIG', `Invalid cosine mapping for ${pair}`);
  }
}
export function createEmbeddingSpace(descriptor: ModelDescriptor, config: EmbeddingConfig, identity: IdentityProvider): EmbeddingSpace {
  validateEmbeddingConfig(config, descriptor);
  const representation = { descriptor: { ...descriptor, modalities: [...descriptor.modalities].sort() }, mode: config.mode, chunking: config.chunking };
  return { id: `embedding:${identity.hash(stableStringify(representation))}`, ...structuredClone(representation) };
}
