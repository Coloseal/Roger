// Roger desktop app.
// Wraps the hosted web client and adds a GLOBAL talk key (Windows RegisterHotKey via
// Electron's globalShortcut) that keeps working while the game has focus.
// RegisterHotKey only reports key presses, so the global key is press-to-talk / press-again-to-stop.
// (Holding Space inside the app window is still true hold-to-talk.)

const { app, BrowserWindow, ipcMain, session, shell, Menu, net, globalShortcut, screen, Tray, dialog, nativeImage, systemPreferences } = require('electron');
const IS_MAC = process.platform === 'darwin';
const path = require('path');
const fs = require('fs');

const SERVER_URL = (process.env.BHR_SERVER || require('./config.json').serverUrl).replace(/\/+$/, '');
const SERVER_ORIGIN = new URL(SERVER_URL).origin;

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ---- settings ------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { onTop: false };
function loadSettings() { try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {} }
function saveSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch {} }

// ---- global talk key -------------------------------------------------------
let win = null;
const sendToWin = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };

const SPECIAL = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
function codeToKey(code) {
  if (SPECIAL[code]) return SPECIAL[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^F(\d{1,2})$/.exec(code))) return 'F' + m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return 'num' + m[1];
  return null;
}

// Global hotkeys: id -> accelerator. ids: 'talk', 'repeat', and 'ch:<CHANNEL NAME>' for per-channel talk keys.
// (Windows only reports key *presses* to global hotkeys, so "talk" keys switch on / off.)
let hotkeys = {};
let failedKeys = {};
// "Favorite channel" hotkeys: slot N (the Nth channel in your list) gets the Nth key of the chosen scheme.
const SLOT_SCHEMES = {
  none: null,
  num: (n) => `num${n}`,
  ctrlnum: (n) => `Control+num${n}`,
  ctrlaltnum: (n) => `Control+Alt+num${n}`,
  ctrlf: (n) => `Control+F${n}`,
  ctrlaltf: (n) => `Control+Alt+F${n}`,
  shiftf: (n) => `Shift+F${n}`,
  altf: (n) => `Alt+F${n}`,
};
let slotScheme = 'none';
function registerAll() {
  globalShortcut.unregisterAll(); failedKeys = {};
  for (const [id, accel] of Object.entries(hotkeys)) {
    let ok = false;
    try { ok = globalShortcut.register(accel, () => sendToWin('hotkey', id)); } catch {}
    if (!ok) failedKeys[id] = true;
  }
  const fmt = SLOT_SCHEMES[slotScheme];
  if (fmt) for (let n = 1; n <= 9; n++) {
    const accel = fmt(n), id = 'slot:' + n;
    if (Object.values(hotkeys).some((a) => a.toLowerCase() === accel.toLowerCase())) { failedKeys[id] = true; continue; }
    let ok = false;
    try { ok = globalShortcut.register(accel, () => sendToWin('hotkey', id)); } catch {}
    if (!ok) failedKeys[id] = true;
  }
}
const hotkeyState = () => ({ keys: { ...hotkeys }, failed: { ...failedKeys }, slotScheme });

ipcMain.handle('hk-get', () => hotkeyState());
ipcMain.handle('slots-set', (_e, scheme) => {
  if (!Object.prototype.hasOwnProperty.call(SLOT_SCHEMES, scheme)) return hotkeyState();
  slotScheme = scheme; settings.slotScheme = scheme; saveSettings(); registerAll();
  return hotkeyState();
});
// Renderer captured a key press: {code, ctrl, alt, shift}
ipcMain.handle('hk-set', (_e, id, k) => {
  id = String(id);
  const key = codeToKey(String(k && k.code));
  if (!key) return { ok: false, error: 'That key can\'t be used. Try a letter, number, F-key or symbol.', ...hotkeyState() };
  const accel = [k.ctrl && 'Control', k.alt && 'Alt', k.shift && 'Shift', key].filter(Boolean).join('+');
  const clash = Object.entries(hotkeys).find(([other, a]) => other !== id && a.toLowerCase() === accel.toLowerCase());
  if (clash) return { ok: false, error: `${accel} is already used for another action in Roger.`, ...hotkeyState() };
  const previous = hotkeys[id];
  hotkeys[id] = accel; registerAll();
  if (failedKeys[id]) {
    if (previous) hotkeys[id] = previous; else delete hotkeys[id];
    registerAll();
    return { ok: false, error: `${accel} is already used by another program.`, ...hotkeyState() };
  }
  settings.hotkeys = hotkeys; saveSettings();
  return { ok: true, ...hotkeyState() };
});
ipcMain.handle('hk-clear', (_e, id) => {
  delete hotkeys[String(id)]; registerAll(); settings.hotkeys = hotkeys; saveSettings();
  return { ok: true, ...hotkeyState() };
});

// ---- transmit / receive overlay -------------------------------------------
// A tiny click-through window in a screen corner: green arrows right while you talk, amber arrows left
// with the speaker's name while someone else talks. It never takes focus from the game.
const OV_W = 280, OV_H = 56, OV_MARGIN = 16;
let ovWin = null, ovLoaded = false, ovLast = { mode: 'off' }, ovHideTimer = null;
const ovCfg = () => ({ on: settings.overlayOn !== false, pos: settings.overlayPos || 'bottom-right' });

function ovPlace() {
  if (!ovWin || ovWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea, pos = ovCfg().pos;
  const x = pos.endsWith('left') ? wa.x + OV_MARGIN : pos.endsWith('center') ? wa.x + Math.round((wa.width - OV_W) / 2) : wa.x + wa.width - OV_W - OV_MARGIN;
  const y = pos.startsWith('top') ? wa.y + OV_MARGIN : wa.y + wa.height - OV_H - OV_MARGIN;
  ovWin.setBounds({ x, y, width: OV_W, height: OV_H });
}
function ovEnsure() {
  if (ovWin && !ovWin.isDestroyed()) return ovWin;
  ovLoaded = false;
  ovWin = new BrowserWindow({
    width: OV_W, height: OV_H, show: false, frame: false, transparent: true, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, title: 'Roger overlay',
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  ovWin.setIgnoreMouseEvents(true);
  ovWin.setAlwaysOnTop(true, 'screen-saver');
  ovWin.webContents.once('did-finish-load', () => { ovLoaded = true; ovWin.webContents.send('ov-state', ovLast); });
  ovWin.on('closed', () => { ovWin = null; ovLoaded = false; });
  ovWin.loadFile(path.join(__dirname, 'overlay.html'));
  return ovWin;
}
function ovApply(s) {
  ovLast = s;
  clearTimeout(ovHideTimer);
  if (!ovCfg().on || !s || s.mode === 'off') {
    if (ovWin && !ovWin.isDestroyed()) {
      if (ovLoaded) ovWin.webContents.send('ov-state', { mode: 'off' });
      ovHideTimer = setTimeout(() => { if (ovWin && !ovWin.isDestroyed()) ovWin.hide(); }, 260);   // let the fade-out finish
    }
    return;
  }
  const w = ovEnsure(); ovPlace();
  if (ovLoaded) w.webContents.send('ov-state', s);
  if (!w.isVisible()) w.showInactive();
}
ipcMain.on('overlay-set', (_e, s) => ovApply(s && typeof s === 'object' ? { mode: String(s.mode), name: String(s.name || ''), channel: String(s.channel || '') } : { mode: 'off' }));
ipcMain.handle('overlay-get', () => ovCfg());
ipcMain.handle('overlay-cfg', (_e, c) => {
  if (c && typeof c.on === 'boolean') settings.overlayOn = c.on;
  if (c && ['bottom-right', 'bottom-left', 'bottom-center', 'top-right', 'top-left', 'top-center'].includes(c.pos)) settings.overlayPos = c.pos;
  saveSettings(); if (!ovCfg().on) ovApply({ mode: 'off' }); else ovPlace();
  return ovCfg();
});
ipcMain.on('overlay-test', () => {
  ovApply({ mode: 'tx', name: 'You', channel: 'TEST' });
  setTimeout(() => ovApply({ mode: 'rx', name: 'Viper-1', channel: 'TEST' }), 1700);
  setTimeout(() => ovApply({ mode: 'off' }), 3400);
});

ipcMain.handle('get-startup', () => !!app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-startup', (_e, v) => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!v, args: ['--hidden'] });
  return !!app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('get-on-top', () => !!settings.onTop);
ipcMain.handle('set-on-top', (_e, v) => {
  settings.onTop = !!v; saveSettings();
  // 'screen-saver' level keeps the window above borderless-fullscreen games too.
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(settings.onTop, 'screen-saver');
  return settings.onTop;
});

// ---- auto-update (installed app only) -------------------------------------
// New versions are published as GitHub Releases. The app checks once, every time it starts. If there is a newer
// version it downloads it right away, installs it and reopens itself (a small "Updating Roger" window shows progress).
// There is no background timer: you only get updates when you launch the app.
let updater = null;
let updState = { state: app.isPackaged ? 'idle' : 'dev', version: app.getVersion() };
let updWin = null;
function updSplash(text) {
  try {
    if (!updWin || updWin.isDestroyed()) {
      updWin = new BrowserWindow({ width: 380, height: 120, frame: false, resizable: false, movable: true, alwaysOnTop: true, center: true, skipTaskbar: false, show: false, backgroundColor: '#0a0e14', title: 'Updating Roger' });
      updWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<body style="margin:0;background:#0a0e14;color:#cfd8e3;font-family:Segoe UI,sans-serif;display:flex;flex-direction:column;justify-content:center;height:100vh;padding:0 26px;box-sizing:border-box;border:1px solid #2a384c">' +
        '<div style="font-size:17px;font-weight:600;color:#7ee787">Updating Roger</div>' +
        '<div id="t" style="margin-top:6px;font-size:13px"></div>' +
        '<div style="margin-top:12px;height:6px;background:#1d2735;border-radius:3px;overflow:hidden"><div id="b" style="height:100%;width:0;background:#7ee787"></div></div></body>'));
      updWin.once('ready-to-show', () => updWin && !updWin.isDestroyed() && updWin.show());
    }
    const pct = Math.max(0, Math.min(100, text.pct || 0));
    updWin.webContents.executeJavaScript(`document.getElementById('t').textContent=${JSON.stringify(text.msg)};document.getElementById('b').style.width='${pct}%'`).catch(() => {});
  } catch {}
}
function closeSplash() { try { if (updWin && !updWin.isDestroyed()) updWin.destroy(); } catch {} updWin = null; }
function setUpd(s) { updState = { ...updState, ...s }; sendToWin('update-state', updState); }
function initUpdater() {
  const testFeed = process.env.BHR_UPDATE_URL;            // lets us test updates against a local folder
  if (!app.isPackaged && !testFeed) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) { console.error('updater unavailable:', e.message); return; }
  // Windows installs updates by itself. The Mac version isn't code-signed (that needs a paid Apple account), and macOS refuses
  // to self-install unsigned updates, so on a Mac we just tell you a new version exists and open the download page.
  updater.autoDownload = !IS_MAC;
  updater.autoInstallOnAppQuit = !IS_MAC;
  if (testFeed) { updater.forceDevUpdateConfig = true; updater.setFeedURL({ provider: 'generic', url: testFeed }); }
  updater.on('checking-for-update', () => setUpd({ state: 'checking', error: '' }));
  updater.on('update-available', (i) => {
    if (IS_MAC) {
      setUpd({ state: 'available', next: i.version });
      dialog.showMessageBox({ type: 'info', buttons: ['Download', 'Later'], defaultId: 0, title: 'Roger update', message: `Roger ${i.version} is available.`, detail: 'Download the new version, open it, and drag Roger into Applications (replace the old one).' })
        .then((r) => { if (r.response === 0) shell.openExternal('https://github.com/Coloseal/Roger/releases/latest'); }).catch(() => {});
      return;
    }
    setUpd({ state: 'downloading', next: i.version, percent: 0 }); updSplash({ msg: `Downloading version ${i.version}…`, pct: 0 });
  });
  updater.on('update-not-available', () => setUpd({ state: 'none' }));
  updater.on('download-progress', (p) => { const pc = Math.round(p.percent || 0); setUpd({ state: 'downloading', percent: pc }); updSplash({ msg: `Downloading version ${updState.next || ''}… ${pc}%`, pct: pc }); });
  updater.on('update-downloaded', (i) => {
    setUpd({ state: 'ready', next: i.version, percent: 100 });
    console.log('UPDATE-READY ' + i.version);
    if (process.env.BHR_UPDATE_DRYRUN) { closeSplash(); return; }       // (testing only: don't really install)
    updSplash({ msg: `Installing version ${i.version}. Roger will reopen by itself…`, pct: 100 });
    setTimeout(() => { try { quitting = true; updater.quitAndInstall(true, true); } catch (e) { closeSplash(); } }, 800);   // silent install, then reopen
  });
  updater.on('error', (e) => { closeSplash(); setUpd({ state: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 140) }); });
  const check = () => { if (updState.state !== 'downloading' && updState.state !== 'ready') updater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 1500);                                // once per launch, no timer
  updater.__check = check;
}
ipcMain.handle('upd-get', () => updState);
ipcMain.handle('upd-check', () => {
  if (!updater) { setUpd({ state: app.isPackaged ? 'error' : 'dev', error: app.isPackaged ? 'Updater not available' : '' }); return updState; }
  if (updState.state !== 'downloading' && updState.state !== 'ready') updater.checkForUpdates().catch(() => {});
  return updState;
});
ipcMain.handle('upd-install', () => {
  if (updater && updState.state === 'ready') updater.quitAndInstall(true, true);   // silent install, then relaunch
});

// ---- tray + quitting ------------------------------------------------------
// Closing the window (X) can keep Roger running in the system tray, so your hotkeys and incoming voice keep working.
// Right-click the tray icon -> "Quit Roger" ends everything (main window, overlay and background processes).
let tray = null, quitting = false;
const closeToTray = () => settings.closeToTray !== false;

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function quitApp() {
  quitting = true;
  try { if (ovWin && !ovWin.isDestroyed()) ovWin.destroy(); } catch {}
  app.quit();
}
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Roger', click: showWindow },
    {
      label: 'Closing the window keeps Roger running here', type: 'checkbox', checked: closeToTray(),
      click: (item) => { settings.closeToTray = item.checked; saveSettings(); sendToWin('close-mode', closeToTray() ? 'tray' : 'quit'); },
    },
    { type: 'separator' },
    { label: 'Quit Roger', click: quitApp },
  ]);
}
function buildTray() {
  try {
    // Windows uses the .ico; the Mac menu bar needs a small PNG.
    tray = new Tray(IS_MAC ? nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 18, height: 18 }) : path.join(__dirname, 'icon.ico'));
    tray.setToolTip('Roger');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => { if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) win.hide(); else showWindow(); });
    tray.on('double-click', showWindow);
  } catch (e) { console.error('tray unavailable:', e.message); tray = null; }
}
ipcMain.handle('close-mode-get', () => (closeToTray() ? 'tray' : 'quit'));
ipcMain.handle('close-mode-set', (_e, v) => {
  settings.closeToTray = v !== 'quit'; saveSettings();
  if (tray) tray.setContextMenu(buildTrayMenu());
  return closeToTray() ? 'tray' : 'quit';
});
ipcMain.handle('app-quit', () => quitApp());
ipcMain.handle('app-info', () => ({ version: app.getVersion(), tray: !!tray && !tray.isDestroyed(), closeMode: closeToTray() ? 'tray' : 'quit', packaged: app.isPackaged }));

// ---- window ---------------------------------------------------------------
async function waitForServer() {
  // Free hosting sleeps when idle; poll /health until it answers, then load the client.
  for (;;) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await net.fetch(SERVER_URL + '/health', { signal: ctrl.signal }); clearTimeout(t);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2500));
    if (!win || win.isDestroyed()) return;
  }
}

async function loadClient() {
  if (!win || win.isDestroyed()) return;
  await win.loadFile(path.join(__dirname, 'loading.html'));
  await waitForServer();
  if (win && !win.isDestroyed()) win.loadURL(SERVER_URL);
}

function createWindow() {
  win = new BrowserWindow({
    // Started by Windows at login (--hidden): go straight to the tray instead of popping up over whatever you're doing.
    show: !(process.argv.includes('--hidden') && closeToTray() && tray),
    width: 400, height: 680, minWidth: 320, minHeight: 440,
    backgroundColor: '#0a0e14', title: 'Roger', icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,                       // keep audio flowing while minimized / behind the game
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && new URL(url).origin !== SERVER_ORIGIN) e.preventDefault();
  });
  win.webContents.on('did-fail-load', (_e, _code, _desc, url, isMain) => {
    if (isMain && url.startsWith(SERVER_URL)) setTimeout(loadClient, 1500);   // server dropped or asleep: retry
  });
  win.on('close', (e) => {
    if (quitting) return;
    if (closeToTray() && tray) {                      // X = hide to the tray; Quit is in the tray menu
      e.preventDefault(); win.hide();
      if (!settings.trayHintShown) {
        settings.trayHintShown = true; saveSettings();
        try { tray.displayBalloon({ title: 'Roger is still running', content: 'It stays in the tray so your keys and incoming voice keep working. Right-click the tray icon and choose Quit to exit.' }); } catch {}
      }
    } else { quitApp(); }                             // not using the tray: closing the window really quits
  });
  win.on('session-end', () => { quitting = true; });     // Windows is shutting down / logging off: don't block it
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => sendToWin('update-state', updState));   // (re)show update status after each page load
  if (settings.onTop) win.setAlwaysOnTop(true, 'screen-saver');
  loadClient();
}

app.whenReady().then(() => {
  loadSettings();
  Menu.setApplicationMenu(null);
  // Allow the microphone for our own pages only (Roger no longer shows desktop notifications).
  const allowed = (perm) => perm === 'media';
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    const u = wc.getURL();
    cb(allowed(perm) && (u.startsWith(SERVER_ORIGIN) || u.startsWith('file:')));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed(perm));
  // (On a Mac the F-keys are media keys by default, so the starting keys are Option-based. Change them in Settings → Control.)
  hotkeys = settings.hotkeys || (IS_MAC ? { talk: 'Alt+Space', repeat: 'Alt+Shift+Space' } : { talk: settings.accel || 'F8', repeat: 'Shift+F8' });
  if (IS_MAC) { try { systemPreferences.askForMediaAccess('microphone'); } catch {} }   // macOS asks once for microphone access
  slotScheme = Object.prototype.hasOwnProperty.call(SLOT_SCHEMES, settings.slotScheme) ? settings.slotScheme : 'none';
  registerAll();
  buildTray();
  createWindow();
  initUpdater();
});
app.on('activate', () => showWindow());                  // Mac: clicking the Dock icon brings the window back
app.on('second-instance', () => showWindow());          // launching Roger again brings the (hidden) window back
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', () => {
  quitting = true;
  try { if (ovWin && !ovWin.isDestroyed()) ovWin.destroy(); } catch {}   // the hidden overlay window must not keep the app alive
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); try { if (tray) tray.destroy(); } catch {} });
