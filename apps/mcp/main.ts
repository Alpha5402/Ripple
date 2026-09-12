import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NodeWorkspace } from '../../packages/host/node-workspace.js';
import { createKnowledgeMcpServer } from '../../packages/integrations/mcp/server.js';

const { values } = parseArgs({ options: { vault: { type: 'string', default: 'fixtures/showcase' }, 'state-dir': { type: 'string', default: '.ripple/mcp' }, embedding: { type: 'string' } } });
const host = await NodeWorkspace.open(resolve(values.vault), { stateDir: resolve(values['state-dir']), readOnly: true });
if (values.embedding) { try { await host.configureEmbedding(resolve(values.embedding)); } catch { console.error('Ripple: embedding unavailable; deterministic knowledge remains available.'); } }
const server = createKnowledgeMcpServer(host.service);
const transport = new StdioServerTransport();
let closing = false;
async function close() { if (closing) return; closing = true; await server.close(); await host.close(); }
process.stdin.on('end', () => { void close().finally(() => process.exit(0)); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void close().finally(() => process.exit(0)); });
await server.connect(transport);
console.error(`Ripple MCP ready: ${host.service.listDocuments().length} documents; source access is read-only.`);
