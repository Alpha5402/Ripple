import { EntityIndex, nameKey, naturalNameAllowed } from './entity.js';
import type { Document, EvidenceLocator, Mention, WikiLink } from './model.js';

const latinWord = (value: string): boolean => /[\p{Script=Latin}\p{N}_]/u.test(value);
// A literal trie scans each text span once per possible prefix, independent of vault name count.
interface TrieNode { children: Map<string, TrieNode>; terminal?: true }
const fold = (char: string): string => [...char.toUpperCase()].length === 1 ? char.toUpperCase().toLowerCase() : char.toLowerCase();
export class NameMatcher {
  private root: TrieNode = { children: new Map() };
  constructor(index: EntityIndex) {
    for (const name of new Set(index.definitions.filter(d => naturalNameAllowed(d.name, d.allowShort)).map(d => d.name))) {
      let node = this.root;
      for (const char of name) {
        const key = fold(char);
        let child = node.children.get(key);
        if (!child) { child = { children: new Map() }; node.children.set(key, child); }
        node = child;
      }
      node.terminal = true;
    }
  }
  matches(text: string): { start: number; end: number; text: string }[] {
    const chars = [...text], offsets: number[] = [];
    let offset = 0;
    for (const char of chars) { offsets.push(offset); offset += char.length; }
    offsets.push(offset);
    const found: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < chars.length; i++) {
      let node = this.root, last = -1;
      for (let j = i; j < chars.length; j++) {
        const child = node.children.get(fold(chars[j]!));
        if (!child) break;
        node = child;
        if (node.terminal && !(latinWord(chars[i]!) && latinWord(chars[i - 1] ?? ''))
          && !(latinWord(chars[j]!) && latinWord(chars[j + 1] ?? ''))) last = j;
      }
      if (last >= i) {
        const start = offsets[i]!, end = offsets[last + 1]!;
        found.push({ start, end, text: text.slice(start, end) }); i = last;
      }
    }
    return found;
  }
}
export function extractReferences(doc: Document, index: EntityIndex, matcher = new NameMatcher(index)): { mentions: Mention[]; wikiLinks: WikiLink[] } {
  const locate = (start: number, end: number, sectionId: string): EvidenceLocator => ({ documentId: doc.id, revision: doc.revision, start, end, sectionId });
  const wikiLinks: WikiLink[] = doc.parsed.wikiLinks.map(link => ({
    id: `${doc.id}@${doc.revision}:wiki:${link.start}`, sourceDocumentId: doc.id,
    text: doc.markdown.slice(link.start, link.end), targetText: link.target,
    resolution: index.resolveLink(link.target, doc.id), evidence: locate(link.start, link.end, link.sectionId),
  }));
  const mentions: Mention[] = [];
  const decorated = new Set<string>();
  for (const span of doc.parsed.textSpans) {
    const text = doc.markdown.slice(span.start, span.end);
    const matches = matcher.matches(text).map(m => ({ ...m, start: span.start + m.start, end: span.start + m.end }));
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
