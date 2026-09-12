import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspace } from '../packages/host/node-workspace.js';
import { WorkspaceHistory } from '../packages/host/workspace-history.js';
import { createPublicBridge } from '../packages/workbench/public-bridge.js';
import { DEFAULT_SCORE_POLICY } from '../packages/core/relation.js';
import type { EmbeddingConnection } from '../packages/host/embedding-connection.js';
import type { BrowserSnapshot } from '../packages/workbench/browser-workspaces.js';
import type { WorkbenchState } from '../packages/host/contract.js';

async function fixtureServer() {
  const requests: string[][] = [];
  const server = createServer(async (req, res) => { let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); requests.push(body.input); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'persistence-test', data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0, 0] })) })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const settings: EmbeddingConnection = { protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: '', model: 'persistence-test', revision: '1', maxInputTokens: 1024, chunkTokens: 512, batchSize: 1 };
  return { settings, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function until(predicate: () => boolean | Promise<boolean>) { const end = Date.now() + 5000; while (!await predicate()) { assert.ok(Date.now() < end, 'Timed out'); await new Promise(r => setTimeout(r, 20)); } }

test('desktop restarts with usable cached vectors and automatically indexes only changed and new content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ripple-persist-')); const vault = join(root, 'vault'); await mkdir(vault);
  await writeFile(join(vault, 'A.md'), '# Alpha\nOriginal alpha text.\n\n'); await writeFile(join(vault, 'B.md'), '# Beta\nOriginal beta text.');
  const server = await fixtureServer(); const options = { stateDir: join(root, 'state'), readOnly: true, watch: false };
  let host = await NodeWorkspace.open(vault, options);
  try {
    await host.command({ type: 'configure-embedding', settings: server.settings }); await host.command({ type: 'index' }); await until(() => !host.state().indexing);
    assert.equal(host.state().coverage.semantic.readyUnits, 2); const before = server.requests.length;
    await host.close(); host = await NodeWorkspace.open(vault, options);
    assert.equal(host.state().autoIndex, true); assert.equal(host.state().coverage.semantic.status, 'ready'); assert.equal(server.requests.length, before, 'restart must not probe or encode unchanged notes');
    await host.close(); await writeFile(join(vault, 'A.md'), '# Alpha\nOriginal alpha text.\n\n## Added\nA new section.');
    host = await NodeWorkspace.open(vault, options); await until(() => !host.state().indexing);
    assert.equal(server.requests.length, before + 1); assert.match(server.requests.at(-1)![0]!, /new section/); assert.equal(host.state().coverage.semantic.readyUnits, 3);
    await writeFile(join(vault, 'C.md'), '# Gamma\nA newly created note.'); await host.rescan(); await until(() => !host.state().indexing); assert.equal(server.requests.length, before + 2);
    await rm(join(vault, 'B.md')); await host.rescan(); await until(() => !host.state().indexing); assert.equal(host.state().documents.length, 2); assert.equal(host.state().coverage.semantic.readyUnits, 3);
    await host.command({ type: 'auto-index', enabled: false }); await host.close(); host = await NodeWorkspace.open(vault, options); assert.equal(host.state().autoIndex, false);
    assert.ok(!JSON.stringify(JSON.parse(await readFile(join(options.stateDir, 'embedding.json'), 'utf8'))).includes('apiKey'));
  } finally { await host.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test('browser snapshots restore vectors without network calls and source sync reuses stable document identity', async () => {
  const server = await fixtureServer(); let saved: BrowserSnapshot | undefined;
  const bundle = { schemaVersion: 1 as const, id: 'persist', title: 'test', generatedAt: '', scorePolicy: DEFAULT_SCORE_POLICY, documents: [{ id: 'a', path: 'A.md', markdown: '# Alpha\nOriginal text.\n\n' }, { id: 'b', path: 'B.md', markdown: '# Beta\nOther text.' }] };
  const save = async (snapshot: BrowserSnapshot) => { saved = structuredClone(snapshot); };
  let bridge = createPublicBridge(bundle, { save }); const state = async () => await bridge.command({ type: 'state' }) as WorkbenchState;
  try {
    await bridge.command({ type: 'configure-embedding', settings: server.settings }); await bridge.command({ type: 'index' }); await until(async () => !(await state()).indexing);
    await bridge.dispose(); const count = server.requests.length;
    bridge = createPublicBridge(bundle, { initial: saved!, save });
    assert.equal((await state()).coverage.semantic.readyUnits, 2); assert.equal(server.requests.length, count);
    await bridge.syncDocuments([{ path: 'A.md', markdown: '# Alpha\nOriginal text.\n\n## Added\nAdditional content.' }, { path: 'B.md', markdown: '# Beta\nOther text.' }]);
    await until(async () => !(await state()).indexing); assert.equal(server.requests.length, count + 1); assert.equal((await state()).documents.find(d => d.path === 'A.md')!.id, 'a');
    await bridge.command({ type: 'auto-index', enabled: false }); await bridge.dispose(); bridge = createPublicBridge(bundle, { initial: saved!, save }); assert.equal((await state()).autoIndex, false);
  } finally { await bridge.dispose(); await server.close(); }
});

test('authenticated browser cache stays readable after restart while credentials must be supplied again', async () => {
  const server = await fixtureServer(); let saved: BrowserSnapshot | undefined;
  const bundle = { schemaVersion: 1 as const, id: 'auth', title: 'auth', generatedAt: '', scorePolicy: DEFAULT_SCORE_POLICY, documents: [{ id: 'a', path: 'A.md', markdown: '# Alpha\nA private note.' }] };
  let bridge = createPublicBridge(bundle, { save: async s => { saved = structuredClone(s); } });
  try {
    await bridge.command({ type: 'configure-embedding', settings: { ...server.settings, apiKey: 'test-secret' } }); await bridge.command({ type: 'index' }); await until(async () => !(await bridge.command({ type: 'state' }) as WorkbenchState).indexing);
    await bridge.dispose(); assert.ok(!JSON.stringify(saved).includes('test-secret'));
    const count = server.requests.length; bridge = createPublicBridge(bundle, { initial: saved! });
    const state = await bridge.command({ type: 'state' }) as WorkbenchState; assert.equal(state.embeddingNeedsAuth, true); assert.equal(state.coverage.semantic.readyUnits, 1);
    await assert.rejects(bridge.command({ type: 'index' }), /API Key/); assert.equal(server.requests.length, count);
  } finally { await bridge.dispose(); await server.close(); }
});

test('recent desktop workspaces survive restart and canonical paths prevent symlink duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ripple-history-')); const vault = join(root, 'vault'); await mkdir(vault); await symlink(vault, join(root, 'alias'));
  try {
    const history = new WorkspaceHistory(join(root, 'settings')); await history.load(); const first = await history.remember(vault, true); await history.remember(join(root, 'alias'), false);
    const restarted = new WorkspaceHistory(join(root, 'settings')); await restarted.load(); assert.equal(restarted.list().length, 1); assert.equal(restarted.list()[0]!.id, first.id); assert.equal(restarted.list()[0]!.readOnly, false);
    await restarted.forget(first.id); await history.load(); assert.equal(history.list().length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
