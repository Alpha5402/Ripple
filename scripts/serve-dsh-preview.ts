import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { source: { type: 'string' } } });
if (!values.source) throw new Error('Pass --source DSH checkout after validate:dsh and build:dsh');
const source = resolve(values.source), output = resolve('reports/local/dsh-ui'); await mkdir(output, { recursive: true });
await build({ entryPoints: [join(source, 'vendor/cordis/src/index.ts')], bundle: true, platform: 'browser', format: 'esm', outfile: join(output, 'cordis.mjs'), alias: { '@deepseek-ai/cosmokit': join(source, 'vendor/cosmokit/src/index.ts') } });
await cp('dist/dsh/client.mjs', join(output, 'client.mjs'));
const runtime = await import(pathToFileURL(resolve('reports/local/dsh-native/runtime.mjs')).href);
const ctx = new runtime.Context(); await ctx.plugin(runtime.SystemPrompt, {}); await ctx.plugin(runtime.Tools);
const fork = await ctx.plugin(runtime.RipplePlugin, { vault: resolve('fixtures/showcase'), stateDir: join(output, 'state'), panel: { port: 47321, webDir: resolve('dist/web'), frameOrigin: 'http://127.0.0.1:47322' } });
const ui = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH · Ripple 原生适配验收</title><style>body{font:15px -apple-system,sans-serif;margin:40px;background:#f7f8fa;color:#263345}button{padding:8px 14px;margin:8px;border:1px solid #dce2e9;border-radius:8px;background:white}pre{white-space:pre-wrap;font-size:12px}</style><h1>DSH · Ripple 原生适配验收</h1><p>真实 Cordis Context 与原生 Tools；这里的会话列表是测试替身，不连接 LLM。</p><button id="switch">切换到会话 B</button><button id="propose">让测试 Agent 提出建议</button><button id="dispose">卸载插件</button><button id="mount">重新挂载</button><p id="status"></p><pre id="result"></pre><script type="module" src="./preview.mjs"></script></html>`;
await writeFile(join(output, 'index.html'), ui);
await writeFile(join(output, 'preview.mjs'), `import {Context,Service} from './cordis.mjs';import * as plugin from './client.mjs';const ctx=new Context(),listeners=new Set();let current='qa-session-a';class Sessions extends Service{constructor(){super(ctx,'sessions');this.list={getSnapshot:()=>({current}),subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}}}}await ctx.plugin(Sessions);let fork;const status=()=>document.querySelector('#status').textContent='当前会话：'+current+' · 活跃订阅：'+listeners.size+' · Vue 面板根：'+document.querySelectorAll('[data-ripple-dsh-portal]').length;async function mount(){if(fork)return;fork=await ctx.plugin(plugin,{endpoint:'http://127.0.0.1:47321'});status()}document.querySelector('#switch').onclick=()=>{current=current==='qa-session-a'?'qa-session-b':'qa-session-a';for(const f of listeners)f();status()};document.querySelector('#dispose').onclick=async()=>{if(fork)await fork.dispose();fork=undefined;status()};document.querySelector('#mount').onclick=mount;document.querySelector('#propose').onclick=async()=>{const r=await fetch('/propose',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:current})});document.querySelector('#result').textContent=JSON.stringify(await r.json(),null,2)};await mount();`);
const server = createServer(async (req, res) => { try {
  if (req.headers.host !== '127.0.0.1:47322') { res.writeHead(403).end(); return; }
  if (req.url === '/propose' && req.method === 'POST') {
    if (req.headers.origin !== 'http://127.0.0.1:47322') { res.writeHead(403).end(); return; }
    let body = ''; for await (const part of req) { body += part; if (body.length > 1000) throw new Error('too large'); }
    const { sessionId } = JSON.parse(body); if (!['qa-session-a','qa-session-b'].includes(sessionId)) throw new Error('invalid session');
    const knowledge = ctx.rippleKnowledge.knowledge; const view = knowledge.context(sessionId);
    const result = await ctx.tools.execute({ callId: 'preview-proposal', name: 'ripple_propose_beyond', arguments: { expectedVersion: view.version, reason: '检查可见范围外的相关概念', limit: 2 }, agent: { id: sessionId }, signal: new AbortController().signal });
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result)); return;
  }
  const files: Record<string,string> = {'/':'index.html','/preview.mjs':'preview.mjs','/cordis.mjs':'cordis.mjs','/client.mjs':'client.mjs'};
  const file = files[req.url ?? '/']; if (!file) {res.writeHead(404).end();return;}
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'text/javascript');res.end(await readFile(join(output,file)));
} catch(e){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:(e as Error).message}));}});
server.listen(47322,'127.0.0.1',()=>console.log('DSH native Vue preview: http://127.0.0.1:47322'));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{void(async()=>{server.closeAllConnections();server.close();await fork.dispose();await ctx.fiber.dispose();process.exit(0);})();});
