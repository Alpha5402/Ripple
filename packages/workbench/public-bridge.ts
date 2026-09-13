import { knowledgeFilter } from '../ingestion/knowledge-filter.js';
import { MemoryStorage } from '../adapters/storage-memory/index.js';
import { restoreEmbedding, type EmbeddingPreferences } from '../host/embedding-preferences.js';
import { BrowserWorkspaceStore, readDirectory, listDirectoryPaths, type BrowserSnapshot, type BrowserWorkspace, type DirectoryHandle } from './browser-workspaces.js';
import { collectGlobalGraph } from '../host/global-graph.js';
import { connectEmbedding, embeddingErrorMessage, type SafeEmbeddingConnection } from '../host/embedding-connection.js';
import { PublicKnowledgeService } from '../adapters/public-snapshot/service.js';
import type { PublicBundle } from '../adapters/public-snapshot/model.js';
import { KernelError } from '../core/model.js';
import { DEFAULT_SCORE_POLICY } from '../core/relation.js';
import { BrowserIdentityProvider } from '../adapters/runtime-browser/index.js';
import { ExplorationSession } from '../sdk/session.js';
import { completeLayout, initialLens } from '../host/layout.js';
import { commandSchema, type WorkbenchBridge, type WorkbenchState } from '../host/contract.js';

interface PersistentPublicBridge extends WorkbenchBridge {
  snapshot(): BrowserSnapshot;
  syncDocuments(documents: { path: string; markdown: string }[]): Promise<void>;
  dispose(): Promise<void>;
}
export function createPublicBridge(bundle: PublicBundle, options: { initial?: BrowserSnapshot; save?: (snapshot: BrowserSnapshot) => Promise<void> } = {}): PersistentPublicBridge {
  const effectiveBundle = options.initial ? { ...bundle, documents: options.initial.kernel.documents.map(d => ({ id: d.id, path: d.path, markdown: d.markdown })) } : bundle;
  const snapshotService = new PublicKnowledgeService(effectiveBundle, new BrowserIdentityProvider(), new MemoryStorage(options.initial?.kernel));
  const service = bundle.semantic ? snapshotService : snapshotService.kernel;
  let ignoreRules = options.initial?.ignoreRules ?? '';
  let excludedDocuments = structuredClone(options.initial?.excludedDocuments ?? []);
  const initialFilter = knowledgeFilter(ignoreRules);
  const initiallyExcluded = service.listDocuments().filter(d => initialFilter(d.path));
  if (initiallyExcluded.length) {
    const archive = new Map(excludedDocuments.map(d => [d.path, d]));
    for (const { id, path, markdown } of initiallyExcluded) archive.set(path, { id, path, markdown });
    excludedDocuments = [...archive.values()];
    snapshotService.kernel.removeDocuments(initiallyExcluded.map(d => d.id));
  }
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  let indexing = false, connection: SafeEmbeddingConnection | undefined, notice = '';
  let preferences = options.initial?.preferences, needsAuth = !!preferences?.requiresAuth, autoIndex = preferences?.autoIndex ?? false;
  let disposed = false, rerun = false, indexJob: Promise<void> | undefined;
  const snapshot = (): BrowserSnapshot => ({ ignoreRules, excludedDocuments: structuredClone(excludedDocuments), kernel: snapshotService.kernel.exportState(), session: session.exportState(), ...(preferences ? { preferences: { ...preferences, autoIndex } } : {}) });
  const persist = async () => { if (!disposed) await options.save?.(snapshot()); };
  if (preferences) {
    try { snapshotService.kernel.configureEmbedding(restoreEmbedding(preferences), preferences.config); connection = preferences.settings; }
    catch { notice = '缓存仍已保留，请重新连接模型。'; preferences = undefined; autoIndex = false; }
  }
  const refresh = () => { if (session.current) { session.refresh(); session.setViewState({ layout: completeLayout(session.current) }); } };
  const startIndex = () => {
    if (disposed || needsAuth) return;
    if (indexing) { rerun = true; return; }
    if (!connection) throw new KernelError('INVALID_INPUT', '请先配置并连接模型');
    const coverage = service.getIndexCoverage().semantic;
    const documentIds = service.listDocuments().filter(d => coverage.documents[d.id]?.status !== 'ready').map(d => d.id);
    if (!documentIds.length) { notice = `已复用 ${coverage.readyUnits} 个片段，无需重新编码。`; changed(); return; }
    indexing = true; notice = ''; changed();
    const progress = setInterval(changed, 250);
    indexJob = snapshotService.kernel.indexEmbeddings({ documentIds }).then(report => {
      const failed = Object.values(report.documents).filter(doc => doc.errors.length).length;
      notice = report.cancelled ? '索引已取消，可继续建立索引。' : failed ? `${failed} 篇笔记索引未完成，请检查模型服务后重试。` : `索引完成：新增 ${report.encoded} 个片段，复用 ${report.reused} 个片段。`;
    }).catch(error => { notice = embeddingErrorMessage(error); }).finally(async () => { clearInterval(progress); try { await persist(); } catch { notice = '索引已完成，但浏览器未能保存缓存；请检查存储空间。'; } indexing = false; changed(); if (rerun && autoIndex && !disposed) { rerun = false; startIndex(); } });
  };
  const session = new ExplorationSession(service);
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const first = service.getNode(query.get('focus') ?? '') ?? service.listDocuments()[0];
  const requestedLens = Number(query.get('lens') ?? (first ? initialLens(service.getRelations(first.id)) : 45));
  const defaultLens = Number.isFinite(requestedLens) && requestedLens >= 0 && requestedLens <= 100 ? requestedLens : 45;
  const focus = (id: string) => { const current = session.focus(id, { lensValue: session.current?.snapshot.lensValue ?? defaultLens }); session.setViewState({ layout: completeLayout(current), reading: { documentId: id, offset: 0 } }); };
  if (options.initial?.session) { try { session.importState(options.initial.session); if (session.current && !service.getNode(session.current.snapshot.focusNode)) session.importState({ schemaVersion: 1, current: null, backStack: [] }); } catch {} }
  if (!session.current && first) focus(first.id);
  if (autoIndex && !needsAuth && service.getIndexCoverage().semantic.status !== 'ready') queueMicrotask(startIndex);
  const state = (): WorkbenchState => ({ knowledgeSettings: { ignoreRules, excludedPaths: excludedDocuments.map(d => d.path) }, autoIndex, embeddingNeedsAuth: needsAuth, label: bundle.title, mode: 'public', readOnly: false, documents: service.listDocuments().map(d => ({ id: d.id, title: d.parsed.title, path: d.path, revision: d.revision })), current: session.current, visible: session.current ? session.visible() : null, canBack: !!session.exportState().backStack.length, coverage: service.getIndexCoverage(), indexing, embeddingConnection: connection,
    notices: [...(notice ? [notice] : []), bundle.semantic ? `语义关联由 ${bundle.semantic.descriptor.model} 预先计算，不进行实时模型查询。` : connection ? `文本索引使用 ${connection.model}。` : '配置 Embedding 后，可发现没有显式链接的语义关联。', options.save ? '工作区与索引保存在本机浏览器；编辑保存在本地副本，不会写回源文件。' : '笔记编辑仅保存在当前页面，不会写回原文件。'] });
  return { snapshot,
    async dispose() { rerun = false; disposed = true; snapshotService.kernel.cancelEmbeddings(); await indexJob; await options.save?.(snapshot()); },
    async syncDocuments(documents) {
      const kernel = snapshotService.kernel;
      const excluded = knowledgeFilter(ignoreRules);
      const archiveBefore = JSON.stringify(excludedDocuments);
      const archive = new Map(excludedDocuments.map(d => [d.path, d]));
      const known = new Map([...excludedDocuments, ...kernel.listDocuments()].map(d => [d.path, d]));
      for (const d of documents) if (excluded(d.path)) archive.set(d.path, { ...d, id: known.get(d.path)?.id ?? crypto.randomUUID() });
      excludedDocuments = [...archive.values()].filter(d => excluded(d.path));
      documents = documents.filter(d => !excluded(d.path));
      const byPath = new Map(kernel.listDocuments().map(d => [d.path, d]));
      const paths = new Set(documents.map(d => d.path)); const before = kernel.indexRevision;
      kernel.removeDocuments([...byPath.values()].filter(d => !paths.has(d.path)).map(d => d.id));
      kernel.ingestDocuments(documents.map(d => ({ ...d, id: byPath.get(d.path)?.id ?? crypto.randomUUID() })));
      if (before === kernel.indexRevision) { if (archiveBefore !== JSON.stringify(excludedDocuments)) await persist(); return; }
      if (session.current && !kernel.getNode(session.current.snapshot.focusNode)) { session.importState({ schemaVersion: 1, current: null, backStack: [] }); if (kernel.listDocuments()[0]) focus(kernel.listDocuments()[0]!.id); }
      await persist(); changed(); if (autoIndex && !needsAuth) startIndex();
    },
    supportsKnowledgeSettings: !bundle.semantic, supportsGlobalGraph: true, supportsEmbedding: !bundle.semantic, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async command(raw) {
    const c = commandSchema.parse(raw);
    switch (c.type) {
      case 'state': return state();
      case 'configure-knowledge': {
        if (bundle.semantic) throw new KernelError('INVALID_INPUT', '预计算展示包不支持修改知识范围');
        const excluded = knowledgeFilter(c.ignoreRules);
        rerun = false; snapshotService.kernel.cancelEmbeddings(); await indexJob;
        const documents = [...excludedDocuments, ...service.listDocuments()].map(({ id, path, markdown }) => ({ id, path, markdown }));
        const byPath = new Map(documents.map(d => [d.path, d]));
        const all = [...byPath.values()];
        ignoreRules = c.ignoreRules; excludedDocuments = all.filter(d => excluded(d.path));
        snapshotService.kernel.removeDocuments(service.listDocuments().filter(d => excluded(d.path)).map(d => d.id));
        snapshotService.kernel.ingestDocuments(all.filter(d => !excluded(d.path)));
        if (session.current && !service.getNode(session.current.snapshot.focusNode)) session.importState({ schemaVersion: 1, current: null, backStack: [] });
        if (session.current) refresh(); else if (service.listDocuments()[0]) focus(service.listDocuments()[0]!.id);
        await persist(); changed(); if (autoIndex && !needsAuth) startIndex();
        return state();
      }
      case 'global-graph': return collectGlobalGraph(service);
      case 'configure-embedding': {
        if (bundle.semantic || indexing) throw new KernelError('INVALID_INPUT', '请等待当前索引完成后再更换模型');
        try { const connected = await connectEmbedding(c.settings); snapshotService.kernel.configureEmbedding(connected.provider, connected.config); connection = connected.settings; needsAuth = false; preferences = { settings: connected.settings, descriptor: connected.provider.descriptor, config: connected.config, requiresAuth: !!c.settings.apiKey, autoIndex }; notice = '模型连接成功，可以开始索引。'; refresh(); if (autoIndex) startIndex(); changed(); }
        catch (error) { throw new Error(embeddingErrorMessage(error)); }
        break;
      }
      case 'auto-index': autoIndex = c.enabled; if (autoIndex && !needsAuth) startIndex(); break;
      case 'index': if (needsAuth) throw new Error('请先重新输入 API Key 并连接模型'); autoIndex = true; startIndex(); break;
      case 'cancel-index': autoIndex = false; rerun = false; snapshotService.kernel.cancelEmbeddings(); break;
      case 'read': { const document = service.getNode(c.id); if (!document) throw new KernelError('NOT_FOUND', '文档不存在'); return { document, mentions: service.findMentions({ sourceDocumentId: c.id }), links: service.findWikiLinks({ sourceDocumentId: c.id }) }; }
      case 'focus': focus(c.id); break;
      case 'lens': session.setLens(c.value); break;
      case 'back': session.back(); break;
      case 'refresh': if (session.current) { session.refresh(); session.setViewState({ layout: completeLayout(session.current) }); } break;
      case 'more': session.loadMore(); break;
      case 'view': { const { type: _type, ...view } = c; session.setViewState(view as Parameters<ExplorationSession['setViewState']>[0]); break; }
      case 'evidence': return service.getEvidence(c.locator);
      case 'search': return service.listDocuments().filter(d => (d.parsed.title + d.markdown).toLocaleLowerCase().includes(c.query.toLocaleLowerCase())).map(d => ({ documentId: d.id }));
      case 'save': { const doc = service.getNode(c.id); if (!doc || doc.contentHash !== c.expectedHash) throw new KernelError('CONFLICT', '内容版本已变化'); service.ingestDocument({ id: doc.id, path: doc.path, markdown: c.markdown, expectedRevision: doc.revision }); if (autoIndex && !needsAuth) startIndex(); break; }
      default: throw new KernelError('INVALID_INPUT', '浏览器模式不连接模型服务');
    }
    await persist(); return state();
  } };
}
/** Persistent local workspaces; directory access stays subject to browser permission. */
export async function loadPublicBridge(): Promise<WorkbenchBridge> {
  const empty: PublicBundle = { schemaVersion: 1, id: 'local-browser', title: '你的知识空间', generatedAt: '', documents: [], scorePolicy: { ...DEFAULT_SCORE_POLICY } };
  let store: BrowserWorkspaceStore | undefined, storageError = '';
  try { store = await BrowserWorkspaceStore.open(); } catch { storageError = '浏览器存储不可用；本次工作区仅保留到页面关闭。'; }
  let current = createPublicBridge(empty), active: BrowserWorkspace | undefined;
  let syncStatus = '', syncing = false, switching = false, isDirty = false, persistenceTail = Promise.resolve();
  const identity = new BrowserIdentityProvider();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  let unsubscribe = current.subscribe(changed);
  const persist = (workspace: BrowserWorkspace, snapshot: BrowserSnapshot): Promise<void> => {
    workspace.snapshot = snapshot;
    // Preserve ordering across index completion, navigation and workspace switches.
    persistenceTail = persistenceTail.catch(() => {}).then(async () => { if (store) { try { workspace.version = await store.put({ ...workspace, snapshot }); storageError = ''; } catch (e) { storageError = (e as Error).message || '浏览器缓存写入失败，请检查存储空间。'; changed(); throw e; } } });
    return persistenceTail;
  };
  async function syncSources(workspace: BrowserWorkspace, sources: { path: string; markdown: string }[]): Promise<void> {
    const bridge = current;
    const saved = bridge.snapshot();
    const local = new Map([...saved.excludedDocuments ?? [], ...saved.kernel.documents].map(d => [d.path, { ...d, contentHash: identity.hash(d.markdown) }]));
    const excluded = knowledgeFilter(saved.ignoreRules);
    const hashes = { ...workspace.sourceHashes }; let conflicts = 0;
    const documents = sources.map(source => {
      const hash = identity.hash(source.markdown), old = local.get(source.path), base = hashes[source.path];
      local.delete(source.path);
      if (old && base && old.contentHash !== base) {
        if (hash !== base) conflicts++;
        return { path: source.path, markdown: old.markdown };
      }
      hashes[source.path] = hash; return source;
    });
    for (const [path, old] of local) {
      if (excluded(path)) { documents.push({ path, markdown: old.markdown }); continue; }
      if (hashes[path] && old.contentHash !== hashes[path]) { conflicts++; documents.push({ path, markdown: old.markdown }); }
      else delete hashes[path];
    }
    const sourcesChanged = JSON.stringify(workspace.sourceHashes) !== JSON.stringify(hashes);
    workspace.sourceHashes = hashes;
    await bridge.syncDocuments(documents); if (sourcesChanged) await persist(workspace, bridge.snapshot());
    if (active?.id === workspace.id) syncStatus = conflicts ? `${conflicts} 篇源文件与本地编辑冲突，已保留本地副本` : workspace.handle ? '自动同步目录变化' : '目录快照已更新；可重新选择目录同步';
  }
  async function synchronize(requestPermission = false): Promise<void> {
    if (!active?.handle || syncing || switching || isDirty) return;
    const workspace = active; syncing = true;
    try {
      let permission = await workspace.handle!.queryPermission({ mode: 'read' });
      if (permission !== 'granted' && requestPermission) permission = await workspace.handle!.requestPermission({ mode: 'read' });
      if (permission !== 'granted') { syncStatus = '已恢复缓存；点击「同步目录」重新授权访问'; return; }
      const scope = current.snapshot().ignoreRules;
      const sources = await readDirectory(workspace.handle!, scope);
      if (!switching && active?.id === workspace.id && current.snapshot().ignoreRules === scope) await syncSources(workspace, sources);
    } catch { syncStatus = '目录暂不可访问，已保留缓存；可点击「同步目录」重试'; }
    finally { syncing = false; changed(); }
  }
  async function activate(workspace: BrowserWorkspace): Promise<void> {
    switching = true;
    try {
      await current.dispose(); unsubscribe();
      workspace.lastOpened = Date.now(); active = workspace;
      current = createPublicBridge({ ...empty, id: workspace.id, title: workspace.label, documents: workspace.snapshot.kernel.documents.map(d => ({ id: d.id, path: d.path, markdown: d.markdown })) }, { initial: workspace.snapshot, save: snapshot => persist(workspace, snapshot) });
      unsubscribe = current.subscribe(changed);
      syncStatus = workspace.handle ? '已恢复缓存，正在检查目录变化' : '已恢复目录快照；源文件变化需重新选择目录同步';
      await persist(workspace, current.snapshot()); await store?.setActive(workspace.id); changed();
    } finally { switching = false; }
    void synchronize();
  }
  async function importSources(label: string, sources: { path: string; markdown: string }[], handle?: DirectoryHandle, target?: BrowserWorkspace, rules?: string): Promise<void> {
    if (target) { if (target.id !== active?.id) { if (rules !== undefined) target.snapshot = { ...target.snapshot, ignoreRules: rules }; await activate(target); } const selected = active!; if (rules !== undefined) await current.command({ type: 'configure-knowledge', ignoreRules: rules }); if (handle) { selected.handle = handle; selected.location = `本地目录 · ${selected.label}`; } await syncSources(selected, sources); await persist(selected, current.snapshot()); changed(); return; }
    const bundle = { ...empty, title: label, documents: sources.map(d => ({ ...d, id: crypto.randomUUID() })) };
    const fresh = createPublicBridge(bundle);
    if (rules !== undefined) await fresh.command({ type: 'configure-knowledge', ignoreRules: rules });
    const workspace: BrowserWorkspace = { id: crypto.randomUUID(), label, location: handle ? `本地目录 · ${label}` : `目录快照 · ${label}`, lastOpened: Date.now(), snapshot: fresh.snapshot(), sourceHashes: Object.fromEntries(sources.map(d => [d.path, identity.hash(d.markdown)])), ...(handle ? { handle } : {}) };
    await fresh.dispose(); await activate(workspace);
  }
  let prepared: { token: string; label: string; handle?: DirectoryHandle; files?: File[]; target?: BrowserWorkspace } | undefined;
  async function prepareFolder() {
    prepared = undefined;
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (picker) {
      try {
        const handle = await picker.call(window, { mode: 'read' });
        let target: BrowserWorkspace | undefined;
        for (const entry of await store?.list() ?? []) if (entry.handle && await handle.isSameEntry(entry.handle)) { target = entry; break; }
        const paths = await listDirectoryPaths(handle);
        prepared = { token: crypto.randomUUID(), label: handle.name, handle, ...(target ? { target } : {}) };
        return { token: prepared.token, label: handle.name, paths, ignoreRules: target?.snapshot.ignoreRules ?? '' };
      } catch (error) { if ((error as DOMException).name === 'AbortError') return undefined; throw error; }
    }
    return new Promise<import('../ingestion/scope-preview.js').FolderSelection | undefined>((resolve) => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.setAttribute('webkitdirectory', ''); input.hidden = true;
      input.oncancel = () => { input.remove(); resolve(undefined); };
      input.onchange = () => {
        const selected = [...input.files ?? []];
        const files = selected.filter(f => /\.(md|markdown)$/i.test(f.name) && f.name.toLowerCase() !== 'agents.md' && !(f.webkitRelativePath || f.name).split('/').some(part => part.startsWith('.')));
        prepared = { token: crypto.randomUUID(), label: selected[0]?.webkitRelativePath.split('/')[0] || '我的笔记', files };
        resolve({ token: prepared.token, label: prepared.label, paths: files.map(file => file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name), ignoreRules: '' }); input.remove();
      };
      document.body.append(input); input.click();
    });
  }
  async function importFolder(token: string, rules: string) {
    if (!prepared || prepared.token !== token) throw new Error('目录选择已过期，请重新选择');
    const selection = prepared, excluded = knowledgeFilter(rules);
    let sources: {path: string; markdown: string}[];
    if (selection.handle) sources = await readDirectory(selection.handle, rules);
    else {
      const files = (selection.files ?? []).map(file => ({ file, path: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name })).filter(({path}) => !excluded(path));
      if (files.length > 1000 || files.some(({file}) => file.size > 4*1024*1024) || files.reduce((n,{file}) => n+file.size,0) > 32*1024*1024) throw new Error('目录较大，请缩小知识范围或使用桌面版。');
      sources = await Promise.all(files.map(async ({file,path}) => ({path,markdown:await file.text()})));
    }
    await importSources(selection.label, sources, selection.handle, selection.target, rules); prepared = undefined; return true;
  }
  async function choose(target?: BrowserWorkspace): Promise<boolean> {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (picker) {
      try {
        const handle = await picker.call(window, { mode: 'read' });
        let match = target;
        if (!match) for (const entry of await store?.list() ?? []) if (entry.handle && await handle.isSameEntry(entry.handle)) { match = entry; break; }
        const sources = await readDirectory(handle, match?.snapshot.ignoreRules);
        await importSources(handle.name, sources, handle, match); return true;
      } catch (error) { if ((error as DOMException).name === 'AbortError') return false; throw error; }
    }
    return new Promise<boolean>((resolve, reject) => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.setAttribute('webkitdirectory', ''); input.accept = '.md,.markdown'; input.hidden = true;
      input.oncancel = () => { input.remove(); resolve(false); };
      input.onchange = async () => {
        try {
          const selectedFiles = [...(input.files ?? [])];
          const label = selectedFiles[0]?.webkitRelativePath.split('/')[0] || '我的笔记';
          const excluded = knowledgeFilter(target?.snapshot.ignoreRules);
          const files = selectedFiles.filter(file => !excluded(file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name) && /\.(md|markdown)$/i.test(file.name) && file.name.toLowerCase() !== 'agents.md' && !(file.webkitRelativePath || file.name).split('/').some(part => part.startsWith('.')));
          if (!files.length && !target) throw new Error('这个目录中没有 Markdown 笔记，请选择另一个目录。');
          if (files.length > 1000 || files.some(f => f.size > 4 * 1024 * 1024) || files.reduce((n, f) => n + f.size, 0) > 32 * 1024 * 1024) throw new Error('目录较大，请使用桌面版或选择较小目录。');
          if (target && label !== target.label) throw new Error(`请重新选择「${target.label}」目录；其他目录请通过「打开工作区」导入。`);
          await importSources(label, await Promise.all(files.map(async f => ({ path: f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name, markdown: await f.text() }))), undefined, target);
          resolve(true);
        } catch (e) { reject(e); } finally { input.remove(); }
      };
      document.body.append(input); input.click();
    });
  }
  if (store) { try { const id = await store.active(); const workspace = id ? await store.get(id) : undefined; if (workspace) await activate(workspace); } catch { storageError = '上次工作区暂时无法恢复，请从最近列表重新打开。'; } }
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void synchronize(); }, 3000);
  window.addEventListener('pagehide', () => { clearInterval(timer); }, { once: true });
  window.addEventListener('focus', () => { void synchronize(); });
  return {
    supportsKnowledgeSettings: true, supportsGlobalGraph: true, supportsEmbedding: true,
    setDirty(dirty) { isDirty = dirty; },
    async command(command) {
      if (command.type === 'refresh' && active) { if (active.handle) await synchronize(true); else await choose(active); }
      let result = await current.command(command);
      if (command.type === 'configure-knowledge' && active?.handle) { await synchronize(true); result = await current.command({ type: 'state' }); }
      if (result && typeof result === 'object' && 'coverage' in result) return { ...result, workspaceId: active?.id, syncStatus, notices: [...(storageError ? [storageError] : []), ...(result as WorkbenchState).notices] };
      return result;
    },
    recentWorkspaces: async () => (await store?.list() ?? []).map(({ id, label, location, lastOpened }) => ({ id, label, location, lastOpened })),
    async openRecent(id) { if (id === active?.id) { await synchronize(true); return true; } const workspace = await store?.get(id); if (!workspace) throw new Error('工作区缓存已不存在'); await activate(workspace); return true; },
    async forgetWorkspace(id) { if (id === active?.id) throw new Error('请先切换到其他工作区，再移除此缓存'); await store?.forget(id); changed(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    prepareFolder, importFolder,
    chooseFolder: () => choose(),
  };
}
