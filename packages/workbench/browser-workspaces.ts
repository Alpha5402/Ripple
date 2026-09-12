import { knowledgeFilter } from '../ingestion/knowledge-filter.js';
import type { KernelState } from '../core/model.js';
import type { ExplorationSession } from '../sdk/session.js';
import type { EmbeddingPreferences } from '../host/embedding-preferences.js';

export interface BrowserSnapshot {
  kernel: KernelState;
  ignoreRules?: string;
  excludedDocuments?: { id: string; path: string; markdown: string }[];
  session: ReturnType<ExplorationSession['exportState']>;
  preferences?: EmbeddingPreferences;
}
export interface DirectoryHandle {
  kind: 'directory'; name: string;
  values(): AsyncIterable<DirectoryHandle | { kind: 'file'; name: string; getFile(): Promise<File> }>;
  isSameEntry(other: DirectoryHandle): Promise<boolean>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}
export interface BrowserWorkspace {
  id: string; label: string; location: string; lastOpened: number; version?: number;
  snapshot: BrowserSnapshot;
  sourceHashes: Record<string, string>;
  handle?: DirectoryHandle;
}
export class BrowserWorkspaceStore {
  private constructor(private readonly db: IDBDatabase) {}
  static async open(): Promise<BrowserWorkspaceStore> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ripple-workspaces', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('workspaces', { keyPath: 'id' }); request.result.createObjectStore('meta'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return new BrowserWorkspaceStore(db);
  }
  private run<T>(stores: string[], mode: IDBTransactionMode, action: (transaction: IDBTransaction) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(stores, mode); const request = action(transaction);
      transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  }
  async list(): Promise<BrowserWorkspace[]> { return (await this.run(['workspaces'], 'readonly', tx => tx.objectStore('workspaces').getAll())).sort((a, b) => b.lastOpened - a.lastOpened); }
  get(id: string): Promise<BrowserWorkspace | undefined> { return this.run(['workspaces'], 'readonly', tx => tx.objectStore('workspaces').get(id)); }
  put(workspace: BrowserWorkspace): Promise<number> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('workspaces', 'readwrite'), table = tx.objectStore('workspaces');
      const request = table.get(workspace.id); let failure: Error | undefined;
      const version = (workspace.version ?? 0) + 1;
      request.onsuccess = () => {
        if ((request.result?.version ?? 0) !== (workspace.version ?? 0)) { failure = new Error('此工作区已在另一标签页更新；请刷新后继续，当前页面没有覆盖较新的缓存。'); tx.abort(); return; }
        table.put({ ...workspace, version });
      };
      tx.oncomplete = () => resolve(version); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(failure ?? tx.error);
    });
  }
  active(): Promise<string | undefined> { return this.run(['meta'], 'readonly', tx => tx.objectStore('meta').get('active')); }
  setActive(id: string): Promise<unknown> { return this.run(['meta'], 'readwrite', tx => tx.objectStore('meta').put(id, 'active')); }
  forget(id: string): Promise<unknown> { return this.run(['workspaces', 'meta'], 'readwrite', tx => { const request = tx.objectStore('workspaces').delete(id); const active = tx.objectStore('meta').get('active'); active.onsuccess = () => { if (active.result === id) tx.objectStore('meta').delete('active'); }; return request; }); }
}

export async function readDirectory(handle: DirectoryHandle, ignoreRules = ''): Promise<{ path: string; markdown: string }[]> {
  const documents: { path: string; markdown: string }[] = []; let total = 0;
  const excluded = knowledgeFilter(ignoreRules);
  async function walk(directory: DirectoryHandle, prefix: string): Promise<void> {
    for await (const child of directory.values()) {
      if (child.name.startsWith('.') || child.name.toLowerCase() === 'agents.md') continue;
      const path = prefix + child.name;
      if (excluded(path, child.kind === 'directory')) continue;
      if (child.kind === 'directory') await walk(child, `${path}/`);
      else if (/\.(md|markdown)$/i.test(child.name)) {
        const file = await child.getFile(); total += file.size;
        if (documents.length >= 1000 || file.size > 4 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('目录较大，请使用桌面版或选择较小目录。');
        documents.push({ path, markdown: await file.text() });
      }
    }
  }
  await walk(handle, ''); return documents.sort((a, b) => a.path.localeCompare(b.path));
}
