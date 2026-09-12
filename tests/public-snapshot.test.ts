import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeKernel, NodeIdentityProvider } from '../packages/adapters/node/index.js';
import { exportPublicBundle } from '../packages/adapters/public-snapshot/export.js';
import { PublicKnowledgeService } from '../packages/adapters/public-snapshot/service.js';
import { ExplorationSession } from '../packages/sdk/session.js';
import type { EmbeddingProvider } from '../packages/core/embedding/model.js';

test('public export rebuilds from an explicit whitelist and strips private identity, aliases, declarations and file paths', () => {
  const kernel = createNodeKernel();
  kernel.ingestDocuments([
    { id: 'private-uuid-a', path: 'secret-folder/A.md', markdown: '---\naliases: [InternalAlias]\nsecret: not-published\n---\n# Alpha\nBeta is related.\n' },
    { id: 'private-uuid-b', path: 'secret-folder/B.md', markdown: '# Beta\nAlpha is related.\n' },
    { id: 'private-uuid-c', path: 'PrivateSalary.md', markdown: '# PrivateSalary\nCONFIDENTIAL PAYROLL\n' },
  ]);
  kernel.importUserDeclarations({ schemaVersion: 1, aliases: [{ name: 'InternalOtherAlias', target: { documentId: 'private-uuid-b' } }], relations: { '["private-uuid-a","private-uuid-b"]': { pinned: true, note: 'confidential private note' } } });
  const bundle = exportPublicBundle(kernel, { title: 'Public notes', id: 'public-fixture', documents: [{ id: 'private-uuid-a', slug: 'alpha' }, { id: 'private-uuid-b', slug: 'beta' }] });
  const text = JSON.stringify(bundle);
  for (const secret of ['private-uuid', 'secret-folder', 'InternalAlias', 'InternalOtherAlias', 'PrivateSalary', 'CONFIDENTIAL', 'not-published', 'confidential private note']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(bundle.documents.map(d => d.path), ['alpha.md', 'beta.md']);
  const publicKernel = new PublicKnowledgeService(bundle, new NodeIdentityProvider());
  assert.equal(publicKernel.getRelations('alpha').length, 1); assert.deepEqual(publicKernel.getRelations('alpha')[0]!.override, {});
  assert.equal(publicKernel.resolveEntity('InternalAlias').status, 'missing');
  assert.equal(publicKernel.findMentions({ targetDocumentId: 'beta' })[0]?.sourceDocumentId, 'alpha');
});

test('public export fails closed on private aliases in body, unresolved links, absolute paths, keys, attachments and unsafe slugs', () => {
  for (const body of ['PrivateSalary is mentioned.', '[[PrivateSalary]]', '[[Missing]]', '/Users/alpha/private.md', 'sk-0123456789abcdefghijklmnop', '![chart](private.png)', '<img src="private.png">']) {
    const kernel = createNodeKernel(); kernel.ingestDocuments([{ id: 'a', path: 'Alpha.md', markdown: `# Alpha\n${body}\n` }, { id: 'p', path: 'PrivateSalary.md', markdown: '# PrivateSalary\nSecret' }]);
    assert.throws(() => exportPublicBundle(kernel, { title: 'Demo', id: 'demo', documents: [{ id: 'a', slug: 'alpha' }] }), { code: 'INVALID_INPUT' });
  }
  const kernel = createNodeKernel(); kernel.ingestDocument({ id: 'a', path: 'A.md', markdown: '# A\nSafe' });
  assert.throws(() => exportPublicBundle(kernel, { title: 'Demo', id: 'demo', documents: [{ id: 'a', slug: '../private' }] }), { code: 'INVALID_INPUT' });
});

test('precomputed semantic pairs use the same Lens/history protocol without vectors or keys; sandbox edits invalidate evidence', async () => {
  const source = createNodeKernel();
  source.ingestDocuments([{ id: 'a-source', path: 'Alpha.md', markdown: '# Alpha\nAn asynchronous outcome.\n' }, { id: 'b-source', path: 'Beta.md', markdown: '# Beta\nAn operation finishes later.\n' }, { id: 'p-source', path: 'Hidden.md', markdown: '# Hidden\nA private outcome.\n' }]);
  const provider: EmbeddingProvider = {
    descriptor: { model: 'fixture-only-not-a-model', revision: '1', dimensions: 2, normalized: true, modalities: ['text'], maxInputTokens: 512, representation: 'test', tokenizer: 'test' },
    countTokens: async inputs => inputs.map(i => i.text.length), embed: async inputs => inputs.map(() => [1, 0]),
  };
  source.configureEmbedding(provider); await source.indexEmbeddings();
  const bundle = exportPublicBundle(source, { title: 'Precomputed', id: 'precomputed', documents: [{ id: 'a-source', slug: 'alpha' }, { id: 'b-source', slug: 'beta' }] });
  assert.equal(bundle.semantic?.signals.length, 1);
  assert.ok(!JSON.stringify(bundle).includes('a-source')); assert.ok(!JSON.stringify(bundle).includes('p-source')); assert.ok(!JSON.stringify(bundle).includes('vector'));
  const service = new PublicKnowledgeService(bundle, new NodeIdentityProvider());
  const session = new ExplorationSession(service); session.focus('alpha'); const old = session.current!;
  assert.equal(session.visible().relations.length, 1);
  const relation = session.visible().relations[0]!; assert.equal(relation.signals[0]!.kind, 'semantic');
  for (const e of relation.signals[0]!.evidence) assert.equal(service.getEvidence(e).status, 'valid');
  session.setLens(100); session.focus('beta'); session.back(); assert.equal(session.current!.snapshot.lensValue, 100);
  const alpha = service.getNode('alpha')!;
  service.ingestDocument({ id: 'alpha', path: alpha.path, markdown: alpha.markdown + '\n[[Beta]]\n' });
  assert.equal(service.getVisibleRelations(old.snapshot).status, 'invalid');
  session.refresh(); assert.equal(session.visible().relations[0]?.signals[0]?.kind, 'explicit');
  assert.equal(service.getRelations('alpha').some(r => r.signals.some(s => s.kind === 'semantic')), false);
  assert.equal(source.getNode('a-source')!.revision, 1, 'visitor edit cannot mutate the source kernel');
  assert.equal(bundle.documents[0]!.markdown, alpha.markdown, 'visitor edit cannot mutate the published package');
});
