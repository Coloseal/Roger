const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bhr', {
  isDesktop: true,
  onToggle: (cb) => ipcRenderer.on('ptt-toggle', () => cb()),
  getLabel: () => ipcRenderer.invoke('ptt-get-label'),
  setKey: (k) => ipcRenderer.invoke('ptt-set-key', {
    code: String(k.code), ctrl: !!k.ctrl, alt: !!k.alt, shift: !!k.shift,
  }),
});
