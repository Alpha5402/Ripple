import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpEmbeddingProvider } from '../packages/adapters/embedding-http/index.js';
import { LocalMediaResolver } from '../packages/adapters/filesystem/media.js';
import { openVault } from '../packages/adapters/filesystem/workspace.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../packages/core/embedding/config.js';
import type { EmbeddingProvider, ModelDescriptor } from '../packages/core/embedding/model.js';
import { document, kernel } from './helpers.js';

const descriptor: ModelDescriptor = { model: 'cloud-fixture', revision: 'fixture-deployment-v1', dimensions: 2, normalized: false, modalities: ['text'], maxInputTokens: 512, representation: 'document-document/fixture', tokenizer: 'utf8-upper-bound-v1' };
const inputs = [{ text: 'first', images: [] }, { text: 'second', images: [] }];

test('cloud text adapter sends strings and bearer authorization, reorders indexed rows, and keeps keys outside persisted state', async () => {
  const requests: RequestInit[] = [];
  const provider = await HttpEmbeddingProvider.connect({ protocol: 'openai-compatible', baseUrl: 'https://fixture.example', apiKey: 'test-key-never-persist', descriptor,
    fetch: async (_url, init) => {
      requests.push(init!);
      const input = JSON.parse(init!.body as string).input as string[];
      return Response.json({ model: descriptor.model, data: input.map((_, i) => ({ index: i, embedding: [3, 4] })).reverse() });
    } });
  const vectors = await provider.embed(inputs, { signal: new AbortController().signal });
  assert.deepEqual(vectors, [[3, 4], [3, 4]]);
  assert.equal((requests[0]!.headers as Record<string, string>).authorization, 'Bearer test-key-never-persist');
  assert.equal(requests[0]!.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0]!.body as string).input, ['first', 'second']);
  const service = kernel(document('a', '# Alpha\nCloud text.'));
  service.configureEmbedding(provider); await service.indexEmbeddings();
  assert.ok(!JSON.stringify(service.exportEmbeddingCache()).includes('test-key-never-persist'));
  assert.deepEqual(service.exportEmbeddingCache()!.spaces[service.getEmbeddingCoverage().spaceId!]!.records[0]!.vector, [0.6, 0.8]);
});

test('text-only HTTP endpoint rejects image inputs before any request', async () => {
  let requests = 0;
  const provider = await HttpEmbeddingProvider.connect({ protocol: 'openai-compatible', baseUrl: 'https://fixture.example', descriptor,
    fetch: async () => { requests++; return Response.json({}); } });
  await assert.rejects(provider.embed([{ text: 'picture', images: [{ dataUrl: 'data:image/png;base64,AA==', contentHash: 'image', mimeType: 'image/png' }] }], { signal: new AbortController().signal }), /cannot receive/);
  assert.equal(requests, 0);
});

test('HTTP adapter rejects duplicate batch indexes and model changes instead of attaching vectors to the wrong units', async () => {
  for (const response of [
    { model: descriptor.model, data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] },
    { model: 'unexpected-model', data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1] }] },
  ]) {
    const provider = await HttpEmbeddingProvider.connect({ protocol: 'openai-compatible', baseUrl: 'https://fixture.example', descriptor, fetch: async () => Response.json(response) });
    await assert.rejects(provider.embed(inputs, { signal: new AbortController().signal }), /duplicate|different model/);
  }
});

test('Ripple HTTP handshake and tokenization bind requests to a model revision and representation', async () => {
  const multimodal = { ...descriptor, modalities: ['text', 'image'] as ('text' | 'image')[], tokenizer: 'fixture-tokenizer' };
  const paths: string[] = [];
  const provider = await HttpEmbeddingProvider.connect({ protocol: 'ripple', baseUrl: 'http://127.0.0.1:8787', fetch: async (url) => {
    paths.push(String(url));
    return String(url).endsWith('/model-info') ? Response.json(multimodal) : Response.json({ counts: [5, 6], revision: 'wrong-revision' });
  } });
  assert.deepEqual(provider.descriptor.modalities, ['text', 'image']);
  await assert.rejects(provider.countTokens(inputs, { signal: new AbortController().signal }), /revision/);
  assert.equal(paths.length, 2);
});

test('cloud HTTP requires HTTPS and rejects secrets embedded in endpoint URLs', async () => {
  for (const baseUrl of ['http://public.example', 'https://user:secret@public.example', 'https://public.example?key=secret']) {
    await assert.rejects(HttpEmbeddingProvider.connect({ protocol: 'openai-compatible', baseUrl, descriptor }), /HTTPS|credentials/);
  }
});

test('provider HTTP error messages do not echo response bodies containing secrets or private inputs', async () => {
  const provider = await HttpEmbeddingProvider.connect({ protocol: 'openai-compatible', baseUrl: 'https://fixture.example', descriptor,
    fetch: async () => Response.json({ error: 'private-document and credential' }, { status: 401 }) });
  await assert.rejects(provider.embed(inputs, { signal: new AbortController().signal }), error => {
    assert.match((error as Error).message, /401/); assert.ok(!(error as Error).message.includes('private-document')); return true;
  });
});

test('local image resolver reads allowed attachments but refuses symlink escapes and remote URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ripple-media-'));
  try {
    const vault = join(directory, 'vault'); await mkdir(vault); await mkdir(join(vault, 'Attachments'));
    await writeFile(join(vault, 'Attachments/test.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(directory, 'outside.png'), 'outside');
    await symlink(join(directory, 'outside.png'), join(vault, 'escape.png'));
    const service = kernel(document('a', '# Alpha\n![picture](Attachments/test.png)'));
    const doc = service.getNode('a')!, reference = doc.parsed.media![0]!;
    const resolver = new LocalMediaResolver(vault);
    const image = await resolver.resolve(doc, reference, new AbortController().signal);
    assert.equal(image.mimeType, 'image/png'); assert.match(image.dataUrl, /^data:image\/png;base64,/);
    await assert.rejects(resolver.resolve(doc, { ...reference, source: 'escape.png' }, new AbortController().signal), /escapes/);
    await assert.rejects(resolver.resolve(doc, { ...reference, source: 'https://remote.example/image.png' }, new AbortController().signal), /not fetched/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('vector cache is reusable across process-like reloads and can be deleted without losing user declarations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ripple-vector-cache-'));
  try {
    const vault = join(directory, 'vault'), stateDir = join(directory, 'state'); await mkdir(vault);
    await writeFile(join(vault, 'Alpha.md'), '# Alpha\nBeta'); await writeFile(join(vault, 'Beta.md'), '# Beta');
    let calls = 0;
    const provider: EmbeddingProvider = { descriptor, countTokens: async items => items.map(i => i.text.length), embed: async items => { calls += items.length; return items.map(() => [1, 0]); } };
    const first = await openVault(vault, { stateDir }); first.service.configureEmbedding(provider);
    await first.service.indexEmbeddings();
    const ids = first.service.listDocuments().map(doc => doc.id);
    first.service.setRelationOverride(ids[0]!, ids[1]!, { note: 'durable intent' }); await first.save();
    assert.equal(calls, 2);
    const second = await openVault(vault, { stateDir }); second.service.configureEmbedding(provider);
    assert.equal((await second.service.indexEmbeddings()).encoded, 0); assert.equal(calls, 2);
    const cachePath = join(stateDir, 'cache/embeddings.json');
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    cache.spaces[cache.activeSpaceId].records[0].vector = [0, 0];
    await writeFile(cachePath, JSON.stringify(cache));
    const repaired = await openVault(vault, { stateDir }); repaired.service.configureEmbedding(provider);
    assert.equal((await repaired.service.indexEmbeddings()).encoded, 1, 'only the damaged cached vector is recomputed');
    await rm(join(stateDir, 'cache'), { recursive: true });
    const third = await openVault(vault, { stateDir }); third.service.configureEmbedding(provider);
    assert.equal((await third.service.indexEmbeddings()).encoded, 2);
    assert.match(await readFile(join(stateDir, 'user-relations.json'), 'utf8'), /durable intent/);
    assert.equal(third.service.getRelations(ids[0]!)[0]!.override.note, 'durable intent');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
