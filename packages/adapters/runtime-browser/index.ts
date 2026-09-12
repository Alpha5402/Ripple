import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { IdentityProvider } from '../../core/ports.js';
export class BrowserIdentityProvider implements IdentityProvider {
  newId(): string { return crypto.randomUUID(); }
  hash(text: string): string { return bytesToHex(sha256(new TextEncoder().encode(text))); }
}
