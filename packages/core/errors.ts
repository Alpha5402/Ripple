import { KernelError, type KernelErrorCode } from './model.js';
import { EmbeddingError } from './embedding/model.js';
export interface OperationError { code: KernelErrorCode | string; message: string; retryable: boolean; source: 'kernel' | 'embedding' | 'host' }
/** Hosts may log underlying exceptions privately; unknown errors never expose their message to clients. */
export function serializeOperationError(error: unknown): OperationError {
  if (error instanceof KernelError) return { code: error.code, message: error.message, retryable: error.code === 'STORAGE_CONFLICT' || error.code === 'STALE_INDEX', source: 'kernel' };
  if (error instanceof EmbeddingError) return { code: error.code, message: error.message, retryable: error.retryable, source: 'embedding' };
  return { code: 'INTERNAL', message: 'Unexpected host error', retryable: false, source: 'host' };
}
