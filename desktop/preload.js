const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bhr', {
  isDesktop: true,
  // global hotkeys: ids are 'talk', 'repeat', 'ch:<CHANNEL>', 'slot:<1-9>'
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, id) => cb(String(id))),
  getHotkeys: () => ipcRenderer.invoke('hk-get'),
  setHotkey: (id, k) => ipcRenderer.invoke('hk-set', String(id), {
    code: String(k.code), ctrl: !!k.ctrl, alt: !!k.alt, shift: !!k.shift,
  }),
  clearHotkey: (id) => ipcRenderer.invoke('hk-clear', String(id)),
  setSlotScheme: (s) => ipcRenderer.invoke('slots-set', String(s)),
  // overlay (the small transmit / receive indicator)
  overlay: (s) => ipcRenderer.send('overlay-set', { mode: String(s.mode), name: String(s.name || ''), channel: String(s.channel || '') }),
  getOverlay: () => ipcRenderer.invoke('overlay-get'),
  setOverlay: (c) => ipcRenderer.invoke('overlay-cfg', c),
  testOverlay: () => ipcRenderer.send('overlay-test'),
  getOnTop: () => ipcRenderer.invoke('get-on-top'),
  setOnTop: (v) => ipcRenderer.invoke('set-on-top', !!v),
  getStartup: () => ipcRenderer.invoke('get-startup'),
  setStartup: (v) => ipcRenderer.invoke('set-startup', !!v),
  // tray / closing
  getCloseMode: () => ipcRenderer.invoke('close-mode-get'),
  setCloseMode: (v) => ipcRenderer.invoke('close-mode-set', String(v)),
  onCloseMode: (cb) => ipcRenderer.on('close-mode', (_e, v) => cb(String(v))),
  quitApp: () => ipcRenderer.invoke('app-quit'),
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  // updates
  getUpdate: () => ipcRenderer.invoke('upd-get'),
  checkUpdate: () => ipcRenderer.invoke('upd-check'),
  installUpdate: () => ipcRenderer.invoke('upd-install'),
  onUpdate: (cb) => ipcRenderer.on('update-state', (_e, s) => cb(s)),
});
