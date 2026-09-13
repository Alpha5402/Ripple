import { LocalEmbeddingProcess } from '../../packages/host/local-embedding-process.js';
import { isManagedEmbeddingUrl } from '../../packages/host/local-embedding.js';
import { readVault } from '../../packages/adapters/filesystem/index.js';
import { listMarkdownPaths } from '../../packages/adapters/filesystem/manifest.js';
import { knowledgeFilter } from '../../packages/ingestion/knowledge-filter.js';
import { atomicJson } from '../../packages/adapters/filesystem/atomic-json.js';
import { WorkspaceHistory } from '../../packages/host/workspace-history.js';
import { safeStorage, nativeImage, app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';

protocol.registerSchemesAsPrivileged([{ scheme: 'ripple', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Ripple');
const here = fileURLToPath(new URL('.', import.meta.url));
let window: BrowserWindow;
let worker: Worker | undefined;
let history: WorkspaceHistory;
let activeStateDir: string | undefined;
let localEmbedding: LocalEmbeddingProcess;
let dirty = false, quitting = false, sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function askWorker(data: unknown, timeoutMs = 30000): Promise<any> {
  if (!worker) return Promise.resolve({ ok: false, error: { code: 'NOT_FOUND', message: '请先打开一个 Markdown 目录' } });
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('目录服务响应超时，请重试')); }, timeoutMs); timer.unref();
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    try { worker!.postMessage({ id, ...data as object }); } catch (error) { pending.get(id)?.reject(error as Error); pending.delete(id); }
  });
}
async function stopWorker(): Promise<void> {
  if (!worker) return;
  const previous = worker;
  await askWorker({ close: true }).catch(() => {});
  await previous.terminate(); worker = undefined;
}
async function openFolder(root: string, readOnly: boolean, ignoreRules?: string): Promise<void> {
  root = await realpath(root);
  await stopWorker();
  const stateDir = join(process.env.RIPPLE_DESKTOP_STATE ?? app.getPath('userData'), 'vaults', createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24));
  await mkdir(stateDir, { recursive: true });
  if (ignoreRules !== undefined) await atomicJson(join(stateDir, 'knowledge-settings.json'), { ignoreRules });
  let apiKey = '';
  if (safeStorage.isEncryptionAvailable()) { try { apiKey = safeStorage.decryptString(await readFile(join(stateDir, 'embedding-secret.bin'))); } catch {} }
  worker = new Worker(join(here, 'worker.mjs'), { workerData: { root, stateDir, readOnly, apiKey } });
  const currentWorker = worker;
  await new Promise<void>((resolve, reject) => {
    worker!.on('message', message => {
      if (message.event === 'ready') { resolve(); window.webContents.send('ripple:changed'); }
      else if (message.event === 'changed') window.webContents.send('ripple:changed');
      else { pending.get(message.id)?.resolve(message); pending.delete(message.id); }
    });
    worker!.on('error', error => { reject(error); for (const call of pending.values()) call.reject(error); pending.clear(); });
    worker!.on('exit', () => { for (const call of pending.values()) call.reject(new Error('知识目录服务已关闭')); pending.clear(); if (worker === currentWorker) worker = undefined; });
  });
  activeStateDir = stateDir;
  await history.remember(root, readOnly);
  window.webContents.send('ripple:changed');
  window.setTitle(`Ripple — ${root.split(/[\\/]/).at(-1)}`);
  const current = await askWorker({ command: { type: 'state' } });
  if (localEmbedding.state.autoStart && current.result?.embeddingConnection?.protocol === 'ripple' && isManagedEmbeddingUrl(current.result.embeddingConnection.baseUrl, localEmbedding.state.baseUrl)) void resumeLocalEmbedding();
}
async function resumeLocalEmbedding() {
  try {
    await localEmbedding.start();
    const response = await askWorker({ command: { type: 'state' } });
    const state = response.result;
    if (state?.autoIndex && !state.indexing && state.embeddingConnection?.protocol === 'ripple' && isManagedEmbeddingUrl(state.embeddingConnection.baseUrl, localEmbedding.state.baseUrl)) {
      await askWorker({ command: { type: 'auto-index', enabled: true } });
    }
    window.webContents.send('ripple:changed');
  } catch { /* Startup state and logs remain visible in settings. Reading stays available. */ }
}
function isAppUrl(value: string): boolean { const url = new URL(value); return url.protocol === 'ripple:' && url.hostname === 'app'; }
function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && !!event.senderFrame && isAppUrl(event.senderFrame.url);
}
async function mayLeave(): Promise<boolean> {
  if (!dirty) return true;
  const { response } = await dialog.showMessageBox(window, { type: 'question', message: '保留未保存的编辑？', detail: '返回笔记后可保存草稿；丢弃后无法恢复这些编辑。', buttons: ['返回笔记', '丢弃编辑'], defaultId: 0, cancelId: 0 });
  return response === 1;
}
// Do not top-level-await readiness: Electron waits for ESM evaluation before emitting ready.
void app.whenReady().then(async () => {
  history = new WorkspaceHistory(process.env.RIPPLE_DESKTOP_STATE ?? app.getPath('userData'));
  await history.load();
  const candidates = [join(process.env.RIPPLE_DESKTOP_STATE ?? app.getPath('userData'), 'wemm')];
  if (process.env.RIPPLE_WEMM_RUNTIME) candidates.unshift(process.env.RIPPLE_WEMM_RUNTIME);
  for (let ancestor = here, i = 0; i < 8; i++, ancestor = dirname(ancestor)) candidates.push(join(ancestor, '.ripple/wemm'));
  localEmbedding = new LocalEmbeddingProcess({ stateDir: process.env.RIPPLE_DESKTOP_STATE ?? app.getPath('userData'), candidates,
    serverScript: app.isPackaged ? join(app.getAppPath() + '.unpacked', 'wemm/server.py') : join(here, 'wemm/server.py') });
  await localEmbedding.initialize();
  const appIcon = nativeImage.createFromPath(join(here, 'renderer/brand/ripple-logo.png'));
  // Keep macOS's bundle icon treatment (background and frame) after launch.
  // Replacing it with the transparent in-app logo bypasses that treatment.
  if (!app.isPackaged && !appIcon.isEmpty()) app.dock?.setIcon(appIcon);
const assets = join(here, 'renderer');
protocol.handle('ripple', async request => {
  const url = new URL(request.url);
  const path = resolve(assets, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
  if (url.hostname !== 'app' || relative(assets, path) === '..' || relative(assets, path).startsWith(`..${sep}`) || path === assets) return new Response('Not found', { status: 404 });
  const response = await net.fetch(pathToFileURL(path).toString());
  response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'");
  return response;
});
window = new BrowserWindow({ ...(process.platform === 'darwin' && app.isPackaged ? {} : { icon: appIcon }), width: 1420, height: 920, minWidth: 980, minHeight: 660, show: false, backgroundColor: '#f7f8fa', title: 'Ripple', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 21 }, vibrancy: 'sidebar', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
ipcMain.handle('ripple:command', async (event, command) => {
  if (!trusted(event)) return { ok: false, error: { code: 'ORIGIN', message: 'Untrusted sender' } };
  const credentialDir = activeStateDir;
  const response = await askWorker({ command }, command?.type === 'configure-embedding' ? 90000 : 30000).catch(() => ({ ok: false, error: { code: 'HOST', message: '目录服务不可用，请重新打开目录' } }));
  if (response.ok && command?.type === 'configure-embedding' && credentialDir) {
    const secret = join(credentialDir, 'embedding-secret.bin');
    try {
      if (command.settings.apiKey && safeStorage.isEncryptionAvailable()) await writeFile(secret, safeStorage.encryptString(command.settings.apiKey), { mode: 0o600 });
      else await rm(secret, { force: true });
    } catch { /* Connection remains usable; the next run will request credentials again. */ }
  }
  return response;
});
ipcMain.handle('ripple:local-embedding-status', async event => { if (trusted(event)) return localEmbedding.refresh(); });
ipcMain.handle('ripple:local-embedding-start', async event => { if (trusted(event)) return localEmbedding.start(); });
ipcMain.handle('ripple:local-embedding-stop', async event => {
  if (!trusted(event)) return;
  const current = await askWorker({ command: { type: 'state' } });
  if (localEmbedding.state.managed && current.result?.indexing && isManagedEmbeddingUrl(current.result.embeddingConnection?.baseUrl ?? '', localEmbedding.state.baseUrl)) await askWorker({ command: { type: 'cancel-index' } });
  return localEmbedding.stop();
});
ipcMain.handle('ripple:local-embedding-auto', async (event, enabled) => { if (trusted(event) && typeof enabled === 'boolean') return localEmbedding.setAutoStart(enabled); });
ipcMain.handle('ripple:local-embedding-runtime', async event => {
  if (!trusted(event)) return;
  const selected = await dialog.showOpenDialog(window, { title: '选择已有 WeMM 运行环境（包含 venv 和 models 的目录）', properties: ['openDirectory', 'showHiddenFiles'] });
  if (!selected.canceled && selected.filePaths[0]) return localEmbedding.chooseRuntime(selected.filePaths[0]);
});
ipcMain.handle('ripple:recent-workspaces', event => trusted(event) ? history.list() : []);
ipcMain.handle('ripple:forget-workspace', async (event, id) => { if (trusted(event) && typeof id === 'string') { await history.forget(id); window.webContents.send('ripple:changed'); } });
ipcMain.handle('ripple:open-recent', async (event, id) => {
  if (!trusted(event) || !await mayLeave()) return false;
  const entry = history.list().find(e => e.id === id); if (!entry) return false;
  try { await openFolder(entry.location, entry.readOnly); dirty = false; return true; }
  catch { await dialog.showMessageBox(window, { type: 'error', message: '工作区暂不可用', detail: '目录可能已移动、删除或尚未挂载。你可以重新选择目录，或从最近列表移除。' }); return false; }
});
let folderSelection: { token: string; root: string } | undefined;
ipcMain.handle('ripple:prepare-folder', async event => {
  if (!trusted(event) || !await mayLeave()) return;
  folderSelection = undefined;
  const result = await dialog.showOpenDialog(window, { title: '选择 Markdown 知识目录', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return;
  const root = await realpath(result.filePaths[0]);
  const paths = await listMarkdownPaths(root);
  const stateDir = join(process.env.RIPPLE_DESKTOP_STATE ?? app.getPath('userData'), 'vaults', createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24));
  let ignoreRules = '';
  try { ignoreRules = JSON.parse(await readFile(join(stateDir, 'knowledge-settings.json'), 'utf8')).ignoreRules ?? ''; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const token = String(++sequence); folderSelection = { token, root };
  return { token, label: root.split('/').at(-1), paths, ignoreRules };
});
ipcMain.handle('ripple:import-folder', async (event, token, rules, readOnly) => {
  if (!trusted(event) || !folderSelection || token !== folderSelection.token || typeof readOnly !== 'boolean' || !await mayLeave()) return false;
  knowledgeFilter(rules);
  const { root } = folderSelection;
  await readVault(root, { allMarkdown: true, ignoreRules: rules });
  await openFolder(root, readOnly, rules); folderSelection = undefined; dirty = false; return true;
});
ipcMain.handle('ripple:choose-folder', async (event, readOnly) => {
  if (!trusted(event) || typeof readOnly !== 'boolean' || !await mayLeave()) return false;
  const result = await dialog.showOpenDialog(window, { title: '选择 Markdown 知识目录', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return false;
  try { await openFolder(result.filePaths[0], readOnly); dirty = false; return true; }
  catch { await dialog.showMessageBox(window, { type: 'error', message: '无法打开该目录', detail: '请确认目录可读，且内容为 UTF-8 Markdown。' }); return false; }
});
ipcMain.handle('ripple:choose-embedding', async event => {
  if (!trusted(event)) return false;
  const result = await dialog.showOpenDialog(window, { title: '选择 Embedding 配置', properties: ['openFile'], filters: [{ name: 'JSON 配置', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return false;
  const answer = await askWorker({ configure: result.filePaths[0] });
  if (!answer.ok) await dialog.showMessageBox(window, { type: 'warning', message: '模型暂不可用', detail: answer.error.message });
  return answer.ok;
});
ipcMain.on('ripple:dirty', (event, value) => { if (trusted(event)) { dirty = !!value; window.setDocumentEdited(dirty); } });
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'Ripple', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
  { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: '显示', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
]));
window.on('close', event => { if (!quitting) { event.preventDefault(); void mayLeave().then(async allowed => { if (allowed) { quitting = true; await stopWorker(); await localEmbedding.stop(); window.destroy(); app.quit(); } }); } });
await window.loadURL('ripple://app/');
window.show();
if (localEmbedding.restoreOnLaunch) void resumeLocalEmbedding();
const vaultIndex = process.argv.indexOf('--vault');
if (vaultIndex >= 0 && process.argv[vaultIndex + 1]) await openFolder(process.argv[vaultIndex + 1]!, process.argv.includes('--readonly'));
else { const last = history.list()[0]; if (last) { try { await openFolder(last.location, last.readOnly); } catch { window.webContents.send('ripple:changed'); } } }
}).catch(error => { console.error('Ripple startup failed:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
