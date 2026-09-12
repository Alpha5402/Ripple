import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { HarnessKnowledge } from './knowledge.js';
import { serializeOperationError } from '../../core/errors.js';

/** Local human control surface. Agent tools do not receive this interface. */
export async function startKnowledgePanel(knowledge: HarnessKnowledge, options: { port: number; webDir: string; frameOrigin: string }) {
  const frame = new URL(options.frameOrigin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(frame.hostname) || frame.protocol !== 'http:' || frame.origin !== options.frameOrigin) throw new Error('DSH panel frameOrigin must be an exact local HTTP origin');
  const webDir = resolve(options.webDir);
  let origin = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${frame.origin}`);
    try {
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/api') {
        if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return; }
        let body = ''; for await (const part of request) { body += part; if (body.length > 100000) { response.writeHead(413).end(); return; } }
        const result = knowledge.human(JSON.parse(body));
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, result })); return;
      }
      if (request.method !== 'GET' || url.pathname === '/knowledge.json') { response.writeHead(404).end(); return; }
      const file = resolve(webDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(webDir + sep)) { response.writeHead(404).end(); return; }
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      const content = await readFile(file); response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); response.end(content);
    } catch (error) { response.statusCode = 400; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: false, error: serializeOperationError(error) })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
