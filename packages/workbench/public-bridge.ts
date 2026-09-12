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

export function createPublicBridge(bundle: PublicBundle): WorkbenchBridge {
  const snapshotService = new PublicKnowledgeService(bundle, new BrowserIdentityProvider());
  const service = bundle.semantic ? snapshotService : snapshotService.kernel;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  let indexing = false, connection: SafeEmbeddingConnection | undefined, notice = '';
  const refresh = () => { if (session.current) { session.refresh(); session.setViewState({ layout: completeLayout(session.current) }); } };
  const startIndex = () => {
    if (indexing) return;
    if (!connection) throw new KernelError('INVALID_INPUT', '请先配置并连接模型');
    indexing = true; notice = ''; changed();
    const progress = setInterval(changed, 250);
    void snapshotService.kernel.indexEmbeddings().then(report => {
      const failed = Object.values(report.documents).filter(doc => doc.errors.length).length;
      notice = report.cancelled ? '索引已取消，可继续建立索引。' : failed ? `${failed} 篇笔记索引未完成，请检查模型服务后重试。` : `索引完成：新增 ${report.encoded} 个片段，复用 ${report.reused} 个片段。`;
    }).catch(error => { notice = embeddingErrorMessage(error); }).finally(() => { clearInterval(progress); indexing = false; refresh(); changed(); });
  };
  const session = new ExplorationSession(service);
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const first = service.getNode(query.get('focus') ?? '') ?? service.listDocuments()[0];
  const requestedLens = Number(query.get('lens') ?? (first ? initialLens(service.getRelations(first.id)) : 45));
  const defaultLens = Number.isFinite(requestedLens) && requestedLens >= 0 && requestedLens <= 100 ? requestedLens : 45;
  const focus = (id: string) => { const current = session.focus(id, { lensValue: session.current?.snapshot.lensValue ?? defaultLens }); session.setViewState({ layout: completeLayout(current), reading: { documentId: id, offset: 0 } }); };
  if (first) focus(first.id);
  const state = (): WorkbenchState => ({ label: bundle.title, mode: 'public', readOnly: false, documents: service.listDocuments().map(d => ({ id: d.id, title: d.parsed.title, path: d.path, revision: d.revision })), current: session.current, visible: session.current ? session.visible() : null, canBack: !!session.exportState().backStack.length, coverage: service.getIndexCoverage(), indexing, embeddingConnection: connection,
    notices: [...(notice ? [notice] : []), bundle.semantic ? `语义关联由 ${bundle.semantic.descriptor.model} 预先计算，不进行实时模型查询。` : connection ? `文本索引使用 ${connection.model}。` : '配置 Embedding 后，可发现没有显式链接的语义关联。', '笔记编辑保存在当前页面，不会写回原文件；刷新后需要重新打开目录。'] });
  return { supportsGlobalGraph: true, supportsEmbedding: !bundle.semantic, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async command(raw) {
    const c = commandSchema.parse(raw);
    switch (c.type) {
      case 'state': return state();
      case 'global-graph': return collectGlobalGraph(service);
      case 'configure-embedding': {
        if (bundle.semantic || indexing) throw new KernelError('INVALID_INPUT', '请等待当前索引完成后再更换模型');
        try { const connected = await connectEmbedding(c.settings); snapshotService.kernel.configureEmbedding(connected.provider, connected.config); connection = connected.settings; notice = '模型连接成功，可以开始索引。'; refresh(); changed(); }
        catch (error) { throw new Error(embeddingErrorMessage(error)); }
        break;
      }
      case 'index': startIndex(); break;
      case 'cancel-index': snapshotService.kernel.cancelEmbeddings(); break;
      case 'read': { const document = service.getNode(c.id); if (!document) throw new KernelError('NOT_FOUND', '文档不存在'); return { document, mentions: service.findMentions({ sourceDocumentId: c.id }), links: service.findWikiLinks({ sourceDocumentId: c.id }) }; }
      case 'focus': focus(c.id); break;
      case 'lens': session.setLens(c.value); break;
      case 'back': session.back(); break;
      case 'refresh': if (session.current) { session.refresh(); session.setViewState({ layout: completeLayout(session.current) }); } break;
      case 'more': session.loadMore(); break;
      case 'view': { const { type: _type, ...view } = c; session.setViewState(view as Parameters<ExplorationSession['setViewState']>[0]); break; }
      case 'evidence': return service.getEvidence(c.locator);
      case 'search': return service.listDocuments().filter(d => (d.parsed.title + d.markdown).toLocaleLowerCase().includes(c.query.toLocaleLowerCase())).map(d => ({ documentId: d.id }));
      case 'save': { const doc = service.getNode(c.id); if (!doc || doc.contentHash !== c.expectedHash) throw new KernelError('CONFLICT', '内容版本已变化'); service.ingestDocument({ id: doc.id, path: doc.path, markdown: c.markdown, expectedRevision: doc.revision }); session.refresh(); break; }
      default: throw new KernelError('INVALID_INPUT', '浏览器模式不连接模型服务');
    }
    return state();
  } };
}
/** The default Web entry is empty: user-selected files never leave this browser. */
export async function loadPublicBridge(): Promise<WorkbenchBridge> {
  const empty: PublicBundle = { schemaVersion: 1, id: 'local-browser', title: '你的知识空间', generatedAt: '', documents: [], scorePolicy: { ...DEFAULT_SCORE_POLICY } };
  let current = createPublicBridge(empty);
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  let unsubscribe = current.subscribe(changed);
  return {
    supportsGlobalGraph: true, supportsEmbedding: true,
    command: command => current.command(command),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    chooseFolder() {
      return new Promise<boolean>((resolve, reject) => {
        const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.setAttribute('webkitdirectory', ''); input.accept = '.md,.markdown'; input.hidden = true;
        const finish = () => input.remove();
        input.oncancel = () => { finish(); resolve(false); };
        input.onchange = async () => {
          try {
            const selected = [...(input.files ?? [])];
            const files = selected.filter(file => /\.(md|markdown)$/i.test(file.name) && file.name.toLowerCase() !== 'agents.md' && !(file.webkitRelativePath || file.name).split('/').some(part => part.startsWith('.')));
            if (!files.length) throw new Error('这个目录中没有 Markdown 笔记，请选择另一个目录。');
            if (files.length > 1000 || files.some(file => file.size > 4 * 1024 * 1024) || files.reduce((size, file) => size + file.size, 0) > 32 * 1024 * 1024) throw new Error('目录较大，请使用桌面版打开，或选择较小的笔记目录。');
            const documents = await Promise.all(files.map(async (file, index) => ({ id: `local-${index}`, path: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name, markdown: await file.text() })));
            const next = createPublicBridge({ ...empty, title: files[0]!.webkitRelativePath.split('/')[0] || '我的笔记', documents });
            await current.command({ type: 'cancel-index' });
            unsubscribe(); current = next; unsubscribe = current.subscribe(changed);
            for (const listener of listeners) listener();
            resolve(true);
          } catch (error) { reject(error); } finally { finish(); }
        };
        document.body.append(input); input.click();
      });
    },
  };
}
