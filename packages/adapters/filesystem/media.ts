import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, dirname, join, extname, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Document } from '../../core/model.js';
import { EmbeddingError, type EmbeddingImage, type MediaReference, type MediaResolver } from '../../core/embedding/model.js';

const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export class LocalMediaResolver implements MediaResolver {
  constructor(private readonly vaultRoot: string, private readonly maxBytes = 8 * 1024 * 1024) {}
  async resolve(document: Document, reference: MediaReference, signal: AbortSignal): Promise<EmbeddingImage> {
    if (signal.aborted) throw new EmbeddingError('CANCELLED', 'Image read cancelled');
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference.source) || reference.source.startsWith('//')) throw new EmbeddingError('CAPABILITY', 'Remote media is not fetched automatically; use a local vault attachment');
    const root = await realpath(this.vaultRoot);
    let source: string;
    try { source = decodeURIComponent(reference.source.split('#')[0]!); } catch { throw new EmbeddingError('MEDIA', 'Invalid attachment path encoding'); }
    const candidates = [...new Set([resolve(root, dirname(document.path), source), resolve(root, source), join(root, 'Attachments', source)])];
    let path: string | undefined;
    for (const candidate of candidates) {
      const canonical = await realpath(candidate).catch(() => undefined);
      if (!canonical) continue;
      const inside = relative(root, canonical);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new EmbeddingError('MEDIA', 'Attachment escapes the vault');
      path = canonical; break;
    }
    if (!path) throw new EmbeddingError('MEDIA', 'Referenced attachment was not found in the vault');
    const mimeType = mimeTypes[extname(path).toLowerCase()];
    if (!mimeType) throw new EmbeddingError('CAPABILITY', 'Only PNG, JPEG, WebP and GIF images are supported by this adapter');
    const information = await stat(path);
    if (!information.isFile() || information.size > this.maxBytes) throw new EmbeddingError('LIMIT', 'Attachment exceeds the configured byte limit');
    const data = await readFile(path, { signal });
    if (data.length > this.maxBytes) throw new EmbeddingError('LIMIT', 'Attachment grew beyond the configured byte limit');
    return { dataUrl: `data:${mimeType};base64,${data.toString('base64')}`, contentHash: createHash('sha256').update(data).digest('hex'), mimeType };
  }
}
