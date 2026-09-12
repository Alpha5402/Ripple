import { restoreEmbedding, type EmbeddingPreferences } from './embedding-preferences.js';
import { collectGlobalGraph } from './global-graph.js';
import { connectEmbedding, embeddingErrorMessage, type SafeEmbeddingConnection } from './embedding-connection.js';
import { watch, type FSWatcher } from 'chokidar';
import { readFile, realpath, rename, writeFile, rm, stat, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteVault } from '../adapters/filesystem/sqlite-workspace.js';
import { readVault } from '../adapters/filesystem/index.js';
import { atomicJson } from '../adapters/filesystem/workspace.js';
import { NodeIdentityProvider } from '../adapters/runtime-node/index.js';
import { configureEmbeddingFromFile } from '../adapters/embedding-http/config.js';
import { ExplorationSession } from '../sdk/session.js';
import { KernelError } from '../core/model.js';
import { commandSchema, type HostCommand, type ReadingDocument, type WorkbenchState } from './contract.js';
import { completeLayout, initialLens } from './layout.js';

export class NodeWorkspace {
  readonly session: ExplorationSession;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closing = false;
  private tail: Promise<unknown> = Promise.resolve();
  private indexing: Promise<unknown> | undefined;
  private notices: string[] = [];
  private embeddingConnection?: SafeEmbeddingConnection;
  private autoIndex = false;
  private preferences?: EmbeddingPreferences;
  private needsAuth = false;
  private pendingIndex = new Set<string>();
  private fullIndexRequested = false;
  private constructor(readonly root: string, private readonly workspace: Awaited<ReturnType<typeof openSqliteVault>>, readonly readOnly: boolean, private readonly changed: () => void) {
    this.session = new ExplorationSession(workspace.service);
    this.notices = workspace.sources.warnings;
  }
  static async open(root: string, options: { stateDir: string; readOnly: boolean; watch?: boolean; apiKey?: string; changed?: () => void }): Promise<NodeWorkspace> {
    const canonical = await realpath(root);
    const workspace = await openSqliteVault(canonical, { stateDir: options.stateDir, allMarkdown: true });
    const host = new NodeWorkspace(canonical, workspace, options.readOnly, options.changed ?? (() => {}));
    try {
      const saved = JSON.parse(await readFile(join(workspace.stateDir, 'session.json'), 'utf8'));
      host.session.importState(saved);
      if (host.session.current && !host.service.getNode(host.session.current.snapshot.focusNode)) host.session.importState({ schemaVersion: 1, current: null, backStack: [] });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') host.notices.push('上次探索记录无法恢复，已保留知识索引。'); }
    if (!host.session.current && host.service.listDocuments()[0]) host.focus(host.service.listDocuments()[0]!.id);
    if (options.watch !== false) {
      await host.startWatcher(false);
      await host.rescan();
    }
    try {
      const preferences = JSON.parse(await readFile(join(workspace.stateDir, 'embedding.json'), 'utf8')) as EmbeddingPreferences;
      host.service.configureEmbedding(restoreEmbedding(preferences, options.apiKey), preferences.config);
      host.preferences = preferences; host.embeddingConnection = preferences.settings;
      host.autoIndex = preferences.autoIndex; host.needsAuth = preferences.requiresAuth && !options.apiKey;
      if (host.needsAuth) host.notices.push('已恢复语义索引；请重新输入 API Key 后继续增量更新。');
      else if (host.autoIndex) host.indexPending();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') host.notices.push('已保留索引缓存，请重新连接模型以恢复语义关联。'); }
    return host;
  }
  get service() { return this.workspace.service; }
  private async startWatcher(polling: boolean): Promise<void> {
    if (this.closing) return;
    const watcher = watch(this.root, { ignoreInitial: true, ignored: path => relative(this.root, path).split(/[\\/]/).some(part => part.startsWith('.')), followSymlinks: false, usePolling: polling, interval: 500, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    this.watcher = watcher;
    let failed = false, ready = false;
    const fallback = async () => {
      await watcher.close();
      if (this.closing) return;
      if (polling) { this.notices = ['文件监听已中断，可用刷新按钮重新扫描。']; this.changed(); return; }
      this.notices = ['系统事件监听不可用，已改用轮询同步目录。'];
      await this.startWatcher(true); await this.rescan(); this.changed();
    };
    watcher.on('all', (_event, path) => {
      if (this.closing || !/\.md$/i.test(path)) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.enqueue(() => this.rescan()).catch(() => { this.notices = ['目录更新暂未完成，请刷新重试。']; this.changed(); }); }, 100);
    });
    await new Promise<void>(resolve => {
      watcher.once('ready', () => { ready = true; if (!failed) resolve(); });
      watcher.on('error', () => {
        if (failed || this.closing) return; failed = true;
        // Also handle systems that report an OS watcher error just after their ready event.
        void fallback().catch(() => { this.notices = ['目录同步暂不可用，请刷新重试。']; this.changed(); }).finally(() => { if (!ready) resolve(); });
      });
    });
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.tail.then(() => { if (this.closed) throw new KernelError('CLOSED', 'Workspace is closed'); return action(); });
    this.tail = task.catch(() => {}); return task;
  }
  private async persistSession(): Promise<void> { await atomicJson(join(this.workspace.stateDir, 'session.json'), this.session.exportState()); }
  private focus(id: string): void { const current = this.session.focus(id, { lensValue: this.session.current?.snapshot.lensValue ?? initialLens(this.service.getRelations(id)), visibleBudget: Math.max(1, this.service.listDocuments().length) }); this.session.setViewState({ layout: completeLayout(current), reading: { documentId: id, offset: 0 } }); }
  private async persistPreferences(): Promise<void> {
    if (this.preferences) { this.preferences.autoIndex = this.autoIndex; await atomicJson(join(this.workspace.stateDir, 'embedding.json'), this.preferences); }
  }
  private indexPending(): void {
    const coverage = this.service.getEmbeddingCoverage();
    const ids = this.service.listDocuments().filter(d => coverage.documents[d.id]?.status !== 'ready').map(d => d.id);
    if (ids.length && !this.needsAuth) this.startIndex(ids);
  }
  state(): WorkbenchState {
    return { workspaceId: this.root, autoIndex: this.autoIndex, embeddingNeedsAuth: this.needsAuth, syncStatus: '自动同步目录变化', label: basename(this.root), mode: 'desktop', readOnly: this.readOnly,
      documents: this.service.listDocuments().map(d => ({ id: d.id, path: d.path, title: d.parsed.title, revision: d.revision })),
      current: this.session.current, visible: this.session.current ? this.session.visible() : null,
      canBack: !!this.session.exportState().backStack.length, coverage: this.service.getIndexCoverage(), indexing: !!this.indexing, embeddingConnection: this.embeddingConnection, notices: [...this.notices] };
  }
  read(id: string): ReadingDocument {
    const document = this.service.getNode(id); if (!document) throw new KernelError('NOT_FOUND', '文档已不存在');
    return { document, mentions: this.service.findMentions({ sourceDocumentId: id }), links: this.service.findWikiLinks({ sourceDocumentId: id }) };
  }
  async configureEmbedding(file: string): Promise<void> {
    await this.enqueue(async () => {
      try { this.autoIndex = false; this.pendingIndex.clear(); this.fullIndexRequested = false; await configureEmbeddingFromFile(this.service, file, this.root); this.notices = ['模型已连接，可以开始增量索引。']; }
      catch (error) { this.notices = ['模型连接失败，阅读、保存和名称关系仍可使用。']; this.changed(); throw error; }
      this.changed();
    });
  }
  private startIndex(documentIds?: string[]): void {
    if (this.closing || this.needsAuth) return;
    if (documentIds === undefined) { this.autoIndex = true; this.fullIndexRequested = true; }
    else for (const id of documentIds) this.pendingIndex.add(id);
    if (this.indexing) return;
    const coverage = this.service.getEmbeddingCoverage();
    const ids = this.fullIndexRequested ? this.service.listDocuments().filter(d => coverage.documents[d.id]?.status !== 'ready').map(d => d.id) : [...this.pendingIndex].filter(id => this.service.getNode(id));
    this.pendingIndex.clear(); this.fullIndexRequested = false;
    if (ids.length === 0) { this.notices = [`已复用 ${coverage.readyUnits} 个片段，无需重新编码。`]; this.changed(); return; }
    const progress = setInterval(this.changed, 250);
    this.indexing = this.service.indexEmbeddings({ documentIds: ids }).then(report => { this.notices = [`语义索引：编码 ${report.encoded}，复用 ${report.reused}${report.cancelled ? '，已取消' : ''}。`]; })
      .catch(() => { this.notices = ['语义索引暂不可用，确定性关系不受影响。']; })
      .finally(() => { clearInterval(progress); this.indexing = undefined; this.changed(); if (this.autoIndex && (this.pendingIndex.size || this.fullIndexRequested)) this.startIndex([]); });
    this.changed();
  }
  async rescan(): Promise<void> {
    const sources = await readVault(this.root, { allMarkdown: true });
    const paths = new Set(sources.inputs.map(input => input.path));
    const before = this.service.indexRevision;
    const hashes = new Map(this.service.listDocuments().map(d => [d.id, d.contentHash]));
    this.service.removeDocuments(this.service.listDocuments().filter(doc => !paths.has(doc.path)).map(doc => doc.id));
    this.service.ingestDocuments(sources.inputs);
    if (this.service.indexRevision !== before) {
      if (this.session.current && !this.service.getNode(this.session.current.snapshot.focusNode)) {
        this.session.importState({ schemaVersion: 1, current: null, backStack: [] });
        const first = this.service.listDocuments()[0]; if (first) this.focus(first.id);
      }
      if (this.autoIndex) this.startIndex(this.service.listDocuments().filter(d => hashes.get(d.id) !== d.contentHash).map(d => d.id));
      this.changed();
    }
  }
  private async save(command: Extract<HostCommand, { type: 'save' }>): Promise<void> {
    if (this.readOnly) throw new KernelError('INVALID_INPUT', '该目录以只读模式打开');
    const doc = this.read(command.id).document;
    if (command.expectedHash !== doc.contentHash) throw new KernelError('CONFLICT', '文档已被修改，草稿已保留。请先查看磁盘版本。');
    const path = join(this.root, doc.path);
    const canonical = await realpath(path);
    const rel = relative(this.root, canonical);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || canonical !== path || (await lstat(path)).isSymbolicLink()) throw new KernelError('INVALID_INPUT', '无法写入目录外文件或符号链接');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let disk: string, mode: number;
    try { disk = (await handle.readFile()).toString('utf8'); mode = (await handle.stat()).mode; } finally { await handle.close(); }
    const identity = new NodeIdentityProvider();
    if (identity.hash(disk) !== command.expectedHash) { await this.rescan(); throw new KernelError('CONFLICT', '文件已在外部修改，草稿已保留。'); }
    if (disk === command.markdown) return;
    const temp = join(dirname(path), `.${basename(path)}.ripple-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, command.markdown, { encoding: 'utf8', mode: mode & 0o777, flag: 'wx' });
      // Check again immediately before the atomic replace; never overwrite an observed concurrent edit.
      if (await realpath(path) !== canonical || identity.hash(await readFile(path, 'utf8')) !== command.expectedHash) throw new KernelError('CONFLICT', '保存期间文件发生变化，草稿已保留。');
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
    try { this.service.ingestDocument({ id: doc.id, path: doc.path, markdown: command.markdown, expectedRevision: doc.revision }); }
    catch { this.notices = ['正文已保存，但索引更新失败；请刷新以重新同步。']; this.changed(); throw new KernelError('STORAGE', '正文已保存，索引需要刷新'); }
    if (this.autoIndex) this.startIndex([doc.id]);
    this.changed();
  }
  command(raw: unknown): Promise<unknown> {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return Promise.reject(new KernelError('INVALID_INPUT', 'Invalid workspace command'));
    const command = parsed.data;
    return this.enqueue(async () => {
      switch (command.type) {
        case 'state': return this.state();
      case 'global-graph': return collectGlobalGraph(this.service);
        case 'configure-embedding': {
          if (this.indexing) throw new KernelError('INVALID_INPUT', '请先停止索引，再更换模型');
          try {
            const connected = await connectEmbedding(command.settings);
            this.service.configureEmbedding(connected.provider, connected.config);
            this.embeddingConnection = connected.settings; this.needsAuth = false; this.autoIndex = this.autoIndex && !!this.preferences;
            this.preferences = { settings: connected.settings, descriptor: connected.provider.descriptor, config: connected.config, requiresAuth: !!command.settings.apiKey, autoIndex: this.autoIndex };
            await this.persistPreferences(); this.pendingIndex.clear(); this.fullIndexRequested = false;
            this.notices = ['模型连接成功，可以开始索引。'];
            if (this.session.current) this.session.refresh();
            if (this.autoIndex) this.indexPending();
            this.changed(); return this.state();
          } catch (error) { throw new KernelError('INVALID_INPUT', embeddingErrorMessage(error)); }
        }
        case 'read': return this.read(command.id);
        case 'search': return command.query.trim() ? this.service.search(command.query, { limit: 50 }) : [];
        case 'evidence': return this.service.getEvidence(command.locator);
        case 'focus': this.focus(command.id); break;
        case 'lens': this.session.setLens(command.value); break;
        case 'back': this.session.back(); break;
        case 'refresh': await this.rescan(); if (this.session.current && this.service.getNode(this.session.current.snapshot.focusNode)) { this.session.refresh(); this.session.setViewState({ layout: completeLayout(this.session.current!) }); } else if (this.service.listDocuments()[0]) this.focus(this.service.listDocuments()[0]!.id); break;
        case 'more': this.session.loadMore(); break;
        case 'save': await this.save(command); break;
        case 'view': {
          const { type: _type, ...view } = command;
          this.session.setViewState(view as Parameters<ExplorationSession['setViewState']>[0]); break;
        }
        case 'auto-index': this.autoIndex = command.enabled; await this.persistPreferences(); if (this.autoIndex) this.indexPending(); return this.state();
        case 'index': if (this.needsAuth) throw new KernelError('INVALID_INPUT', '请先重新输入 API Key 并连接模型'); this.autoIndex = true; await this.persistPreferences(); this.startIndex(); return this.state();
        case 'cancel-index': this.autoIndex = false; this.pendingIndex.clear(); this.fullIndexRequested = false; this.service.cancelEmbeddings(); await this.persistPreferences(); return this.state();
      }
      await this.persistSession(); return this.state();
    });
  }
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    clearTimeout(this.timer); await this.watcher?.close(); await this.tail;
    this.service.cancelEmbeddings(); await this.indexing;
    await this.persistSession(); this.closed = true; this.workspace.close();
  }
}
