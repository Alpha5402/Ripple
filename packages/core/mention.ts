import { EntityIndex, nameKey, naturalNameAllowed } from './entity.js';
import type { Document, EvidenceLocator, Mention, WikiLink } from './model.js';

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const latinWord = (value: string): boolean => /[\p{Script=Latin}\p{N}_]/u.test(value);
export function extractReferences(doc: Document, index: EntityIndex): { mentions: Mention[]; wikiLinks: WikiLink[] } {
  const locate = (start: number, end: number, sectionId: string): EvidenceLocator => ({ documentId: doc.id, revision: doc.revision, start, end, sectionId });
  const wikiLinks: WikiLink[] = doc.parsed.wikiLinks.map(link => ({
    id: `${doc.id}@${doc.revision}:wiki:${link.start}`, sourceDocumentId: doc.id,
    text: doc.markdown.slice(link.start, link.end), targetText: link.target,
    resolution: index.resolveLink(link.target, doc.id), evidence: locate(link.start, link.end, link.sectionId),
  }));
  const names = [...new Map(index.definitions.filter(d => naturalNameAllowed(d.name, d.allowShort)).map(d => [nameKey(d.name), d.name])).values()];
  const mentions: Mention[] = [];
  const decorated = new Set<string>();
  for (const span of doc.parsed.textSpans) {
    const text = doc.markdown.slice(span.start, span.end);
    const matches: { start: number; end: number; text: string }[] = [];
    for (const name of names) {
      for (const match of text.matchAll(new RegExp(escapePattern(name), 'giu'))) {
        const start = match.index;
        const end = start + match[0].length;
        // Boundaries apply to literal text spans; Markdown markup itself is a delimiter.
        const previous = text[start - 1] ?? '';
        const next = text[end] ?? '';
        if ((latinWord(match[0][0]!) && latinWord(previous)) || (latinWord(match[0].at(-1)!) && latinWord(next))) continue;
        matches.push({ start: span.start + start, end: span.start + end, text: match[0] });
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let consumed = -1;
    for (const match of matches) {
      if (match.start < consumed) continue;
      consumed = match.end;
      const resolution = index.resolveName(match.text, true);
      const targetKey = resolution.status === 'resolved' ? JSON.stringify(resolution.candidates[0]) : nameKey(match.text);
      const decorationKey = `${span.blockId}:${targetKey}`;
      mentions.push({
        id: `${doc.id}@${doc.revision}:mention:${match.start}`, sourceDocumentId: doc.id, text: match.text,
        resolution, evidence: locate(match.start, match.end, span.sectionId), blockId: span.blockId,
        decorate: !decorated.has(decorationKey),
      });
      decorated.add(decorationKey);
    }
  }
  return { mentions, wikiLinks };
}
