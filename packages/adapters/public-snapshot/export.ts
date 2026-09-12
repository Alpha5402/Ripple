import { KnowledgeService } from '../../core/service.js';
import { KernelError, type Document, type EvidenceLocator, type RelationSignal } from '../../core/model.js';
import { DEFAULT_SCORE_POLICY } from '../../core/relation.js';
import { activeSpace } from '../../core/embedding/relations.js';
import { NodeIdentityProvider } from '../runtime-node/index.js';
import { createNodeKernel } from '../node/index.js';
import type { PublicBundle } from './model.js';

/** A document is publishable only after explicit selection; private indexes/declarations are never serialized. */
export function exportPublicBundle(source: KnowledgeService, options: { title: string; id: string; documents: { id: string; slug: string }[] }): PublicBundle {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.id) || !options.title.trim() || options.title.length > 100 || !options.documents.length) throw new KernelError('INVALID_INPUT', 'Invalid public package manifest');
  const all = source.listDocuments(); const selected = new Set(options.documents.map(d => d.id));
  if (selected.size !== options.documents.length || new Set(options.documents.map(d => d.slug)).size !== selected.size) throw new KernelError('INVALID_INPUT', 'Duplicate public selection');
  const input = new Map<string, { source: Document; id: string; path: string; markdown: string }>();
  for (const item of options.documents) {
    const document = source.getNode(item.id);
    if (!document || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.slug)) throw new KernelError('INVALID_INPUT', 'Unknown document or unsafe public slug');
    input.set(item.id, { source: document, id: item.slug, path: `${item.slug}.md`, markdown: document.markdown.slice(document.parsed.contentStart ?? 0) });
  }
  const publicKernel = createNodeKernel();
  publicKernel.ingestDocuments([...input.values()].map(({ id, path, markdown }) => ({ id, path, markdown })));
  const publicNames = new Set(publicKernel.listDocuments().flatMap(doc => doc.parsed.names.map(n => n.name.normalize('NFC').toLocaleLowerCase())));
  // Aliases declared outside the published body are private by default, including aliases of a public target.
  const forbiddenNames = new Set([
    ...all.filter(doc => !selected.has(doc.id)).flatMap(doc => doc.parsed.names.map(n => n.name)),
    ...all.flatMap(doc => doc.parsed.names.filter(n => n.source === 'alias' || n.source === 'frontmatter').map(n => n.name)),
    ...source.exportUserDeclarations().aliases.map(a => a.name),
  ].map(n => n.normalize('NFC').toLocaleLowerCase()).filter(n => n && !publicNames.has(n)));
  const checkText = (text: string) => {
    const normalized = text.normalize('NFC').toLocaleLowerCase();
    if ([...forbiddenNames].some(name => normalized.includes(name))) throw new KernelError('INVALID_INPUT', '公开正文仍含私有名称或别名，请先整理发布副本。');
    if (/file:\/\/|(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i.test(text)) throw new KernelError('INVALID_INPUT', '公开内容包含本机路径或疑似凭据，已停止导出。');
  };
  checkText(options.title);
  for (const entry of input.values()) {
    checkText(entry.markdown);
    if (entry.source.parsed.media?.length || /<(?:img|video|audio|source|iframe|object|embed)\b/i.test(entry.markdown)) throw new KernelError('INVALID_INPUT', '该公开导出器仅发布文本；请移除附件引用或准备单独审核的发布副本。');
    const changes: { start: number; end: number; value: string }[] = [];
    for (const link of source.findWikiLinks({ sourceDocumentId: entry.source.id })) {
      if (link.resolution.status !== 'resolved' || !selected.has(link.resolution.candidates[0]!.documentId)) throw new KernelError('INVALID_INPUT', '公开正文包含非公开或无法唯一解析的链接。');
      const target = input.get(link.resolution.candidates[0]!.documentId)!;
      const parsed = entry.source.parsed.wikiLinks.find(l => l.start === link.evidence.start)!;
      const publicResolution = publicKernel.resolveEntity(parsed.target, entry.id);
      if (publicResolution.status === 'resolved' && publicResolution.candidates[0]?.documentId === target.id) continue;
      const heading = parsed.target.includes('#') ? `#${parsed.target.split('#').slice(1).join('#')}` : '';
      changes.push({ start: link.evidence.start - (entry.source.parsed.contentStart ?? 0), end: link.evidence.end - (entry.source.parsed.contentStart ?? 0), value: `[[${target.id}${heading}|${parsed.label}]]` });
    }
    for (const change of changes.sort((a, b) => b.start - a.start)) entry.markdown = entry.markdown.slice(0, change.start) + change.value + entry.markdown.slice(change.end);
  }
  // Rebuild from the final public text, not filtered original indexes.
  const finalKernel = createNodeKernel();
  finalKernel.ingestDocuments([...input.values()].map(({ id, path, markdown }) => ({ id, path, markdown })));
  const identity = new NodeIdentityProvider();
  const bundle: PublicBundle = { schemaVersion: 1, id: options.id, title: options.title, generatedAt: new Date().toISOString(), scorePolicy: { ...DEFAULT_SCORE_POLICY }, documents: [...input.values()].map(({ id, path, markdown }) => ({ id, path, markdown })) };
  const space = activeSpace(source.exportEmbeddingCache());
  if (space) {
    const spaceId = `public-${identity.hash(JSON.stringify(space.space)).slice(0, 24)}`;
    const remap = (locator: EvidenceLocator): EvidenceLocator => {
      const entry = input.get(locator.documentId)!; const doc = finalKernel.getNode(entry.id)!;
      const section = doc.parsed.sections.filter(s => s.start <= locator.start && s.end >= locator.end).sort((a, b) => b.depth - a.depth)[0];
      if (!section) throw new KernelError('INVALID_INPUT', 'Public evidence cannot be mapped');
      return { documentId: doc.id, revision: 1, sectionId: section.id, start: locator.start, end: locator.end };
    };
    const signals: RelationSignal[] = [];
    const relations = [...new Map([...selected].flatMap(id => source.getRelations(id, { includeHidden: true })).map(r => [r.id, r])).values()];
    for (const relation of relations) {
      if (!relation.nodes.every(id => input.has(id) && input.get(id)!.markdown === input.get(id)!.source.markdown)) continue;
      for (const signal of relation.signals) {
        if (signal.kind !== 'semantic' || !signal.semantic || signal.semantic.contributions.some(c => c.media.length || c.modalityPair !== 'text-text')) continue;
        signals.push({ kind: 'semantic', from: input.get(signal.from)!.id, to: input.get(signal.to)!.id, rawValue: signal.rawValue,
          evidence: signal.evidence.map(remap), semantic: { spaceId, strength: signal.semantic.strength, modalityPair: 'text-text', aggregation: signal.semantic.aggregation,
            contributions: signal.semantic.contributions.map(c => ({ cosine: c.cosine, modalityPair: 'text-text', evidence: c.evidence.map(remap) as [EvidenceLocator, EvidenceLocator], media: [],
              unitIds: c.evidence.map((e, index) => `${input.get(e.documentId)!.id}:unit:${identity.hash(c.unitIds[index]!).slice(0, 16)}`) as [string, string], unitHashes: [...c.unitHashes] as [string, string] })) } });
      }
    }
    const descriptor = space.space.descriptor;
    bundle.semantic = { descriptor: { model: descriptor.model, revision: descriptor.revision, dimensions: descriptor.dimensions, normalized: descriptor.normalized, modalities: [...descriptor.modalities], maxInputTokens: descriptor.maxInputTokens, representation: descriptor.representation, tokenizer: descriptor.tokenizer }, spaceId, signals, omittedChangedDocuments: [...input.values()].filter(d => d.markdown !== d.source.markdown).length };
    // Model descriptors are metadata, never endpoints or provider credentials.
    checkText(JSON.stringify(bundle.semantic.descriptor));
  }
  return bundle;
}
