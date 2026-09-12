import { PublicKnowledgeService } from '../adapters/public-snapshot/service.js';
import type { PublicBundle } from '../adapters/public-snapshot/model.js';
import { KernelError } from '../core/model.js';
import { DEFAULT_SCORE_POLICY } from '../core/relation.js';
import { BrowserIdentityProvider } from '../adapters/runtime-browser/index.js';
import { ExplorationSession } from '../sdk/session.js';
import { completeLayout, initialLens } from '../host/layout.js';
import { commandSchema, type WorkbenchBridge, type WorkbenchState } from '../host/contract.js';

export function createPublicBridge(bundle: PublicBundle): WorkbenchBridge {
  const service = new PublicKnowledgeService(bundle, new BrowserIdentityProvider());
  const session = new ExplorationSession(service);
  const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const first = service.getNode(query.get('focus') ?? '') ?? service.listDocuments()[0];
  const requestedLens = Number(query.get('lens') ?? (first ? initialLens(service.getRelations(first.id)) : 45));
  const defaultLens = Number.isFinite(requestedLens) && requestedLens >= 0 && requestedLens <= 100 ? requestedLens : 45;
  const focus = (id: string) => { const current = session.focus(id, { lensValue: session.current?.snapshot.lensValue ?? defaultLens }); session.setViewState({ layout: completeLayout(current), reading: { documentId: id, offset: 0 } }); };
  if (first) focus(first.id);
  const state = (): WorkbenchState => ({ label: bundle.title, mode: 'public', readOnly: false, documents: service.listDocuments().map(d => ({ id: d.id, title: d.parsed.title, path: d.path, revision: d.revision })), current: session.current, visible: session.current ? session.visible() : null, canBack: !!session.exportState().backStack.length, coverage: service.getIndexCoverage(), indexing: false,
    notices: [bundle.semantic ? `语义关联由 ${bundle.semantic.descriptor.model} 预先计算，不进行实时模型查询。` : '此数据包包含名称提及和显式链接关系。', '文件仅在当前页面内处理。编辑不会写回原文件；刷新后需要重新打开目录。'] });
  return { subscribe: () => () => {}, async command(raw) {
    const c = commandSchema.parse(raw);
    switch (c.type) {
      case 'state': return state();
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
  return {
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
            current = next;
            for (const listener of listeners) listener();
            resolve(true);
          } catch (error) { reject(error); } finally { finish(); }
        };
        document.body.append(input); input.click();
      });
    },
  };
}
