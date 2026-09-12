import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { parseDocument } from 'yaml';
import { KernelError, type ParsedDocument, type ParsedWikiLink, type Section, type TextSpan } from '../../core/model.js';
import type { MarkdownParser } from '../../core/ports.js';
import type { MediaReference } from '../../core/embedding/model.js';

interface AstNode {
  type: string; value?: string; depth?: number; children?: AstNode[];
  url?: string; alt?: string; identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
}
const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm);
const ignored = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'html', 'yaml', 'definition']);
const plain = (node: AstNode): string => node.value ?? node.children?.map(plain).join('') ?? '';
const escaped = (text: string, offset: number): boolean => {
  let count = 0;
  while (text[--offset] === '\\') count++;
  return count % 2 === 1;
};

export class RemarkMarkdownParser implements MarkdownParser {
  readonly version = 'remark-ripple-v3';
  parse(documentId: string, path: string, markdown: string): ParsedDocument {
    // mdast offsets exclude a leading BOM. Keep all evidence in the original UTF-16 source coordinates.
    const bom = markdown.startsWith('\uFEFF') ? 1 : 0;
    const tree = processor.parse(markdown.slice(bom)) as AstNode;
    const startOf = (node: AstNode): number => (node.position?.start.offset ?? 0) + bom;
    const endOf = (node: AstNode): number => (node.position?.end.offset ?? 0) + bom;
    const names: ParsedDocument['names'] = [{ name: path.split('/').at(-1)!.replace(/\.md$/i, ''), source: 'filename' }];
    const warnings: string[] = [];
    let configuredTitle: string | undefined;
    const yaml = tree.children?.find(node => node.type === 'yaml');
    if (yaml) {
      const parsed = parseDocument(yaml.value ?? '', { uniqueKeys: true });
      if (parsed.errors.length) throw new KernelError('INVALID_INPUT', `Invalid frontmatter in ${path}: ${parsed.errors[0]!.message}`);
      const meta: unknown = parsed.toJS({ maxAliasCount: 50 });
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        const record = meta as Record<string, unknown>;
        if (typeof record.title === 'string' && record.title.trim()) {
          configuredTitle = record.title.trim(); names.push({ name: configuredTitle, source: 'frontmatter' });
        }
        const aliases = typeof record.aliases === 'string' ? [record.aliases] : record.aliases;
        if (Array.isArray(aliases)) for (const alias of aliases) {
          if (typeof alias === 'string' && alias.trim()) names.push({ name: alias.trim(), source: 'alias' });
          else warnings.push('Ignored non-string or empty alias');
        }
        else if (aliases != null) warnings.push('aliases must be a string or string array');
      }
    }
    const headings: AstNode[] = [];
    const collect = (node: AstNode): void => {
      if (ignored.has(node.type)) return;
      if (node.type === 'heading') headings.push(node);
      node.children?.forEach(collect);
    };
    collect(tree);
    const mainTitle = headings.find(node => node.depth === 1);
    if (mainTitle) names.push({ name: plain(mainTitle), source: 'heading' });
    const title = configuredTitle ?? (mainTitle ? plain(mainTitle) : names[0]!.name);
    const sections: Section[] = [{ id: `${documentId}:root`, title, path: [], depth: 0, start: 0, end: markdown.length }];
    const ancestors: Section[] = [];
    const occurrences = new Map<string, number>();
    for (const heading of headings) {
      const depth = heading.depth!;
      while (ancestors.length && ancestors.at(-1)!.depth >= depth) ancestors.pop()!.end = startOf(heading);
      const headingPath = [...ancestors.map(s => s.title), plain(heading)];
      const identity = JSON.stringify(headingPath.map(title => title.normalize('NFC')));
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const section: Section = {
        id: `${documentId}:section:${identity}:${occurrence}`, title: plain(heading),
        path: headingPath, depth,
        start: startOf(heading), end: markdown.length,
      };
      ancestors.push(section); sections.push(section);
    }
    const textSpans: TextSpan[] = [];
    const wikiLinks: ParsedWikiLink[] = [];
    const media: MediaReference[] = [];
    const definitions = new Map<string, string>();
    const collectDefinitions = (node: AstNode): void => {
      if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier, node.url);
      node.children?.forEach(collectDefinitions);
    };
    collectDefinitions(tree);
    const scan = (node: AstNode, blockId: string): void => {
      if (node.type === 'image' || node.type === 'imageReference') {
        const source = node.url ?? (node.identifier ? definitions.get(node.identifier) : undefined);
        if (source) media.push({ source, alt: node.alt ?? '', start: startOf(node), end: endOf(node), sectionId: sections.findLast(s => s.start <= startOf(node))!.id });
      }
      if (ignored.has(node.type)) return;
      if (['paragraph', 'heading', 'tableCell'].includes(node.type)) blockId = `${documentId}:block:${startOf(node)}`;
      if (node.type === 'text') {
        const start = startOf(node), end = endOf(node);
        const source = markdown.slice(start, end);
        const sectionId = sections.findLast(s => s.start <= start)!.id;
        const exclusions: { start: number; end: number }[] = [];
        for (const match of source.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
          if (escaped(source, match.index)) continue;
          const absoluteStart = start + match.index;
          const absoluteEnd = absoluteStart + match[0].length;
          exclusions.push({ start: absoluteStart, end: absoluteEnd });
          // Obsidian embeds are attachment/content rendering, not author link boosts.
          const split = match[1]!.indexOf('|');
          const target = (split < 0 ? match[1]! : match[1]!.slice(0, split)).trim();
          const label = split < 0 ? target : match[1]!.slice(split + 1);
          if (source[match.index - 1] === '!') {
            media.push({ source: target, alt: split < 0 || /^\d+(?:x\d+)?$/.test(label) ? '' : label, start: absoluteStart - 1, end: absoluteEnd, sectionId });
            continue;
          }
          wikiLinks.push({ start: absoluteStart, end: absoluteEnd, target, label, sectionId, blockId });
        }
        for (const match of source.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/g)) exclusions.push({ start: start + match.index, end: start + match.index + match[0].length });
        exclusions.sort((a, b) => a.start - b.start);
        let cursor = start;
        for (const excluded of exclusions) {
          if (cursor < excluded.start) textSpans.push({ start: cursor, end: excluded.start, sectionId, blockId });
          cursor = Math.max(cursor, excluded.end);
        }
        if (cursor < end) textSpans.push({ start: cursor, end, sectionId, blockId });
      } else node.children?.forEach(child => scan(child, blockId));
    };
    scan(tree, `${documentId}:root`);
    return { title, names, sections, textSpans, wikiLinks, parserVersion: this.version, warnings, media, contentStart: yaml ? endOf(yaml) : bom };
  }
}
