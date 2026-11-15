const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ov', { on: (cb) => ipcRenderer.on('ov-state', (_e, s) => cb(s)) });
