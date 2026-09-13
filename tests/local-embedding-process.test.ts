import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalEmbeddingProcess } from '../packages/host/local-embedding-process.js';
import { LOCAL_EMBEDDING_REVISION as revision, isManagedEmbeddingUrl } from '../packages/host/local-embedding.js';
const python = spawnSync('python3', ['-c','import sys;print(sys.executable)'], {encoding:'utf8'}).stdout?.trim();
const source = `import http.server,json,argparse,os,time
p=argparse.ArgumentParser();p.add_argument('--port',type=int);a,_=p.parse_known_args()
with open('starts.log','a') as f:f.write('start\\n')
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'status':'ready','model':'tencent/WeMM-Embedding-2B','revision':'${revision}'}).encode())
 def log_message(self,*args):pass
http.server.HTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
`;
async function unusedPort() { const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port; }
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'ripple-service-'));
  await mkdir(join(root,'venv/bin'),{recursive:true});await symlink(python!,join(root,'venv/bin/python'));
  await mkdir(join(root,'models',revision),{recursive:true});await writeFile(join(root,'models',revision,'model.safetensors'),'fixture');await writeFile(join(root,'models',revision,'config.json'),'{}');
  const serverScript=join(root,'server.py');await writeFile(serverScript,source);
  const options={stateDir:join(root,'state'),serverScript,candidates:[root],port:await unusedPort(),timeoutMs:8000};
  return {root,options};
}
test('local service deduplicates starts, stops its child and restores runtime/autostart preferences', {skip:!python}, async()=>{
 const f=await fixture();let manager=new LocalEmbeddingProcess(f.options);
 try {
  assert.equal((await manager.initialize()).status,'stopped');assert.equal(manager.restoreOnLaunch,false);
  const first=manager.start();assert.equal(manager.start(),first);assert.equal((await first).status,'ready');assert.equal(manager.state.managed,true);
  assert.equal((await readFile(join(f.root,'starts.log'),'utf8')).trim(),'start');
  await manager.stop();assert.equal(manager.state.status,'stopped');
  manager=new LocalEmbeddingProcess({...f.options,candidates:[]});await manager.initialize();assert.equal(manager.restoreOnLaunch,true);
  if(manager.restoreOnLaunch)await manager.start();assert.equal(manager.state.status,'ready');
  assert.equal((await readFile(join(f.root,'starts.log'),'utf8')).trim().split('\n').length,2);
  await manager.setAutoStart(false);await manager.stop();
  manager=new LocalEmbeddingProcess(f.options);await manager.initialize();assert.equal(manager.restoreOnLaunch,false);
 }finally{await manager.stop();await rm(f.root,{recursive:true,force:true});}
});
test('an existing compatible service is reused and never terminated by another manager', {skip:!python}, async()=>{
 const f=await fixture(), owner=new LocalEmbeddingProcess(f.options), other=new LocalEmbeddingProcess({...f.options,stateDir:join(f.root,'other'),candidates:[]});
 try {await owner.initialize();await owner.start();await other.initialize();assert.equal((await other.start()).managed,false);await other.stop();assert.equal((await owner.refresh()).status,'ready');assert.equal((await readFile(join(f.root,'starts.log'),'utf8')).trim(),'start');}
 finally{await owner.stop();await rm(f.root,{recursive:true,force:true});}
});
test('busy or incompatible local ports do not launch another model process', {skip:!python}, async()=>{
 const f=await fixture(),server=createServer((_req,res)=>{res.end('{}');});await new Promise<void>(r=>server.listen(f.options.port,'127.0.0.1',r));const manager=new LocalEmbeddingProcess(f.options);
 try{await manager.initialize();await assert.rejects(manager.start(),/端口/);assert.equal(manager.state.managed,false);await assert.rejects(readFile(join(f.root,'starts.log')));}
 finally{await new Promise<void>(r=>server.close(()=>r()));await rm(f.root,{recursive:true,force:true});}
});
test('startup failure and cancellation release the process and permit a later retry', {skip:!python}, async()=>{
 const f=await fixture(),manager=new LocalEmbeddingProcess(f.options);
 try{
  await manager.initialize();await writeFile(f.options.serverScript,"print('fixture failure',flush=True)\nraise SystemExit(17)\n");
  await assert.rejects(manager.start(),/17/);assert.match(manager.state.log,/fixture failure/);assert.equal(manager.state.managed,false);
  await writeFile(f.options.serverScript,'import time\ntime.sleep(20)\n'+source);
  const pending=manager.start().catch(e=>e);while(manager.state.status!=='starting')await delay(10);
  await manager.stop();assert.match((await pending).message,/取消/);assert.equal(manager.state.status,'stopped');
  await writeFile(f.options.serverScript,source);assert.equal((await manager.start()).status,'ready');
 }finally{await manager.stop();await rm(f.root,{recursive:true,force:true});}
});
test('only explicit loopback Ripple endpoints qualify for managed startup',()=>{
 assert(isManagedEmbeddingUrl('http://localhost:8787/v1'));assert(isManagedEmbeddingUrl('http://127.0.0.1:8787'));
 for(const url of ['https://127.0.0.1:8787','http://example.com:8787','http://127.0.0.1:9999','http://user@127.0.0.1:8787','http://127.0.0.1:8787/remote'])assert.equal(isManagedEmbeddingUrl(url),false);
});
