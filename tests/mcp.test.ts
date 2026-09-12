import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real MCP stdio handshake, all tools, lens-independent references, evidence and shutdown', { timeout: 20000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), 'ripple-mcp-'));
  const source = await readFile('fixtures/vault/Promise.md', 'utf8');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('apps/mcp/main.ts'), '--vault', resolve('fixtures/vault'), '--state-dir', state], stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += String(data); });
  const client = new Client({ name: 'ripple-protocol-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools(); assert.equal(tools.tools.length, 7); assert.ok(tools.tools.every(t => t.annotations?.readOnlyHint && !t.annotations.destructiveHint));
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent as { indexRevision: number; data: any };
    };
    const resolved = await invoke('ripple_resolve', { name: 'Promise' }); assert.equal(resolved.data.status, 'resolved'); const id = resolved.data.candidates[0].documentId;
    const ambiguous = await invoke('ripple_resolve', { name: 'Cache' }); assert.equal(ambiguous.data.status, 'ambiguous');
    const docs = await invoke('ripple_documents', { limit: 2 }); assert.equal(docs.data.documents.length, 2); assert.equal(docs.data.nextOffset, 2);
    const before = await invoke('ripple_mentions', { targetDocumentId: id });
    const focus = await invoke('ripple_explore', { documentId: id, lens: 0 }); assert.equal(focus.data.visible.relations.length, 1);
    const after = await invoke('ripple_mentions', { targetDocumentId: id }); assert.deepEqual(after, before); assert.ok(before.data.total > 0);
    const relations = await invoke('ripple_relations', { documentId: id }); assert.ok(relations.data.relations.length > 0);
    const evidence = await invoke('ripple_evidence', { locator: before.data.references[0].evidence }); assert.equal(evidence.data.status, 'valid'); assert.match(evidence.data.text, /Promise/);
    const search = await invoke('ripple_search', { query: 'Promise', mode: 'exact' }); assert.ok(search.data.length > 0);
    const invalid = await client.callTool({ name: 'ripple_explore', arguments: { documentId: id, lens: -1 } }); assert.equal(invalid.isError, true);
    const stale = await client.callTool({ name: 'ripple_documents', arguments: { expectedIndexRevision: resolved.indexRevision + 100 } }); assert.equal(stale.isError, true);
    assert.equal(await readFile('fixtures/vault/Promise.md', 'utf8'), source);
    const pid = transport.pid; await client.close(); assert.equal(transport.pid, null); assert.ok(pid);
    assert.match(stderr, /Ripple MCP ready/);
  } finally { await client.close(); await rm(state, { recursive: true, force: true }); }
});
