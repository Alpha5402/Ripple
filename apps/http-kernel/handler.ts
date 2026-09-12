import { KnowledgeService, KernelError, serializeOperationError, type EvidenceLocator } from '../../packages/sdk/index.js';
import { ExplorationSession } from '../../packages/sdk/session.js';
export class KernelHttpHandler {
  private sessions = new Map<string, { session: ExplorationSession; usedAt: number }>();
  private sequence = 0;
  constructor(private readonly service: KnowledgeService) {}
  handle(method: string, path: string, body?: unknown): { status: number; body: unknown } {
    try {
      const url = new URL(path, 'http://127.0.0.1');
      const object = (value: unknown): Record<string, unknown> => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KernelError('INVALID_INPUT', 'Expected JSON object');
        return value as Record<string, unknown>;
      };
      let result: unknown;
      if (method === 'GET' && url.pathname === '/v1/capabilities') result = this.service.capabilities;
      else if (method === 'GET' && url.pathname === '/v1/coverage') result = this.service.getIndexCoverage();
      else if (method === 'GET' && url.pathname === '/v1/documents') result = this.service.listDocuments().map(({ id, path, revision, parsed }) => ({ id, path, revision, title: parsed.title }));
      else if (method === 'GET' && url.pathname === '/v1/search') result = this.service.search(url.searchParams.get('q') ?? '', { mode: (url.searchParams.get('mode') ?? 'text') as 'text', limit: Number(url.searchParams.get('limit') ?? 20) });
      else if (method === 'POST' && url.pathname === '/v1/evidence') result = this.service.getEvidence(object(body) as unknown as EvidenceLocator);
      else if (method === 'POST' && url.pathname === '/v1/sessions') {
        for (const [id, item] of this.sessions) if (Date.now() - item.usedAt > 30 * 60_000) this.sessions.delete(id);
        if (this.sessions.size >= 32) throw new KernelError('CONFLICT', 'Maximum 32 active sessions; delete unused sessions');
        const sessionId = String(++this.sequence);
        this.sessions.set(sessionId, { session: new ExplorationSession(this.service), usedAt: Date.now() }); result = { sessionId };
      } else if (/^\/v1\/sessions\/\d+$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1)!;
        const item = this.sessions.get(id);
        if (!item) throw new KernelError('NOT_FOUND', 'Unknown session');
        item.usedAt = Date.now();
        if (method === 'DELETE') { this.sessions.delete(id); result = { deleted: true }; }
        else if (method === 'GET') result = item.session.exportState();
        else if (method === 'POST') {
          const command = object(body);
          if (command.action === 'focus' && typeof command.documentId === 'string') item.session.focus(command.documentId);
          else if (command.action === 'lens' && typeof command.value === 'number') item.session.setLens(command.value);
          else if (command.action === 'more' && typeof command.count === 'number') item.session.loadMore(command.count);
          else if (command.action === 'back') item.session.back();
          else if (command.action === 'refresh') item.session.refresh();
          else throw new KernelError('INVALID_INPUT', 'Unsupported session command');
          result = { state: item.session.exportState(), visible: item.session.current ? item.session.visible() : null };
        } else throw new KernelError('INVALID_INPUT', 'Unsupported method');
      } else throw new KernelError('NOT_FOUND', 'Unknown endpoint');
      return { status: 200, body: result };
    } catch (error) {
      const serialized = serializeOperationError(error);
      return { status: serialized.code === 'NOT_FOUND' ? 404 : ['CONFLICT', 'STORAGE_CONFLICT', 'STALE_INDEX'].includes(serialized.code) ? 409 : serialized.code === 'INTERNAL' ? 500 : 400, body: { error: serialized } };
    }
  }
}
