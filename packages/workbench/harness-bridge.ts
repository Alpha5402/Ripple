import type { WorkbenchBridge } from '../host/contract.js';
import type { HarnessState } from '../integrations/dsh/knowledge.js';
export function createHarnessBridge(sessionId: string) {
  if (!sessionId || sessionId.length > 200) throw new Error('Invalid DSH session');
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const request = (payload: object): Promise<unknown> => {
    const task = tail.then(async () => {
      const response = await fetch('./api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, sessionId }) });
      const envelope = await response.json();
      if (!envelope.ok) throw new Error(envelope.error?.message ?? 'Knowledge panel unavailable');
      return envelope.result;
    }); tail = task.catch(() => {}); return task;
  };
  const notify = () => { for (const listener of listeners) listener(); };
  const bridge: WorkbenchBridge = {
    async command(command) { const result = await request({ type: 'workspace', command }); if (!['state', 'read', 'search', 'evidence', 'view'].includes(command.type)) notify(); return result; },
    subscribe(listener) { listeners.add(listener); timer ??= setInterval(notify, 1500); return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } }; },
  };
  return { bridge,
    state: () => bridge.command({ type: 'state' }) as Promise<HarnessState>,
    async follow(enabled: boolean) { await request({ type: 'follow', enabled }); notify(); },
    async decision(proposalId: string, approve: boolean) { await request({ type: 'decision', proposalId, approve }); notify(); },
  };
}
