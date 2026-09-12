import { EmbeddingError, type EmbeddingInput, type EmbeddingProvider, type ModelDescriptor } from '../../core/embedding/model.js';
import { stableStringify } from '../../core/embedding/config.js';

export interface HttpEmbeddingOptions {
  baseUrl: string; protocol: 'ripple' | 'openai-compatible'; apiKey?: string;
  descriptor?: ModelDescriptor; timeoutMs?: number; fetch?: typeof globalThis.fetch;
}
export class HttpEmbeddingProvider implements EmbeddingProvider {
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private constructor(readonly descriptor: ModelDescriptor, private readonly options: HttpEmbeddingOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new EmbeddingError('CONFIG', 'Use an HTTP endpoint without embedded credentials or query parameters');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new EmbeddingError('CONFIG', 'Cloud endpoints require HTTPS; use HTTP only for loopback');
    this.baseUrl = url.href.replace(/\/$/, ''); this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  /** Restore a previously verified model identity without a network probe. Every response still validates that identity. */
  static fromDescriptor(options: HttpEmbeddingOptions & { descriptor: ModelDescriptor }): HttpEmbeddingProvider {
    return new HttpEmbeddingProvider(structuredClone(options.descriptor), options);
  }
  static async connect(options: HttpEmbeddingOptions): Promise<HttpEmbeddingProvider> {
    if (options.protocol === 'openai-compatible') {
      if (!options.descriptor || options.descriptor.modalities.join(',') !== 'text') throw new EmbeddingError('CONFIG', 'OpenAI-compatible text endpoints need an explicit text-only model descriptor');
      return new HttpEmbeddingProvider(structuredClone(options.descriptor), options);
    }
    const provisional = new HttpEmbeddingProvider({} as ModelDescriptor, options);
    const info = await provisional.request('/v1/model-info', undefined, new AbortController().signal) as ModelDescriptor;
    if (!info.model || !info.revision || !info.representation || !info.tokenizer || !Array.isArray(info.modalities)
      || !Number.isSafeInteger(info.dimensions) || !Number.isSafeInteger(info.maxInputTokens)) throw new EmbeddingError('INVALID_RESPONSE', 'Embedding endpoint returned an invalid model descriptor');
    if (options.descriptor && stableStringify(options.descriptor) !== stableStringify(info)) throw new EmbeddingError('SPACE_MISMATCH', 'Remote model descriptor differs from configured identity');
    return new HttpEmbeddingProvider(info, options);
  }
  private async request(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await this.requestFetch(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 120_000)]),
      });
      if (!response.ok) throw new EmbeddingError(response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 413 || response.status === 422 ? 'LIMIT'
        : response.status === 429 ? 'RATE_LIMIT' : 'HTTP', `Embedding endpoint returned HTTP ${response.status}`, response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504);
      return await response.json();
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (signal.aborted) throw new EmbeddingError('CANCELLED', 'Embedding request cancelled');
      if (error instanceof SyntaxError) throw new EmbeddingError('INVALID_RESPONSE', 'Embedding endpoint returned invalid JSON');
      throw new EmbeddingError('NETWORK', 'Embedding endpoint is unavailable or timed out', true);
    }
  }
  async countTokens(inputs: EmbeddingInput[], options: { signal: AbortSignal }): Promise<number[]> {
    if (this.options.protocol === 'openai-compatible') {
      if (inputs.some(input => input.images.length)) throw new EmbeddingError('CAPABILITY', 'This endpoint accepts text only');
      if (this.descriptor.tokenizer !== 'utf8-upper-bound-v1') throw new EmbeddingError('CONFIG', 'Configure utf8-upper-bound-v1 for endpoints without a tokenization API');
      // Conservative byte-token budget for byte-level BPE. Endpoint over-limit errors remain visible, never truncated.
      return inputs.map(input => new TextEncoder().encode(input.text).length + 32);
    }
    const body = await this.request('/v1/tokenize', { model: this.descriptor.model, input: inputs }, options.signal) as { counts?: number[]; revision?: string };
    if (!Array.isArray(body.counts) || body.counts.length !== inputs.length || body.revision !== this.descriptor.revision) throw new EmbeddingError('INVALID_RESPONSE', 'Token count response does not match the requested batch or revision');
    return body.counts;
  }
  async embed(inputs: EmbeddingInput[], options: { signal: AbortSignal }): Promise<number[][]> {
    if (this.options.protocol === 'openai-compatible' && inputs.some(input => input.images.length)) throw new EmbeddingError('CAPABILITY', 'Text endpoint cannot receive image units');
    const body = await this.request('/v1/embeddings', { model: this.descriptor.model,
      input: this.options.protocol === 'ripple' ? inputs : inputs.map(input => input.text), encoding_format: 'float' }, options.signal) as {
        model?: string; revision?: string; representation?: string; data?: { index: number; embedding: number[] }[];
      };
    if (body.model !== this.descriptor.model || (this.options.protocol === 'ripple' && (body.revision !== this.descriptor.revision || body.representation !== this.descriptor.representation))) throw new EmbeddingError('SPACE_MISMATCH', 'Embedding response came from a different model or representation');
    if (!Array.isArray(body.data) || body.data.length !== inputs.length) throw new EmbeddingError('INVALID_RESPONSE', 'Embedding response batch size mismatch');
    const ordered: number[][] = [];
    for (const row of body.data) {
      if (!Number.isSafeInteger(row.index) || row.index < 0 || row.index >= inputs.length || ordered[row.index] !== undefined || !Array.isArray(row.embedding)) throw new EmbeddingError('INVALID_RESPONSE', 'Embedding response contains missing or duplicate indexes');
      ordered[row.index] = row.embedding;
    }
    return ordered;
  }
}
