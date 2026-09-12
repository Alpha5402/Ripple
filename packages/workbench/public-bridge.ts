import { PublicKnowledgeService } from '../adapters/public-snapshot/service.js';
import type { PublicBundle } from '../adapters/public-snapshot/model.js';
import { KernelError } from '../core/model.js';
import { BrowserIdentityProvider } from '../adapters/runtime-browser/index.js';
import { ExplorationSession } from '../sdk/session.js';
import { completeLayout, initialLens } from '../host/layout.js';
import { commandSchema, type WorkbenchBridge, type WorkbenchState } from '../host/contract.js';

export function createPublicBridge(bundle: PublicBundle): WorkbenchBridge {
  const service = new PublicKnowledgeService(bundle, new BrowserIdentityProvider());
  const session = new ExplorationSession(service);
  const query = new URLSearchParams(location.search);
  const requestedLens = Number(query.get('lens') ?? initialLens(service.getRelations(service.getNode(query.get('focus') ?? 'promise')?.id ?? service.listDocuments()[0]!.id)));
  const defaultLens = Number.isFinite(requestedLens) && requestedLens >= 0 && requestedLens <= 100 ? requestedLens : 45;
  const focus = (id: string) => { const current = session.focus(id, { lensValue: session.current?.snapshot.lensValue ?? defaultLens }); session.setViewState({ layout: completeLayout(current), reading: { documentId: id, offset: 0 } }); };
  const first = service.getNode(query.get('focus') ?? 'promise') ?? service.listDocuments()[0];
  if (first) focus(first.id);
  const state = (): WorkbenchState => ({ label: bundle.title, mode: 'public', readOnly: false, documents: service.listDocuments().map(d => ({ id: d.id, title: d.parsed.title, path: d.path, revision: d.revision })), current: session.current, visible: session.current ? session.visible() : null, canBack: !!session.exportState().backStack.length, coverage: service.getIndexCoverage(), indexing: false,
    notices: [bundle.semantic ? `语义关联由 ${bundle.semantic.descriptor.model} 预先计算，不进行实时模型查询。` : '此数据包包含名称提及和显式链接关系。', '编辑仅修改当前页面的沙盒；刷新页面恢复原版。修改过的内容会使相关预计算语义证据失效。'] });
  return { subscribe: () => () => {}, async command(raw) {
    const c = commandSchema.parse(raw);
    switch (c.type) {
      case 'state': return state();
      case 'read': { const document = service.getNode(c.id); if (!document) throw new KernelError('NOT_FOUND', '文档不存在'); return { document, mentions: service.findMentions({ sourceDocumentId: c.id }), links: service.findWikiLinks({ sourceDocumentId: c.id }) }; }
      case 'focus': focus(c.id); break;
      case 'lens': session.setLens(c.value); break;
      case 'back': session.back(); break;
      case 'refresh': session.refresh(); session.setViewState({ layout: completeLayout(session.current!) }); break;
      case 'more': session.loadMore(); break;
      case 'view': { const { type: _type, ...view } = c; session.setViewState(view as Parameters<ExplorationSession['setViewState']>[0]); break; }
      case 'evidence': return service.getEvidence(c.locator);
      case 'search': return service.listDocuments().filter(d => (d.parsed.title + d.markdown).toLocaleLowerCase().includes(c.query.toLocaleLowerCase())).map(d => ({ documentId: d.id }));
      case 'save': { const doc = service.getNode(c.id); if (!doc || doc.contentHash !== c.expectedHash) throw new KernelError('CONFLICT', '内容版本已变化'); service.ingestDocument({ id: doc.id, path: doc.path, markdown: c.markdown, expectedRevision: doc.revision }); session.refresh(); break; }
      default: throw new KernelError('INVALID_INPUT', '公开示例使用预计算关系，不连接模型服务');
    }
    return state();
  } };
}
export async function loadPublicBridge(): Promise<WorkbenchBridge> {
  const response = await fetch(new URL('knowledge.json', document.baseURI));
  if (!response.ok) throw new Error('公开知识包暂不可用，请稍后刷新');
  return createPublicBridge(await response.json() as PublicBundle);
}
