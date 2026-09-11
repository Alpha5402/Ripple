import test from 'node:test';
import assert from 'node:assert/strict';
import { document, kernel } from './helpers.js';

test('natural CSRF/SSRF relation needs neither model nor author links; source stays byte-for-byte equal', () => {
  const markdown = '# CSRF\n\n😀 CSRF 有别于 SSRF。SSRF 不是 SSRFProxy。\n';
  const service = kernel(document('csrf', markdown), document('ssrf', '# SSRF'));
  const mentions = service.findMentions({ sourceDocumentId: 'csrf', targetDocumentId: 'ssrf' });
  assert.equal(mentions.length, 2);
  assert.deepEqual(mentions.map(m => m.decorate), [true, false]);
  assert.equal(mentions[0]!.evidence.start, markdown.indexOf('SSRF'));
  assert.equal(service.getEvidence(mentions[0]!.evidence).text, 'SSRF');
  assert.equal(service.getNode('csrf')!.markdown, markdown);
  assert.equal(service.getRelations('csrf')[0]!.score, 0.5);
});

test('Markdown AST excludes frontmatter, code, links, reference links, URLs, HTML attributes and embeds', () => {
  const source = `---
aliases: [SSRF]
---
# Source

\`SSRF\` [SSRF](https://example.com/SSRF) ![SSRF](SSRF.png)

\`\`\`js
SSRF
\`\`\`

[SSRF][ref] https://example.com/SSRF <https://example.com/SSRF>

[ref]: /SSRF

<div title="SSRF">SSRF</div>

![[SSRF]]

Visible SSRF.
`;
  // Deliberately do not register the source alias as the same target: it creates ambiguity only in the visible paragraph.
  const service = kernel(document('source', source), document('ssrf', '# SSRF'));
  const mentions = service.findMentions({ sourceDocumentId: 'source' }).filter(m => m.text === 'SSRF');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.evidence.start, source.lastIndexOf('SSRF'));
  assert.equal(mentions[0]!.resolution.status, 'ambiguous');
  assert.equal(service.findWikiLinks({ sourceDocumentId: 'source' }).length, 0);
});

test('filename, H1, frontmatter title and aliases all register without generic section aliases', () => {
  const service = kernel(document('target', '---\ntitle: Async Work\naliases:\n  - 微任务\n  - Microtask\n---\n# Job Queue\n\n## 概述\n内容', '目录/Queue.md'));
  for (const name of ['Queue', 'Job Queue', 'Async Work', '微任务', 'microtask']) assert.equal(service.resolveEntity(name).candidates[0]!.documentId, 'target');
  assert.equal(service.resolveEntity('概述').status, 'missing');
});

test('longest Chinese alias wins, while one-character and generic names need a deliberate rule', () => {
  const service = kernel(
    document('source', '# Source\n\n事件循环和事件，以及图与概述。'),
    document('loop', '---\naliases: [事件循环]\n---\n# Loop'),
    document('event', '# 事件'), document('short', '# 图'), document('generic', '# 概述'),
  );
  const mentions = service.findMentions({ sourceDocumentId: 'source' });
  assert.deepEqual(mentions.filter(m => m.text !== 'Source').map(m => m.text), ['事件循环', '事件']);
  const declarations = service.exportUserDeclarations();
  declarations.aliases.push({ name: '图', target: { documentId: 'short' }, allowShort: true });
  service.importUserDeclarations(declarations);
  assert.equal(service.findMentions({ targetDocumentId: 'short', sourceDocumentId: 'source' }).length, 1);
});

test('homonyms stay ambiguous, missing author paths never silently fall back to a same-name note', () => {
  const service = kernel(
    document('source', '# Source\n\nCache 与 [[missing/Cache|缓存]]，另见 [[one/Cache]]。'),
    document('a', '# Cache', 'one/Cache.md'), document('b', '# Cache', 'two/Cache.md'),
  );
  assert.equal(service.resolveEntity('Cache').status, 'ambiguous');
  assert.equal(service.findMentions({ sourceDocumentId: 'source' }).find(m => m.text === 'Cache')!.resolution.status, 'ambiguous');
  assert.deepEqual(service.findWikiLinks({ sourceDocumentId: 'source' }).map(l => l.resolution.status), ['missing', 'resolved']);
  assert.deepEqual(service.getRelations('source').map(r => r.nodes), [['a', 'source']]);
});

test('WikiLink target, custom label, section and relative path work independently of display text', () => {
  const service = kernel(
    document('source', '# Source\n\n[[Target|这类知识]] [[Target#细节]] [[../topic/Target.md#细节|查看]] [[#本节]]\n\n## 本节\n正文', 'notes/Source.md'),
    document('target', '# Target\n\n## 细节\n内容', 'topic/Target.md'),
  );
  const links = service.findWikiLinks({ sourceDocumentId: 'source' });
  assert.equal(links.length, 4);
  assert.ok(links.every(l => l.resolution.status === 'resolved'));
  assert.ok(links[1]!.resolution.candidates[0]!.sectionId);
  assert.equal(links[3]!.resolution.candidates[0]!.documentId, 'source');
  assert.equal(service.findMentions({ sourceDocumentId: 'source', targetDocumentId: 'target' }).length, 0);
  assert.equal(service.getRelations('source')[0]!.score, 0.3);
});

test('repeated heading targets are ambiguous; missing headings stay missing', () => {
  const service = kernel(document('source', '# Source\n[[Target#相同]] [[Target#不存在]]'), document('target', '# Target\n## 相同\n一\n## 相同\n二'));
  assert.deepEqual(service.findWikiLinks({ sourceDocumentId: 'source' }).map(l => l.resolution.status), ['ambiguous', 'missing']);
});

test('changing names and aliases re-resolves old documents, reverse queries include all matching mentions', () => {
  const service = kernel(document('source', '# Source\n\n微任务，新名字。'), document('target', '---\naliases: [微任务]\n---\n# Old'));
  assert.equal(service.findMentions({ targetDocumentId: 'target', sourceDocumentId: 'source' })[0]!.text, '微任务');
  service.ingestDocument(document('target', '# 新名字'));
  assert.equal(service.findMentions({ targetDocumentId: 'target', sourceDocumentId: 'source' })[0]!.text, '新名字');
  assert.equal(service.resolveEntity('微任务').status, 'missing');
  assert.equal(service.getNode('source')!.revision, 1);
});

test('delete and re-create invalidates evidence; stale input versions cannot overwrite newer content', () => {
  const service = kernel(document('source', '# Source\nTarget'), document('target', '# Target'));
  const locator = service.findMentions({ sourceDocumentId: 'source', targetDocumentId: 'target' })[0]!.evidence;
  service.ingestDocument({ ...document('source', '# Source\nChanged'), expectedRevision: 1 });
  assert.equal(service.getEvidence(locator).status, 'stale');
  assert.throws(() => service.ingestDocument({ ...document('source', '# Old'), expectedRevision: 1 }), /Revision conflict/);
  service.removeDocument('source');
  assert.equal(service.getEvidence(locator).status, 'missing');
  assert.equal(service.ingestDocument(document('source', '# Source\nTarget')).revision, 3);
  assert.equal(service.getEvidence(locator).status, 'stale');
});

test('batch ingest is atomic; same content in different files has independent IDs; unchanged ingest is idempotent', () => {
  const service = kernel(document('a', '# Shared'), document('b', '# Shared'));
  assert.equal(service.listDocuments().length, 2);
  const revision = service.indexRevision;
  assert.equal(service.reindexChanged([document('a', '# Shared')]).changedCount, 0);
  assert.equal(service.indexRevision, revision);
  assert.throws(() => service.ingestDocuments([document('c', '# Good'), document('d', '---\naliases: [broken\n---\n# Bad')]), /frontmatter/);
  assert.equal(service.getNode('c'), undefined);
  assert.equal(service.indexRevision, revision);
  assert.throws(() => service.ingestDocument(document('x', '# X', '../outside.md')), /escapes/);
});

test('explicit ID preserves identity across a known rename, and old path references become missing', () => {
  const service = kernel(document('source', '# Source\n[[old/Target]]'), document('target', '# Target', 'old/Target.md'));
  service.ingestDocument(document('target', '# Target', 'new/Target.md'));
  assert.equal(service.getNode('target')!.revision, 2);
  assert.equal(service.findWikiLinks({ sourceDocumentId: 'source' })[0]!.resolution.status, 'missing');
  assert.equal(service.getRelations('source').length, 0);
});

test('section aliases retain their intended heading across text insertion and become missing after heading removal', () => {
  const service = kernel(document('source', '# Source\n章节别名'), document('target', '# Target\n\n## Detail\n正文'));
  const section = service.resolveEntity('Target#Detail').candidates[0]!;
  const declarations = service.exportUserDeclarations();
  declarations.aliases.push({ name: '章节别名', target: section });
  service.importUserDeclarations(declarations);
  service.ingestDocument(document('target', '# Target\n\n插入一段文字\n\n## Detail\n正文'));
  assert.deepEqual(service.resolveEntity('章节别名').candidates[0], section);
  service.ingestDocument(document('target', '# Target\n\n## Different\n正文'));
  assert.equal(service.resolveEntity('章节别名').status, 'missing');
});

test('reserved prototype document IDs are rejected without corrupting version maps', () => {
  const service = kernel();
  for (const id of ['__proto__', 'constructor', 'toString']) assert.throws(() => service.ingestDocument(document(id, '# Title')), /reserved/);
  assert.equal(service.listDocuments().length, 0);
});
