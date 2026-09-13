import { createConnection } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../adapters/filesystem/atomic-json.js';
import { LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_REVISION, type LocalEmbeddingState } from './local-embedding.js';

interface Options { stateDir: string; serverScript: string; candidates: string[]; port?: number; timeoutMs?: number }
/** Own only children started here. Existing services and remote endpoints are never stopped. */
export class LocalEmbeddingProcess {
  private child: ChildProcess | undefined;
  private starting: Promise<LocalEmbeddingState> | undefined;
  private stopping: Promise<LocalEmbeddingState> | undefined;
  private cancelled = false;
  private persisted = false;
  private value: LocalEmbeddingState;
  constructor(private readonly options: Options) {
    this.value = { status: 'unavailable', baseUrl: `http://127.0.0.1:${options.port ?? 8787}`, autoStart: true, managed: false, message: '正在检查本地运行环境…', log: '' };
  }
  get state(): LocalEmbeddingState { return { ...this.value }; }
  get restoreOnLaunch(): boolean { return this.persisted && this.value.autoStart; }
  private python(root: string) { return join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  private model(root: string) { return join(root, 'models', LOCAL_EMBEDDING_REVISION); }
  private async validate(root: string): Promise<string> {
    if (!isAbsolute(root)) throw new Error('请选择本地运行环境目录');
    const canonical = await realpath(root);
    await access(this.python(canonical));
    await access(join(this.model(canonical), 'model.safetensors'));
    await access(join(this.model(canonical), 'config.json'));
    return canonical;
  }
  async initialize(): Promise<LocalEmbeddingState> {
    let saved: { runtimePath?: string; autoStart?: boolean } = {};
    try { const data = JSON.parse(await readFile(join(this.options.stateDir, 'local-embedding.json'), 'utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid local service settings'); saved = data; this.persisted = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.value.message = '本地服务设置无法读取，请重新选择运行环境'; }
    this.value.autoStart = saved.autoStart !== false;
    for (const path of [saved.runtimePath, ...this.options.candidates]) {
      if (!path || typeof path !== 'string') continue;
      try { this.value.runtimePath = await this.validate(path); break; } catch { /* Try another known local location. */ }
    }
    return this.refresh();
  }
  private async persist() {
    await mkdir(this.options.stateDir, { recursive: true });
    await atomicJson(join(this.options.stateDir, 'local-embedding.json'), { runtimePath: this.value.runtimePath, autoStart: this.value.autoStart });
    this.persisted = true;
  }
  async chooseRuntime(path: string): Promise<LocalEmbeddingState> {
    if (this.child || this.starting) throw new Error('请先停止由 App 启动的服务，再切换运行环境');
    try { this.value.runtimePath = await this.validate(path); }
    catch { throw new Error('目录中未找到已安装的 Python 环境与 WeMM 模型，请选择包含 venv 和 models 的 wemm 目录'); }
    await this.persist(); return this.refresh();
  }
  async setAutoStart(enabled: boolean): Promise<LocalEmbeddingState> { this.value.autoStart = enabled; await this.persist(); return this.state; }
  private async probe(): Promise<'ready' | 'offline' | 'occupied'> {
    try {
      const response = await fetch(`${this.value.baseUrl}/health`, { signal: AbortSignal.timeout(1200), redirect: 'error' });
      if (!response.ok) return 'occupied';
      const body = await response.json() as { status?: string; model?: string; revision?: string };
      return body.status === 'ready' && body.model === LOCAL_EMBEDDING_MODEL && body.revision === LOCAL_EMBEDDING_REVISION ? 'ready' : 'occupied';
    } catch (error) {
      if (error instanceof SyntaxError) return 'occupied';
      const occupied = await new Promise<boolean>(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(this.value.baseUrl).port) });
        const finish = (value: boolean) => { socket.destroy(); resolve(value); };
        socket.setTimeout(800); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(true));
      });
      return occupied ? 'occupied' : 'offline';
    }
  }
  async refresh(): Promise<LocalEmbeddingState> {
    if (this.starting || this.stopping) return this.state;
    const online = await this.probe();
    if (online === 'ready') Object.assign(this.value, { status: 'ready', managed: !!this.child, message: this.child ? '本地服务已就绪' : '已发现正在运行的本地服务，可直接连接' });
    else if (online === 'occupied') Object.assign(this.value, { status: 'error', message: '本地端口已有其他服务或需要认证，请检查服务地址；App 不会替换该服务' });
    else if (this.value.status !== 'error') Object.assign(this.value, { status: this.value.runtimePath ? 'stopped' : 'unavailable', managed: false, message: this.value.runtimePath ? '本地服务未启动' : '未找到已安装的 WeMM 环境，请选择运行环境目录' });
    return this.state;
  }
  start(): Promise<LocalEmbeddingState> {
    if (this.starting) return this.starting;
    if (this.stopping) return this.stopping.then(() => this.start());
    this.cancelled = false;
    const run = this.launch(); this.starting = run;
    void run.finally(() => { if (this.starting === run) this.starting = undefined; }).catch(() => {});
    return run;
  }
  private async launch(): Promise<LocalEmbeddingState> {
    try {
      const online = await this.probe();
      if (this.cancelled) throw new Error('启动已取消');
      if (online === 'ready') { await this.persist(); Object.assign(this.value, { status: 'ready', managed: !!this.child, message: this.child ? '本地服务已就绪' : '复用已有本地服务' }); return this.state; }
      if (online === 'occupied') throw new Error('本地端口已有其他服务或需要认证，未启动新进程');
      const root = this.value.runtimePath;
      if (!root) throw new Error('请先选择已安装的 WeMM 运行环境');
      await this.validate(root); await access(this.options.serverScript); await this.persist();
      if (this.cancelled) throw new Error('启动已取消');
      Object.assign(this.value, { status: 'starting', managed: true, message: '正在加载本地模型，首次启动可能需要一段时间…', log: '' });
      const child = spawn(this.python(root), [this.options.serverScript, '--model-dir', this.model(root), '--host', '127.0.0.1', '--port', new URL(this.value.baseUrl).port, '--device', 'auto', '--max-tokens', '1024', '--image-pixels', '65536'], {
        cwd: root, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1', HF_HOME: join(root, 'hf-cache') }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      const log = (data: Buffer) => { this.value.log = (this.value.log + data.toString()).slice(-6000); };
      child.stdout?.on('data', log); child.stderr?.on('data', log);
      let failure: Error | undefined;
      child.once('error', error => { failure = error; });
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = undefined;
        this.value.managed = false;
        if (!this.cancelled) { failure ??= new Error(`本地服务已退出（${code ?? signal}），请查看启动日志后重试`); this.value.status = 'error'; this.value.message = failure.message; }
      });
      const deadline = Date.now() + (this.options.timeoutMs ?? 180000);
      while (!this.cancelled && Date.now() < deadline) {
        if (failure) throw failure;
        if (await this.probe() === 'ready') { Object.assign(this.value, { status: 'ready', message: '本地服务已就绪' }); return this.state; }
        await delay(500);
      }
      throw new Error(this.cancelled ? '启动已取消' : '模型启动超时，请查看日志并重试');
    } catch (error) {
      if (this.child) await this.terminateChild();
      Object.assign(this.value, { status: this.cancelled ? 'stopped' : 'error', managed: false, message: (error as Error).message });
      throw error;
    }
  }
  private async terminateChild() {
    const child = this.child; if (!child) return;
    const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once('exit', () => resolve()); child.once('error', () => resolve()); } });
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, delay(1000, undefined, { ref: false })]); }
    if (this.child === child) this.child = undefined;
  }
  stop(): Promise<LocalEmbeddingState> {
    if (this.stopping) return this.stopping;
    if (!this.child && !this.starting) return this.refresh();
    this.cancelled = true; this.value.status = 'stopping';
    const run = (async () => { await this.terminateChild(); await this.starting?.catch(() => {}); Object.assign(this.value, { status: 'stopped', managed: false, message: '本地服务已停止' }); return this.state; })();
    this.stopping = run; void run.finally(() => { this.stopping = undefined; }).catch(() => {}); return run;
  }
}
