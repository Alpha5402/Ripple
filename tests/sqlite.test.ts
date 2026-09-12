import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { KnowledgeService } from '../packages/core/service.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../packages/core/embedding/config.js';
import type { EmbeddingProvider } from '../packages/core/embedding/model.js';
import { SqliteStorage, NodeIdentityProvider, RemarkMarkdownParser, openSqliteVault } from '../packages/adapters/node/index.js';
import { openVault } from '../packages/adapters/filesystem/workspace.js';
import { KernelHttpHandler } from '../apps/http-kernel/handler.js';
import { retrieveSemanticCandidates } from '../packages/core/relation/semantic-candidate.js';
import { applyRelationBoundary, defaultBoundaryConfig } from '../packages/core/relation/relation-boundary.js';

const create = (storage: SqliteStorage, parser = new RemarkMarkdownParser()) => new KnowledgeService({ storage, search: storage, parser, identity: new NodeIdentityProvider() });
const provider: EmbeddingProvider = { descriptor: { model: 'fixture', revision: '1', dimensions: 3, normalized: true, modalities: ['text'], maxInputTokens: 512, representation: 'fixture', tokenizer: 'characters' }, countTokens: async inputs => inputs.map(i => i.text.length), embed: async inputs => inputs.map(i => i.text.includes('island') ? [0, 1, 0] : [1, 0, 0]) };
const code = (expected: string) => (error: unknown): boolean => (error as { code: string }).code === expected;

test('SQLite commits documents, declarations, score policy and exact vector bytes; restart reuses cache without losing identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ripple-sqlite-'));
  try {
    let storage = new SqliteStorage(join(dir, 'kernel.sqlite')), service = create(storage);
    service.ingestDocuments([{ id: 'a', path: 'Alpha.md', markdown: '# Alpha\nBeta and asynchronous continuation.' }, { id: 'b', path: 'Beta.md', markdown: '# Beta\nCompletion callback.' }]);
    service.setRelationOverride('a', 'b', { pinned: true, note: 'human intent' });
    service.setScorePolicy({ ...service.scorePolicy, version: 'saved-policy', explicitBoost: 0.12 });
    service.configureEmbedding(provider); await service.indexEmbeddings();
    const before = service.exportState(), snapshot = service.createExplorationSnapshot('a'); storage.close();
    storage = new SqliteStorage(join(dir, 'kernel.sqlite')); service = create(storage);
    assert.equal(service.capabilities.semantic, 'not-configured');
    assert.equal(service.scorePolicy.version, 'saved-policy');
    assert.deepEqual(service.listDocuments(), before.documents); assert.deepEqual(service.exportUserDeclarations(), before.declarations);
    service.configureEmbedding(provider);
    assert.deepEqual(service.exportEmbeddingCache()?.spaces, before.embedding?.spaces);
    assert.equal((await service.indexEmbeddings()).encoded, 0);
    assert.equal(service.getVisibleRelations(snapshot).invalidatedCount, 0);
    service.removeDocument('b'); service.ingestDocument({ id: 'b', path: 'Beta.md', markdown: '# Beta\nReplacement.' });
    assert.equal(service.getNode('b')?.revision, 2); assert.equal(service.getVisibleRelations(snapshot).invalidatedCount, 1); storage.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('SQLite FTS finds Chinese words and requires case-sensitive, complete code symbols and model IDs in exact mode', () => {
  const storage = new SqliteStorage(':memory:'), service = create(storage);
  service.ingestDocuments([
    { id: 'a', path: 'Runtime.md', markdown: '# 执行上下文\n词法作用域决定标识符的查找。调用 `Array.from()`、`C++` 与 `Qwen3.5-2B`。' },
    { id: 'b', path: 'Other.md', markdown: '# 差异\n调用 `Array.fromAsync()`。型号 `Qwen3.5-2B-Instruct`、`qwen3.5-2b`。' },
  ]);
  assert.deepEqual(service.search('词法作用域').map(h => h.documentId), ['a']);
  for (const q of ['Array.from', 'C++', 'Qwen3.5-2B']) assert.deepEqual(service.search(q, { mode: 'exact' }).map(h => h.documentId), ['a']);
  assert.equal(service.search('Qwen3.5-2B', { mode: 'literal' }).length, 2);
  assert.equal(service.search('++', { mode: 'literal' }).length, 1);
  assert.deepEqual(service.search('不存在的文本'), []);
  assert.throws(() => service.search('a', { limit: -1 }), code('INVALID_INPUT'));
  service.ingestDocument({ id: 'a', path: 'Runtime.md', markdown: '# Replacement\nRemoved previous words.' });
  assert.equal(service.search('词法作用域').length, 0);
  service.removeDocument('b'); assert.equal(service.search('Qwen3.5-2B', { mode: 'literal' }).length, 0); storage.close();
});

test('optimistic conflicts roll back core state, declarations and FTS together; closed and future-schema errors are typed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ripple-conflict-')), path = join(dir, 'db.sqlite');
  try {
    const first = new SqliteStorage(path), left = create(first), second = new SqliteStorage(path), right = create(second);
    left.ingestDocument({ id: 'a', path: 'One.md', markdown: '# One\nCommitted.' });
    assert.throws(() => right.ingestDocument({ id: 'b', path: 'Two.md', markdown: '# Two\nUncommitted.' }), code('STORAGE_CONFLICT'));
    assert.equal(right.listDocuments().length, 0); assert.throws(() => right.search('Committed'), code('STORAGE_CONFLICT'));
    second.close(); const check = new SqliteStorage(path); assert.equal(create(check).search('Uncommitted').length, 0); check.close();
    first.close(); assert.throws(() => first.load(), code('CLOSED'));
    const db = new DatabaseSync(path); db.exec('PRAGMA user_version=999;'); db.close();
    assert.throws(() => new SqliteStorage(path), code('STORAGE_SCHEMA'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('body-only edits reuse other reference projections; lazy semantic retrieval equals the exhaustive reference and stays symmetric', async () => {
  let parses = 0; const parser = new RemarkMarkdownParser();
  const storage = new SqliteStorage(':memory:');
  const service = new KnowledgeService({ storage, parser: { version: parser.version, parse: (...args) => { parses++; return parser.parse(...args); } }, identity: new NodeIdentityProvider() });
  service.ingestDocuments(Array.from({ length: 8 }, (_, i) => ({ id: String(i), path: `Topic${i}.md`, markdown: `# Topic${i}\n${i === 7 ? 'island' : 'related'} body.` })));
  assert.equal(parses, 8); service.configureEmbedding(provider, DEFAULT_EMBEDDING_CONFIG); await service.indexEmbeddings();
  for (const doc of service.listDocuments()) {
    const pool = retrieveSemanticCandidates(service.exportEmbeddingCache(), service.listDocuments(), doc.id);
    const boundary = applyRelationBoundary(pool, defaultBoundaryConfig(provider.descriptor.model));
    assert.deepEqual(service.getRelations(doc.id).map(r => r.id).sort(), boundary.decisions.filter(d => d.accepted).map(d => d.id).sort());
  }
  service.ingestDocument({ id: '0', path: 'Topic0.md', markdown: '# Topic0\nEdited body references Topic1.' });
  assert.equal(parses, 9); assert.equal(service.findMentions({ sourceDocumentId: '0', targetDocumentId: '1' }).length, 1); storage.close();
});

test('SQLite workspace imports legacy identities and declarations once, stays outside source symlinks and binds vault identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ripple-migrate-')), vault = join(dir, 'vault'), stateDir = join(dir, 'state');
  try {
    await mkdir(vault); await writeFile(join(vault, 'Alpha.md'), '# Alpha\nBeta'); await writeFile(join(vault, 'Beta.md'), '# Beta');
    const legacy = await openVault(vault, { stateDir });
    const [a, b] = legacy.service.listDocuments(); legacy.service.setRelationOverride(a!.id, b!.id, { hidden: true }); await legacy.save();
    const sql = await openSqliteVault(vault, { stateDir });
    assert.deepEqual(sql.service.listDocuments(), legacy.service.listDocuments()); assert.deepEqual(sql.service.exportUserDeclarations(), legacy.service.exportUserDeclarations()); sql.close();
    await symlink(vault, join(dir, 'alias')); await assert.rejects(openSqliteVault(vault, { stateDir: join(dir, 'alias', 'cache') }), code('INVALID_INPUT'));
    const other = join(dir, 'other'); await mkdir(other); await assert.rejects(openSqliteVault(other, { stateDir }), code('INVALID_INPUT'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('second HTTP Host exercises SDK focus, lens, evidence and back with the same frozen snapshot', () => {
  const storage = new SqliteStorage(':memory:'), service = create(storage);
  service.ingestDocuments([{ id: 'a', path: 'Alpha.md', markdown: '# Alpha\nBeta.' }, { id: 'b', path: 'Beta.md', markdown: '# Beta\n[[Alpha]]' }]);
  const handler = new KernelHttpHandler(service);
  const call = (method: string, path: string, body?: unknown): any => { const response = handler.handle(method, path, body); assert.equal(response.status, 200, JSON.stringify(response)); return response.body; };
  const { sessionId } = call('POST', '/v1/sessions'), path = `/v1/sessions/${sessionId}`;
  const focus = call('POST', path, { action: 'focus', documentId: 'a' });
  const lens = call('POST', path, { action: 'lens', value: 100 });
  const evidence = lens.visible.relations[0].signals[0].evidence[0];
  assert.equal(call('POST', '/v1/evidence', evidence).status, 'valid');
  call('POST', path, { action: 'focus', documentId: 'b' }); const back = call('POST', path, { action: 'back' });
  assert.equal(back.state.current.snapshot.id, focus.state.current.snapshot.id); assert.equal(back.state.current.snapshot.lensValue, 100);
  assert.equal(handler.handle('POST', path, { action: 'lens', value: 'bad' }).status, 400);
  call('DELETE', path); assert.equal(handler.handle('GET', path).status, 404); storage.close();
});

test('a failed provider activation or vector publish never advertises uncommitted semantic readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ripple-embedding-conflict-')), path = join(dir, 'db.sqlite');
  try {
    const first = new SqliteStorage(path), left = create(first);
    left.ingestDocuments([{ id: 'a', path: 'Alpha.md', markdown: '# Alpha\nCallback.' }, { id: 'b', path: 'Beta.md', markdown: '# Beta\nCompletion.' }]);
    const second = new SqliteStorage(path), right = create(second);
    left.configureEmbedding(provider);
    assert.throws(() => right.configureEmbedding(provider), code('STORAGE_CONFLICT'));
    assert.equal(right.capabilities.semantic, 'not-configured'); second.close();
    const third = new SqliteStorage(path), other = create(third);
    other.setRelationOverride('a', 'b', { hidden: true });
    await assert.rejects(left.indexEmbeddings(), code('STORAGE_CONFLICT'));
    assert.equal(left.getEmbeddingCoverage().readyUnits, 0); assert.equal(left.getRelations('a').length, 0);
    first.close(); third.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('damaged vector bytes are discarded as pending while durable declarations remain intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ripple-cache-repair-')), path = join(dir, 'db.sqlite');
  try {
    const storage = new SqliteStorage(path), service = create(storage);
    service.ingestDocument({ id: 'a', path: 'A.md', markdown: '# Alpha\nExample.' }); service.configureEmbedding(provider); await service.indexEmbeddings();
    storage.close();
    const db = new DatabaseSync(path); db.exec("UPDATE vectors SET vector=X'0001';"); db.close();
    const repaired = new SqliteStorage(path), reopened = create(repaired); reopened.configureEmbedding(provider);
    assert.equal(reopened.getEmbeddingCoverage().status, 'pending'); assert.equal(reopened.getEmbeddingCoverage().readyUnits, 0);
    assert.equal((await reopened.indexEmbeddings()).encoded, 1); assert.equal(reopened.getEmbeddingCoverage().status, 'ready'); repaired.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
