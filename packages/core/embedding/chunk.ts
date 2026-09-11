import type { Document, EvidenceLocator } from '../model.js';
import type { IdentityProvider } from '../ports.js';
import { EmbeddingError, type EmbeddingConfig, type EmbeddingInput, type EmbeddingProvider, type MediaResolver, type PreparedUnit } from './model.js';

const cancelled = (signal: AbortSignal): void => { if (signal.aborted) throw new EmbeddingError('CANCELLED', 'Embedding preparation cancelled'); };
function sourceText(doc: Document, start: number, end: number): string {
  let text = doc.markdown.slice(start, end);
  const media = (doc.parsed.media ?? []).filter(m => m.start >= start && m.end <= end).sort((a, b) => b.start - a.start);
  for (const image of media) text = text.slice(0, image.start - start) + image.alt + text.slice(image.end - start);
  return text.replace(/\[\[([^\]\n]+)\]\]/g, (_, target: string) => target.includes('|') ? target.slice(target.indexOf('|') + 1) : target);
}
/** Non-overlapping section slices; token counts include title context and the provider's representation template. */
export async function prepareKnowledgeUnits(doc: Document, provider: EmbeddingProvider, config: EmbeddingConfig, identity: IdentityProvider, signal: AbortSignal, resolver?: MediaResolver): Promise<{ units: PreparedUnit[]; errors: { code: string; message: string }[] }> {
  const units: PreparedUnit[] = [];
  const errors: { code: string; message: string }[] = [];
  const counts = new Map<string, number>();
  const count = async (input: EmbeddingInput): Promise<number> => {
    cancelled(signal);
    const key = identity.hash(JSON.stringify([input.text, input.images.map(i => i.contentHash)]));
    if (!counts.has(key)) {
      const result = await provider.countTokens([input], { signal });
      if (result.length !== 1 || !Number.isSafeInteger(result[0]) || result[0]! < 0) throw new EmbeddingError('INVALID_RESPONSE', 'Invalid token count');
      counts.set(key, result[0]!);
    }
    return counts.get(key)!;
  };
  const add = (input: EmbeddingInput, evidence: EvidenceLocator, tokenCount: number, media: PreparedUnit['unit']['media']): void => {
    const contentHash = identity.hash(JSON.stringify([input.text, input.images.map(i => [i.contentHash, i.mimeType])]));
    const id = `${doc.id}:unit:${identity.hash(JSON.stringify([evidence.sectionId, evidence.start, evidence.end, media.map(m => m.source)]))}`;
    units.push({ input, unit: { id, documentId: doc.id, revision: doc.revision, kind: media.length ? 'image-context' : 'text', contentHash, text: input.text, tokenCount, evidence, media } });
  };
  const sections = doc.parsed.sections;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const start = Math.max(section.start, doc.parsed.contentStart ?? 0);
    const end = sections[i + 1]?.start ?? doc.markdown.length;
    if (end <= start || !sourceText(doc, start, end).trim()) continue;
    const prefix = [...new Set([doc.parsed.title, ...section.path])].join(' > ') + '\n\n';
    let cursor = start;
    while (cursor < end) {
      cancelled(signal);
      const inputFor = (limit: number): EmbeddingInput => ({ text: prefix + sourceText(doc, cursor, limit), images: [] });
      let limit = end;
      if (await count(inputFor(limit)) > config.chunking.maxTokens) {
        const offsets = [cursor];
        for (const char of doc.markdown.slice(cursor, end)) offsets.push(offsets.at(-1)! + char.length);
        let low = 1, high = offsets.length - 1, best = 0;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (await count(inputFor(offsets[middle]!)) <= config.chunking.maxTokens) { best = middle; low = middle + 1; }
          else high = middle - 1;
        }
        if (!best) throw new EmbeddingError('LIMIT', 'Title context alone exceeds the token budget; increase maxTokens or shorten the heading');
        limit = offsets[best]!;
        const candidate = doc.markdown.slice(cursor, limit);
        const breaks = [...candidate.matchAll(/\n\s*\n|[。！？.!?]\s|\n/g)];
        const boundary = breaks.at(-1);
        if (boundary && boundary.index > candidate.length * 0.6) limit = cursor + boundary.index + boundary[0].length;
      }
      // Do not split Markdown image references: the text-only strategy uses their alt/caption, not URI bytes.
      const crossed = (doc.parsed.media ?? []).find(m => m.start < limit && m.end > limit);
      if (crossed && crossed.start > cursor) limit = crossed.start;
      else if (crossed) {
        limit = crossed.end;
        if (await count(inputFor(limit)) > config.chunking.maxTokens) throw new EmbeddingError('LIMIT', 'Image alternative text exceeds the token budget');
      }
      // BPE counts are not strictly monotone: moving to a sentence/media boundary can increase them.
      while (await count(inputFor(limit)) > config.chunking.maxTokens) {
        const tail = [...doc.markdown.slice(cursor, limit)].at(-1);
        if (!tail || limit - tail.length <= cursor) throw new EmbeddingError('LIMIT', 'No source slice fits the token budget');
        limit -= tail.length;
        const media = (doc.parsed.media ?? []).find(m => m.start < limit && m.end > limit);
        if (media) limit = media.start;
        if (limit <= cursor) throw new EmbeddingError('LIMIT', 'Image alternative text exceeds the token budget');
      }
      const input = inputFor(limit);
      if (sourceText(doc, cursor, limit).trim()) add(input, { documentId: doc.id, revision: doc.revision, sectionId: section.id, start: cursor, end: limit }, await count(input), []);
      cursor = limit;
    }
  }
  if (config.mode === 'multimodal') for (const reference of doc.parsed.media ?? []) {
    try {
      cancelled(signal);
      if (!resolver) throw new EmbeddingError('CAPABILITY', 'MultiModal image units need a MediaResolver');
      const image = await resolver.resolve(doc, reference, signal);
      const section = sections.find(s => s.id === reference.sectionId)!;
      const ownEnd = sections[sections.indexOf(section) + 1]?.start ?? doc.markdown.length;
      let contextChars = config.chunking.imageContextChars;
      const prefix = [...new Set([doc.parsed.title, ...section.path])].join(' > ') + '\n\n';
      let input: EmbeddingInput;
      let tokenCount: number;
      let start: number, end: number;
      do {
        start = Math.max(section.start, reference.start - contextChars);
        end = Math.min(ownEnd, reference.end + contextChars);
        input = { text: prefix + sourceText(doc, start, end), images: [image] };
        tokenCount = await count(input);
        if (tokenCount <= config.chunking.maxTokens) break;
        if (!contextChars) throw new EmbeddingError('LIMIT', 'Image and title exceed the token budget; increase it or reduce provider image resolution');
        contextChars = Math.floor(contextChars / 2);
      } while (true);
      const evidence = { documentId: doc.id, revision: doc.revision, sectionId: reference.sectionId, start: start!, end: end! };
      add(input!, evidence, tokenCount!, [{ source: reference.source, contentHash: image.contentHash,
        evidence: { ...evidence, start: reference.start, end: reference.end } }]);
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push({ code: error instanceof EmbeddingError ? error.code : 'MEDIA', message: (error as Error).message });
    }
  }
  return { units, errors };
}
