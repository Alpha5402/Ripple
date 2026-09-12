import type { SafeEmbeddingConnection } from './embedding-connection.js';
import type { EmbeddingConfig, ModelDescriptor } from '../core/embedding/model.js';
import { HttpEmbeddingProvider } from '../adapters/embedding-http/index.js';

/** Credentials are stored separately by the native host, never in kernel caches. */
export interface EmbeddingPreferences {
  settings: SafeEmbeddingConnection;
  descriptor: ModelDescriptor;
  config: EmbeddingConfig;
  requiresAuth: boolean;
  autoIndex: boolean;
}
export function restoreEmbedding(preferences: EmbeddingPreferences, apiKey = '') {
  return HttpEmbeddingProvider.fromDescriptor({ protocol: preferences.settings.protocol, baseUrl: preferences.settings.baseUrl,
    descriptor: preferences.descriptor, apiKey, timeoutMs: 25000 });
}
