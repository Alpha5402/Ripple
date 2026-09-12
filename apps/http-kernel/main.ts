import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openSqliteVault } from '../../packages/adapters/node/index.js';
import { KernelHttpHandler } from './handler.js';
import { configureEmbeddingFromFile } from '../../packages/adapters/embedding-http/config.js';

const { values } = parseArgs({ options: { vault: { type: 'string', default: 'fixtures/vault' }, 'state-dir': { type: 'string', default: '.ripple/http-demo' }, port: { type: 'string', default: '4318' }, embedding: { type: 'string' }, index: { type: 'boolean', default: false } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const workspace = await openSqliteVault(resolve(values.vault), { stateDir: resolve(values['state-dir']) });
if (values.embedding) {
  try { await configureEmbeddingFromFile(workspace.service, values.embedding, values.vault); if (values.index) await workspace.service.indexEmbeddings(); }
  catch (error) { console.error(`Embedding unavailable: ${(error as Error).message}`); }
}
const handler = new KernelHttpHandler(workspace.service);
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status: number, body: unknown): void => { response.writeHead(status); response.end(JSON.stringify(body)); };
  // Loopback-only SDK demonstration. Browser cross-origin requests are not accepted.
  if (request.headers.origin) { send(403, { error: { code: 'ORIGIN', message: 'Cross-origin browser requests are disabled' } }); return; }
  if (request.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}` && request.headers.host !== `localhost:${(server.address() as { port: number }).port}`) { send(403, { error: { code: 'HOST', message: 'Unexpected host' } }); return; }
  try {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) { send(413, { error: { code: 'LIMIT', message: 'Request exceeds 256 KiB' } }); return; } chunks.push(chunk); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : undefined;
    const result = handler.handle(request.method ?? 'GET', request.url ?? '/', body);
    send(result.status, result.body);
  } catch { send(400, { error: { code: 'INVALID_INPUT', message: 'Invalid JSON request' } }); }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, documents: workspace.service.listDocuments().length })));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => { workspace.close(); process.exit(0); }));
