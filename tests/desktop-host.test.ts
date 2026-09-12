import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspace } from '../packages/host/node-workspace.js';
import { completeLayout } from '../packages/host/layout.js';

async function sample() {
  const root = await mkdtemp(join(tmpdir(), 'ripple-h1-')); const vault = join(root, 'vault'); await mkdir(vault);
  const original = '\uFEFF---\r\naliases: [承诺]\r\n---\r\n# Promise\r\n\r\nMicrotask 是后续任务。\r\n\r\n## 第二节\r\nMicrotask 在检查点执行。\r\n';
  await writeFile(join(vault, 'Promise.md'), original); await writeFile(join(vault, 'Microtask.md'), '# Microtask\n\nPromise 使用微任务安排反应。\n');
  return { root, vault, stateDir: join(root, 'state'), original };
}
test('desktop save preserves untouched source and rejects stale, external, read-only and symlink writes', async () => {
  const s = await sample(); let host = await NodeWorkspace.open(s.vault, { stateDir: s.stateDir, readOnly: false, watch: false });
  try {
    let doc = host.service.listDocuments().find(d => d.parsed.title === 'Promise')!;
    const oldTime = (await stat(join(s.vault, 'Promise.md'))).mtimeMs;
    await host.command({ type: 'save', id: doc.id, expectedHash: doc.contentHash, markdown: doc.markdown });
    assert.equal(await readFile(join(s.vault, 'Promise.md'), 'utf8'), s.original); assert.equal((await stat(join(s.vault, 'Promise.md'))).mtimeMs, oldTime);
    const changed = s.original.replace('后续任务', '异步反应');
    await host.command({ type: 'save', id: doc.id, expectedHash: doc.contentHash, markdown: changed });
    assert.equal(await readFile(join(s.vault, 'Promise.md'), 'utf8'), changed); assert.equal(host.service.getNode(doc.id)!.revision, doc.revision + 1);
    await assert.rejects(host.command({ type: 'save', id: doc.id, expectedHash: doc.contentHash, markdown: 'stale' }), { code: 'CONFLICT' });
    doc = host.service.getNode(doc.id)!;
    await writeFile(join(s.vault, 'Promise.md'), changed + '\r\n外部修改\r\n');
    await assert.rejects(host.command({ type: 'save', id: doc.id, expectedHash: doc.contentHash, markdown: 'overwrite' }), { code: 'CONFLICT' });
    assert.match(await readFile(join(s.vault, 'Promise.md'), 'utf8'), /外部修改/);
    const external = join(s.root, 'outside.md'); await writeFile(external, 'untouched'); await rm(join(s.vault, 'Promise.md')); await symlink(external, join(s.vault, 'Promise.md'));
    doc = host.service.getNode(doc.id)!;
    await assert.rejects(host.command({ type: 'save', id: doc.id, expectedHash: doc.contentHash, markdown: 'overwrite' }), { code: 'INVALID_INPUT' });
    assert.equal(await readFile(external, 'utf8'), 'untouched');
    await host.close(); host = await NodeWorkspace.open(s.vault, { stateDir: s.stateDir, readOnly: true, watch: false });
    doc = host.service.listDocuments()[0]!;
    await assert.rejects(host.command({ type: 'save', id: doc.id, expectedHash: doc.contentHash, markdown: 'write' }), { code: 'INVALID_INPUT' });
    await assert.rejects(host.command({ type: 'focus', id: '../outside.md' }), { code: 'NOT_FOUND' });
    await assert.rejects(host.command({ type: 'lens', value: -1 }), { code: 'INVALID_INPUT' });
  } finally { await host.close(); await rm(s.root, { recursive: true, force: true }); }
});
test('desktop retains layout, camera, lens and reading across focus/back/restart; unavailable model preserves editing', async () => {
  const s = await sample(); let host = await NodeWorkspace.open(s.vault, { stateDir: s.stateDir, readOnly: false, watch: false });
  try {
    const [a, b] = host.service.listDocuments(); await host.command({ type: 'focus', id: a!.id });
    const layout = host.session.current!.layout;
    assert.deepEqual(completeLayout(host.session.current!), layout);
    await host.command({ type: 'lens', value: 90 });
    assert.deepEqual(host.session.current!.layout, layout);
    await host.command({ type: 'view', camera: { x: 50, y: -20, zoom: 1.5 }, reading: { documentId: a!.id, offset: 222 } });
    const before = host.session.current;
    await host.command({ type: 'focus', id: b!.id }); await host.command({ type: 'back' }); assert.deepEqual(host.session.current, before);
    const badConfig = join(s.root, 'bad-embedding.json'); await writeFile(badConfig, JSON.stringify({ provider: { protocol: 'ripple', baseUrl: 'http://127.0.0.1:1' } }));
    await assert.rejects(host.configureEmbedding(badConfig)); assert.equal(host.service.getIndexCoverage().deterministic.status, 'ready');
    await host.close(); host = await NodeWorkspace.open(s.vault, { stateDir: s.stateDir, readOnly: false, watch: false });
    assert.deepEqual(host.session.current, before);
    await host.command({ type: 'save', id: a!.id, expectedHash: a!.contentHash, markdown: a!.markdown + '\n[[Promise]]\n' });
    assert.equal(host.service.getNode(a!.id)!.revision, a!.revision + 1);
  } finally { await host.close(); await rm(s.root, { recursive: true, force: true }); }
});
test('real watcher observes additions, edits and removal, then closes without a live subscription', async () => {
  const s = await sample(); let notifications = 0;
  const host = await NodeWorkspace.open(s.vault, { stateDir: s.stateDir, readOnly: true, changed: () => notifications++ });
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 4000; while (!predicate()) { assert.ok(Date.now() < deadline, 'watcher update timed out'); await new Promise(r => setTimeout(r, 30)); } };
  try {
    await writeFile(join(s.vault, 'New.md'), '# New\nPromise\n'); await until(() => host.service.listDocuments().length === 3);
    const previousRevision = host.service.listDocuments().find(d => d.path === 'New.md')!.revision;
    const edited = '# New\nPromise and Microtask\n';
    await writeFile(join(s.vault, 'New.md'), edited); await until(() => { const current = host.service.listDocuments().find(d => d.path === 'New.md'); return current?.markdown === edited && current.revision > previousRevision; });
    await rm(join(s.vault, 'New.md')); await until(() => host.service.listDocuments().length === 2);
    assert.ok(notifications >= 3);
    await host.close(); const count = notifications; await writeFile(join(s.vault, 'After.md'), '# After'); await new Promise(r => setTimeout(r, 350)); assert.equal(notifications, count);
    await assert.rejects(host.command({ type: 'state' }), { code: 'CLOSED' });
  } finally { await rm(s.root, { recursive: true, force: true }); }
});
test('after the first user indexing request, saves automatically encode only changed units', async () => {
  const s = await sample(); const host = await NodeWorkspace.open(s.vault, { stateDir: s.stateDir, readOnly: false, watch: false });
  let encoded = 0;
  host.service.configureEmbedding({ descriptor: { model: 'fixture', revision: '1', dimensions: 2, normalized: true, modalities: ['text'], maxInputTokens: 512, representation: 'fixture', tokenizer: 'fixture' }, countTokens: async inputs => inputs.map(i => i.text.length), embed: async inputs => { encoded += inputs.length; return inputs.map(() => [1, 0]); } });
  const idle = async () => { const end = Date.now() + 3000; while (host.state().indexing) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 10)); } };
  try {
    await host.command({ type: 'index' }); await idle(); const initial = encoded;
    const doc = host.service.listDocuments().find(d => d.path === 'Promise.md')!;
    await host.command({ type: 'save', id: doc.id, expectedHash: doc.contentHash, markdown: doc.markdown + '## 新的一节\r\n只改变这个知识单元。\r\n' }); await idle();
    assert.equal(encoded, initial + 1); assert.equal(host.service.getIndexCoverage().semantic.status, 'ready');
    await host.command({ type: 'cancel-index' }); const updated = host.service.getNode(doc.id)!;
    await host.command({ type: 'save', id: doc.id, expectedHash: updated.contentHash, markdown: updated.markdown + '\r\n## 另一节\r\n暂停自动编码。\r\n' }); await idle();
    assert.equal(encoded, initial + 1, 'explicit cancellation disables automatic work');
  } finally { await host.close(); await rm(s.root, { recursive: true, force: true }); }
});
