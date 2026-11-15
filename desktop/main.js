// Roger desktop app.
// Wraps the hosted web client and adds a GLOBAL talk key (Windows RegisterHotKey via
// Electron's globalShortcut) that keeps working while the game has focus.
// RegisterHotKey only reports key presses, so the global key is press-to-talk / press-again-to-stop.
// (Holding Space inside the app window is still true hold-to-talk.)

const { app, BrowserWindow, ipcMain, session, shell, Menu, net, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

const SERVER_URL = (process.env.BHR_SERVER || require('./config.json').serverUrl).replace(/\/+$/, '');
const SERVER_ORIGIN = new URL(SERVER_URL).origin;

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ---- settings ------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { accel: 'F8' };
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

function registerTalkKey(accel) {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(accel, () => sendToWin('ptt-toggle'));
    return !!ok;
  } catch { return false; }
}
const label = () => (globalShortcut.isRegistered(settings.accel) ? settings.accel : `${settings.accel} (unavailable)`);

ipcMain.handle('ptt-get-label', () => label());
// Renderer captured a key press while rebinding: {code, ctrl, alt, shift}
ipcMain.handle('ptt-set-key', (_e, k) => {
  const key = codeToKey(String(k && k.code));
  if (!key) return { ok: false, error: 'That key can\'t be used. Try a letter, number, F-key or symbol.', label: label() };
  const accel = [k.ctrl && 'Control', k.alt && 'Alt', k.shift && 'Shift', key].filter(Boolean).join('+');
  const previous = settings.accel;
  if (!registerTalkKey(accel)) {
    registerTalkKey(previous);
    return { ok: false, error: `${accel} is already used by another program.`, label: label() };
  }
  settings.accel = accel; saveSettings();
  return { ok: true, label: label() };
});

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
    width: 980, height: 720, minWidth: 360, minHeight: 520,
    backgroundColor: '#0d110c', title: 'Roger', icon: path.join(__dirname, 'icon.png'),
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
  win.on('closed', () => { win = null; });
  loadClient();
}

app.whenReady().then(() => {
  loadSettings();
  Menu.setApplicationMenu(null);
  // Allow the microphone for our own pages only.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    const u = wc.getURL();
    cb(perm === 'media' && (u.startsWith(SERVER_ORIGIN) || u.startsWith('file:')));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  registerTalkKey(settings.accel);
  createWindow();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
