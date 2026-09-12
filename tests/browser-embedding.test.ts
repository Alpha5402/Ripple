import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPublicBridge } from '../packages/workbench/public-bridge.js';
import { DEFAULT_SCORE_POLICY } from '../packages/core/relation.js';
import type { WorkbenchState } from '../packages/host/contract.js';
import type { EmbeddingConnection } from '../packages/host/embedding-connection.js';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'index completion timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('browser connection probes real HTTP, indexes notes, publishes semantic evidence and reuses vectors without exposing keys', async () => {
  const requests: { input: string[]; authorization?: string | undefined }[] = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    if (fail) { res.writeHead(401); res.end('private provider error must not leak'); return; }
    assert.equal(req.url, '/v1/embeddings');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ input: body.input, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'test-model', data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0, 0] })) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const bridge = createPublicBridge({ schemaVersion: 1, id: 'browser-test', title: 'test', generatedAt: '', scorePolicy: structuredClone(DEFAULT_SCORE_POLICY), documents: [
      { id: 'a', path: 'A.md', markdown: '# 苹果\n果树开花后结出甜美果实。' },
      { id: 'b', path: 'B.md', markdown: '# 收获\n秋天在农场采摘成熟作物。' },
    ] });
    const state = async () => await bridge.command({ type: 'state' }) as WorkbenchState;
    assert.equal((await state()).visible?.relations.length, 0);
    const settings: EmbeddingConnection = { protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-secret', model: 'test-model', revision: 'test-v1', maxInputTokens: 1024, chunkTokens: 512, batchSize: 1 };
    let events = 0; const unsubscribe = bridge.subscribe(() => events++);
    await bridge.command({ type: 'configure-embedding', settings });
    assert.deepEqual(requests[0]?.input, ['Ripple connection test']);
    assert.equal(requests[0]?.authorization, 'Bearer test-secret');
    assert.equal(requests.length, 1, 'connecting does not index any note');
    assert.ok(!JSON.stringify(await state()).includes('test-secret'));
    await bridge.command({ type: 'index' });
    await until(async () => !(await state()).indexing);
    const frozen = await state();
    assert.equal(frozen.visible?.status, 'stale');
    const frozenIds = frozen.current!.snapshot.candidateSet.map(r => r.id);
    await bridge.command({ type: 'lens', value: 100 });
    assert.deepEqual((await state()).current!.snapshot.candidateSet.map(r => r.id), frozenIds);
    await bridge.command({ type: 'refresh' });
    const ready = await state();
    assert.equal(ready.coverage.semantic.status, 'ready');
    assert.equal(ready.coverage.semantic.readyUnits, 2);
    assert.ok(ready.visible?.relations.some(r => r.signals.some(s => s.kind === 'semantic')));
    const signal = ready.visible!.relations[0]!.signals.find(s => s.kind === 'semantic')!;
    const evidence = await bridge.command({ type: 'evidence', locator: signal.evidence[0]! }) as { status: string };
    assert.equal(evidence.status, 'valid');
    assert.ok(events >= 2);
    const count = requests.length;
    await bridge.command({ type: 'index' }); await until(async () => !(await state()).indexing);
    assert.equal(requests.length, count, 'unchanged vectors are reused');
    fail = true;
    await assert.rejects(bridge.command({ type: 'configure-embedding', settings }), /认证失败/);
    assert.equal((await state()).coverage.semantic.status, 'ready', 'failed replacement preserves working index');
    unsubscribe();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('browser cancellation stops indexing and does not report successful completion', async () => {
  let indexingRequest = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.input[0] !== 'Ripple connection test') { indexingRequest = true; return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'cancel-test', data: [{ index: 0, embedding: [1,0] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as {port:number}).port;
    const bridge = createPublicBridge({ schemaVersion:1, id:'cancel', title:'cancel', generatedAt:'', scorePolicy:structuredClone(DEFAULT_SCORE_POLICY), documents:[{id:'a',path:'A.md',markdown:'# A\nSome text to encode.'}] });
    await bridge.command({type:'configure-embedding',settings:{protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${port}`,apiKey:'',model:'cancel-test',revision:'test',maxInputTokens:1024,chunkTokens:512,batchSize:1}});
    await bridge.command({type:'index'});
    await until(async()=>indexingRequest);
    await bridge.command({type:'cancel-index'});
    await until(async()=>!(await bridge.command({type:'state'}) as WorkbenchState).indexing);
    const state=await bridge.command({type:'state'}) as WorkbenchState;
    assert.equal(state.coverage.semantic.readyUnits,0);
    assert.ok(state.notices[0]?.includes('取消'));
  } finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('HTTP provider binds browser fetch to its global receiver', async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async function(this: unknown) {
    assert.equal(this, globalThis, 'browser fetch requires its global receiver');
    return new Response(JSON.stringify({model:'receiver-test',data:[{index:0,embedding:[1,0]}]}),{headers:{'content-type':'application/json'}});
  };
  try {
    const bridge = createPublicBridge({schemaVersion:1,id:'receiver',title:'receiver',generatedAt:'',scorePolicy:structuredClone(DEFAULT_SCORE_POLICY),documents:[]});
    await bridge.command({type:'configure-embedding',settings:{protocol:'openai-compatible',baseUrl:'https://embedding.example',apiKey:'',model:'receiver-test',revision:'test',maxInputTokens:1024,chunkTokens:512,batchSize:1}});
  } finally {globalThis.fetch=nativeFetch;}
});
