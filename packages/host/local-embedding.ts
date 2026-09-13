export const LOCAL_EMBEDDING_MODEL = 'tencent/WeMM-Embedding-2B';
export const LOCAL_EMBEDDING_REVISION = 'bbd6cd4bf52cfc6716f752a2df80b2706720bd95';
export interface LocalEmbeddingState {
  status: 'unavailable' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
  baseUrl: string;
  runtimePath?: string;
  autoStart: boolean;
  managed: boolean;
  message: string;
  log: string;
}
export function isManagedEmbeddingUrl(value: string, baseUrl = 'http://127.0.0.1:8787'): boolean {
  try {
    const url = new URL(value), base = new URL(baseUrl);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === base.port && !url.username && !url.password && ['', '/', '/v1', '/v1/'].includes(url.pathname);
  } catch { return false; }
}
