const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ripple', Object.freeze({
  supportsEmbedding: true,
  supportsKnowledgeSettings: true,
  supportsGlobalGraph: true,
  // Keep errors as data across contextBridge; custom Error properties are not preserved by Electron.
  command: (command) => ipcRenderer.invoke('ripple:command', command),
  recentWorkspaces: () => ipcRenderer.invoke('ripple:recent-workspaces'),
  openRecent: (id) => ipcRenderer.invoke('ripple:open-recent', id),
  forgetWorkspace: (id) => ipcRenderer.invoke('ripple:forget-workspace', id),
  prepareFolder: () => ipcRenderer.invoke('ripple:prepare-folder'),
  importFolder: (token, rules, readOnly) => ipcRenderer.invoke('ripple:import-folder', token, rules, readOnly),
  chooseFolder: (readOnly) => ipcRenderer.invoke('ripple:choose-folder', readOnly),
  chooseEmbedding: () => ipcRenderer.invoke('ripple:choose-embedding'),
  setDirty: (dirty) => ipcRenderer.send('ripple:dirty', !!dirty),
  subscribe: (listener) => { const wrapped = () => listener(); ipcRenderer.on('ripple:changed', wrapped); return () => ipcRenderer.removeListener('ripple:changed', wrapped); },
}));
