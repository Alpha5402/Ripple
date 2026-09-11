import { createHash, randomUUID } from 'node:crypto';
import type { IdentityProvider } from '../../core/ports.js';

export class NodeIdentityProvider implements IdentityProvider {
  newId(): string { return randomUUID(); }
  hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
}
