import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { join, resolve, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

protocol.registerSchemesAsPrivileged([{ scheme: 'ripple', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Ripple');
const here = fileURLToPath(new URL('.', import.meta.url));
let window: BrowserWindow;
let worker: Worker | undefined;
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
async function openFolder(root: string, readOnly: boolean): Promise<void> {
  await stopWorker();
  const stateDir = join(process.env.RIPPLE_DESKTOP_STATE ?? app.getPath('userData'), 'vaults', createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24));
  await mkdir(stateDir, { recursive: true });
  worker = new Worker(join(here, 'worker.mjs'), { workerData: { root, stateDir, readOnly } });
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
  window.setTitle(`Ripple — ${root.split(/[\\/]/).at(-1)}`);
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
const assets = join(here, 'renderer');
protocol.handle('ripple', async request => {
  const url = new URL(request.url);
  const path = resolve(assets, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
  if (url.hostname !== 'app' || relative(assets, path) === '..' || relative(assets, path).startsWith(`..${sep}`) || path === assets) return new Response('Not found', { status: 404 });
  const response = await net.fetch(pathToFileURL(path).toString());
  response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'");
  return response;
});
window = new BrowserWindow({ width: 1420, height: 920, minWidth: 980, minHeight: 660, show: false, backgroundColor: '#f7f8fa', title: 'Ripple', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 21 }, vibrancy: 'sidebar', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
ipcMain.handle('ripple:command', (event, command) => {
  if (!trusted(event)) return { ok: false, error: { code: 'ORIGIN', message: 'Untrusted sender' } };
  return askWorker({ command }, command?.type === 'configure-embedding' ? 90000 : 30000).catch(() => ({ ok: false, error: { code: 'HOST', message: '目录服务不可用，请重新打开目录' } }));
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
window.on('close', event => { if (!quitting) { event.preventDefault(); void mayLeave().then(async allowed => { if (allowed) { quitting = true; await stopWorker(); window.destroy(); app.quit(); } }); } });
await window.loadURL('ripple://app/');
window.show();
const vaultIndex = process.argv.indexOf('--vault');
if (vaultIndex >= 0 && process.argv[vaultIndex + 1]) await openFolder(process.argv[vaultIndex + 1]!, process.argv.includes('--readonly'));
}).catch(error => { console.error('Ripple startup failed:', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
