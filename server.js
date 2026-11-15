// Roger - push-to-talk relay server with locked-down accounts.
// Nobody can use the radio without an account that a moderator created. One WebSocket per player. Per channel, the
// server hands the "floor" to one talker at a time (half-duplex, like a real radio) and relays that talker's audio.
//
// Setup (set these as environment variables on your host - never put them in the code):
//   ADMIN_USER / ADMIN_PASSWORD   your owner login. Created on first start; changing the password here resets it.
//   DATABASE_URL                  a Postgres connection string (Neon, Supabase...). Without it accounts are kept in a file
//                                 that free hosting wipes at every restart.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createStore } = require('./lib/store');
const { Accounts } = require('./lib/accounts');
const { signToken, readToken, Limiter } = require('./lib/auth');

const PORT = process.env.PORT || 3000;
const MAX_TALK_MS = 60_000;            // safety: a stuck mic can't hog a channel forever
const MAX_CHANNELS = 200;
const MAX_NAME = 20;
const MAX_FRAME_BYTES = 16 * 1024;
const TOKEN_LIFE_MS = 30 * 24 * 3600 * 1000;
const KICK_BLOCK_MS = 10 * 60 * 1000;  // kicked from a channel = can't rejoin it for 10 minutes

// Preset channels (name <= 20 chars) and who they are for. `desc` is shown in the app.
const MECH = 'Mechanized crew <-> their assigned squad comms (SL & TLs). Handed out before deployments.';
const DEFAULT_CHANNELS = [
  { name: 'GROUND CHANNEL 1', desc: 'Routine: MAF/SAF <-> TF HQ' },
  { name: 'GROUND CHANNEL 2', desc: 'Emergency: MAF/SAF <-> TF HQ' },
  { name: 'AIR CHANNEL', desc: 'JTAC <-> Air Element' },
  { name: 'GROUND VEHICLES', desc: 'Mechanized/G. Logistics <-> squad-operated vehicles. Ground-operated vehicles <-> TF HQ.' },
  { name: 'MECH CREW 1', desc: MECH },
  { name: 'MECH CREW 2', desc: MECH },
  { name: 'MECH CREW 3', desc: MECH },
  { name: 'MECH CREW 4', desc: MECH },
  { name: 'RECON BROADCAST', desc: 'Recon/FRT intel broadcast to MAF/SAF/TF HQ. Recon/FRT <-> TF HQ routine and emergency.' },
  { name: 'HQ CHANNEL', desc: 'TF HQ <-> Zeus / Zeus 2IC / OPF. Lead' },
  { name: 'RADIO CHECK', desc: 'Open channel for testing your mic and speakers.' },
];

// ---- radio state ---------------------------------------------------------
let nextClientId = 1;
let nextChannelId = 1;
const clients = new Map();   // connection id -> client
const channels = new Map();  // name -> channel
const bans = new Map();      // "userId|CHANNEL" -> time the block ends
// Channel modes (set by moderators, remembered in the database):
//   'queue' = one person talks at a time; others wait their turn (like a real radio)   <- default
//   'open'  = open net: everyone can talk at the same time and you hear them all mixed together
const modes = {};            // channel name -> 'open' (only open ones are stored)

function getChannel(name, isDefault = false, desc = '') {
  let ch = channels.get(name);
  if (!ch) {
    if (channels.size >= MAX_CHANNELS) return null;
    ch = { id: nextChannelId++, name, isDefault, desc, members: new Set(), talkers: new Set(), waiters: [], mode: modes[name] === 'open' ? 'open' : 'queue' };
    channels.set(name, ch);
  }
  return ch;
}
DEFAULT_CHANNELS.forEach((c) => getChannel(c.name, true, c.desc));

// ---- message history -----------------------------------------------------
// Recent transmissions per channel, kept in memory so late joiners can listen back.
// Free hosting has no disk, so history is cleared whenever the server restarts or sleeps.
const HISTORY_PER_CHANNEL = 40;
const HISTORY_MAX_BYTES = 60 * 1024 * 1024;   // ~30 min of audio across all channels
const HISTORY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MIN_MSG_BYTES = 9600;                   // ~0.3 s at 16 kHz Int16: ignore blips
let nextMsgId = 1, history = [], historyBytes = 0;

const metaOf = (m) => ({ id: m.id, from: m.from, ts: m.ts, ms: m.ms });

function addHistory(item) {
  history.push(item); historyBytes += item.pcm.length;
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) if (history[i].ch === item.ch && ++n > HISTORY_PER_CHANNEL) { historyBytes -= history[i].pcm.length; history.splice(i, 1); }
  while (history.length && (historyBytes > HISTORY_MAX_BYTES || history[0].ts < cutoff)) historyBytes -= history.shift().pcm.length;
}

function finalizeRecording(client) {
  const rec = client.rec; client.rec = null;
  if (!rec || rec.bytes < MIN_MSG_BYTES) return;
  const pcm = Buffer.concat(rec.chunks, rec.bytes);
  const item = { id: nextMsgId++, ch: rec.ch.name, from: client.name, ts: rec.ts, ms: Math.round(pcm.length / 32), pcm };
  addHistory(item);
  const msg = JSON.stringify({ type: 'history_add', ch: item.ch, item: metaOf(item) });
  for (const m of rec.ch.members) if (m.ws.readyState === 1) m.ws.send(msg);
}

const cleanName = (s, max) =>
  String(s || '').replace(/[^\p{L}\p{N} _\-.#]/gu, '').trim().slice(0, max);

let accounts;   // set in main()

// ---- who is online -------------------------------------------------------
const authed = () => [...clients.values()].filter((c) => c.user);
// (the same account's older session doesn't count: it is about to be replaced)
const callsignTaken = (name, except, ownUserId) =>
  authed().some((c) => c !== except && c.user.id !== ownUserId && c.name.toLowerCase() === name.toLowerCase());
const isStaff = (c) => !!c.user && (c.user.role === 'admin' || c.user.role === 'mod');

function memberView(c, forStaff) {
  const u = c.user, tag = u.role === 'joint' ? [accounts.factionName(u), u.title].filter(Boolean).join(' · ') : (u.title || '');
  const m = { id: c.id, name: c.name, role: u.role, tag };
  if (forStaff) m.u = u.username;               // only moderators can see which account is behind a callsign
  return m;
}

function snapshot(forStaff) {
  return [...channels.values()].map((ch) => ({
    id: ch.id,
    name: ch.name,
    desc: ch.desc || '',
    restricted: ch.isDefault && ch.name !== 'RADIO CHECK',   // preset operational channels: only join if your element is listed
    mode: ch.mode,
    talker: ch.talkers.size ? [...ch.talkers][0].id : null,       // the first one talking (in queue mode, the only one)
    talkers: [...ch.talkers].map((c) => c.id),                    // everyone talking right now (several in an open net)
    members: [...ch.members].filter((c) => c.user).map((c) => memberView(c, forStaff)),
  }));
}

function broadcastState() {
  const pub = JSON.stringify({ type: 'state', channels: snapshot(false) });
  const staff = JSON.stringify({ type: 'state', channels: snapshot(true) });
  for (const c of clients.values()) if (c.user && c.ws.readyState === 1) c.ws.send(isStaff(c) ? staff : pub);
}

const sendTo = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };
function notifyStaff(obj) { for (const c of clients.values()) if (isStaff(c)) sendTo(c, obj); }

// Gives a client the floor and starts recording their message.
function grantFloor(ch, client) {
  if (client.talkingIn) releaseFloor(client.talkingIn, client, client.talkingIn === ch);
  ch.waiters = ch.waiters.filter((w) => w !== client);
  ch.talkers.add(client); client.talkingIn = ch; client.lastFrame = Date.now();
  client.rec = { ch, chunks: [], bytes: 0, ts: Date.now() };
  clearTimeout(client.talkTimer);
  client.talkTimer = setTimeout(() => {                         // nobody can hold the channel forever
    if (ch.talkers.has(client)) { releaseFloor(ch, client); sendTo(client, { type: 'timeout', ch: ch.name }); broadcastState(); }
  }, MAX_TALK_MS);
  sendTo(client, { type: 'granted', ch: ch.name });
}

// People who tried to talk while the channel was busy are waiting in line. The moment the floor frees up it goes
// straight to the next one in line (no gap for someone else to jump in), so a queued message is never lost.
function serveWaiters(ch) {
  while (ch.waiters.length) {
    if (ch.mode !== 'open' && ch.talkers.size) return;
    const c = ch.waiters.shift();
    if (!ch.members.has(c) || c.ws.readyState !== 1) continue;
    grantFloor(ch, c);
  }
}

function releaseFloor(ch, client, noServe) {
  if (!ch.talkers.has(client)) return;
  clearTimeout(client.talkTimer);
  ch.talkers.delete(client);
  client.talkingIn = null;
  finalizeRecording(client);
  if (!noServe) serveWaiters(ch);
}

function leaveChannel(client, ch) {
  ch.waiters = ch.waiters.filter((w) => w !== client);
  releaseFloor(ch, client);
  ch.members.delete(client);
  client.channels.delete(ch);
  if (!ch.isDefault && ch.members.size === 0) channels.delete(ch.name);
}

// Ends a person's sessions (kick, disable, delete, password reset). Their app returns to the sign-in screen.
function disconnectUser(userId, reason) {
  for (const c of [...clients.values()]) if (c.user && c.user.id === userId) {
    sendTo(c, { type: 'kicked_app', reason });
    try { c.ws.close(4001, reason); } catch {}
  }
}

// ---- http ----------------------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// Strict per account (6 wrong tries locks that account for 5 min); loose per IP address, because a whole squad
// can share one connection and a few typos must not lock everyone out.
const loginLimiter = new Limiter({ max: 6, lockMs: 5 * 60_000 });
const ipLimiter = new Limiter({ max: 60, lockMs: 5 * 60_000 });
const pwLimiter = new Limiter({ max: 5, lockMs: 10 * 60_000 });
let SECRET = '';

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const mintToken = (u) => signToken({ u: u.id, v: u.tokver, e: Date.now() + TOKEN_LIFE_MS }, SECRET);

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (d) => { size += d.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleLogin(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'Bad request.' }); }
  const username = String(body.username || '').trim().slice(0, 40), password = String(body.password || '').slice(0, 200);
  const ip = clientIp(req), kUser = 'u:' + username.toLowerCase(), kIp = 'ip:' + ip;
  const a = loginLimiter.check(kUser), b = ipLimiter.check(kIp);
  if (!a.ok || !b.ok) return json(res, 429, { ok: false, error: `Too many attempts. Try again in ${Math.max(a.wait, b.wait)} seconds.` });
  const r = await accounts.authenticate(username, password);
  if (!r.ok) {
    if (r.error === 'bad_credentials') {
      loginLimiter.fail(kUser); ipLimiter.fail(kIp);
      await new Promise((ok) => setTimeout(ok, 400));                  // slows down guessing
      return json(res, 401, { ok: false, error: 'Wrong username or password.' });
    }
    return json(res, 403, { ok: false, error: r.error === 'faction_disabled'
      ? 'Your group\'s access has been switched off. Ask a moderator.' : 'This account is disabled. Ask a moderator.' });
  }
  loginLimiter.success(kUser);
  r.user.lastLogin = Date.now(); await store.saveUser(r.user);
  json(res, 200, { ok: true, token: mintToken(r.user), user: { username: r.user.username, role: r.user.role, lastCallsign: r.user.lastCallsign || '' } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/api/status') return json(res, 200, { ready: accounts ? [...store.users.values()].some((u) => u.role === 'admin') : false });
    if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) { console.error('http error:', e.message); if (!res.headersSent) { res.writeHead(500); } res.end(); }
});

// ---- websocket -----------------------------------------------------------
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: MAX_FRAME_BYTES,
  // Only our own page may open a socket (blocks other websites from trying).
  verifyClient: ({ origin, req }) => { if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } },
});

async function handleHello(client, msg) {
  if (client.user) return;
  client.helloTries = (client.helloTries || 0) + 1;
  if (client.helloTries > 6) { try { client.ws.close(4003, 'too many tries'); } catch {} return; }
  const payload = readToken(msg.token, SECRET);
  const user = accounts.userForToken(payload);
  if (!user) { sendTo(client, { type: 'error', code: 'invalid_token' }); try { client.ws.close(4002, 'invalid token'); } catch {} return; }
  const name = cleanName(msg.name, MAX_NAME) || cleanName(user.lastCallsign, MAX_NAME) || cleanName(user.username, MAX_NAME);
  if (callsignTaken(name, client, user.id)) { sendTo(client, { type: 'error', code: 'callsign_taken', name }); return; }
  disconnectUser(user.id, 'signed_in_elsewhere');                      // one live session per account (no sharing logins)
  client.user = user; client.name = name; user.lastCallsign = name;
  store.saveUser(user).catch((e) => console.error('save failed:', e.message));
  sendTo(client, {
    type: 'welcome', id: client.id, name, maxTalkMs: MAX_TALK_MS,
    token: mintToken(user),                                            // a fresh 30-day sign-in each time, so regulars never have to type their password

    user: { username: user.username, role: user.role, title: user.title || '', faction: accounts.factionName(user) },
    storage: isStaff(client) ? store.kind : undefined,
  });
  broadcastState(); notifyStaff({ type: 'admin_changed' });
}

async function handleAdmin(client, msg) {
  const reply = (r) => sendTo(client, { type: 'admin_result', rid: msg.rid, op: msg.op, ...r });
  const actor = client.user;
  if (!accounts.isStaff(actor)) return reply({ ok: false, error: 'forbidden' });
  try {
    let r;
    switch (msg.op) {
      case 'list': {
        r = accounts.list(actor);
        if (r.ok) r.data.online = authed().map((c) => ({ id: c.id, callsign: c.name, username: c.user.username, role: c.user.role, tag: memberView(c, false).tag, channels: [...c.channels].map((x) => x.name) }));
        break;
      }
      case 'create_user': r = await accounts.createUser(actor, msg); break;
      case 'delete_user': r = await accounts.deleteUser(actor, msg.userId); break;
      case 'set_disabled': r = await accounts.setDisabled(actor, msg.userId, msg.disabled); break;
      case 'reset_password': r = await accounts.resetPassword(actor, msg.userId, msg.password); break;
      case 'set_role': r = await accounts.setRole(actor, msg.userId, msg.role); break;
      case 'set_title': r = await accounts.setTitle(actor, msg.userId, msg.title); break;
      case 'create_faction': r = await accounts.createFaction(actor, msg); break;
      case 'add_faction_user': r = await accounts.addFactionUser(actor, msg); break;
      case 'faction_enabled': r = await accounts.setFactionEnabled(actor, msg.factionId, msg.enabled); break;
      case 'rename_faction': r = await accounts.renameFaction(actor, msg.factionId, msg.name); break;
      case 'delete_faction': r = await accounts.deleteFaction(actor, msg.factionId); break;
      default: r = { ok: false, error: 'Unknown request.' };
    }
    reply(r);
    if (r.ok && msg.op !== 'list') { notifyStaff({ type: 'admin_changed' }); broadcastState(); }
  } catch (e) {
    console.error('admin error:', e.message);
    reply({ ok: false, error: 'The server could not save that. Try again in a moment.' });
  }
}

wss.on('connection', (ws) => {
  const client = { id: nextClientId++, name: '', user: null, ws, channels: new Set(), talkingIn: null, alive: true };
  clients.set(client.id, client);
  const authTimer = setTimeout(() => { if (!client.user) { try { ws.close(4000, 'no sign-in'); } catch {} } }, 15_000);
  ws.on('pong', () => { client.alive = true; });

  const onMessage = async (data, isBinary) => {
    // Binary = one chunk of 16 kHz mono Int16 PCM from the current talker.
    if (isBinary) {
      const ch = client.talkingIn;
      if (!client.user || !ch || !ch.talkers.has(client)) return;
      client.lastFrame = Date.now();
      // 6-byte header: which channel (2 bytes) + WHO is speaking (4 bytes), so several speakers in an open net stay separate
      const out = Buffer.allocUnsafe(6 + data.length);
      out.writeUInt16BE(ch.id, 0); out.writeUInt32BE(client.id, 2);
      data.copy ? data.copy(out, 6) : Buffer.from(data).copy(out, 6);
      for (const m of ch.members) if (m !== client && m.ws.readyState === 1) m.ws.send(out, { binary: true });
      if (client.rec && client.rec.bytes < MAX_TALK_MS * 32) { client.rec.chunks.push(Buffer.from(data)); client.rec.bytes += data.length; }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'hello') { await handleHello(client, msg); return; }
    if (!client.user) return;                                          // nothing else works until you've signed in

    if (msg.type === 'join') {
      const name = cleanName(msg.ch, MAX_NAME).toUpperCase();
      if (!name) return;
      const until = bans.get(`${client.user.id}|${name}`);
      if (until && until > Date.now()) { sendTo(client, { type: 'join_denied', ch: name, reason: 'blocked', minutes: Math.ceil((until - Date.now()) / 60000) }); return; }
      const ch = getChannel(name);
      if (!ch) return;
      ch.members.add(client); client.channels.add(ch);
      broadcastState(); notifyStaff({ type: 'admin_changed' });
      sendTo(client, { type: 'history', ch: ch.name, items: history.filter((h) => h.ch === ch.name).slice(-HISTORY_PER_CHANNEL).map(metaOf) });
    } else if (msg.type === 'get_audio') {
      // Replay a past message. Only members of that message's channel may fetch it.
      const item = history.find((h) => h.id === msg.id);
      if (!item || ![...client.channels].some((c) => c.name === item.ch)) { sendTo(client, { type: 'audio_missing', id: msg.id }); return; }
      const out = Buffer.allocUnsafe(6 + item.pcm.length);
      out.writeUInt16BE(0xFFFF, 0); out.writeUInt32BE(item.id, 2); item.pcm.copy(out, 6);
      ws.send(out, { binary: true });
    } else if (msg.type === 'leave') {
      const ch = channels.get(String(msg.ch));
      if (ch) { leaveChannel(client, ch); broadcastState(); notifyStaff({ type: 'admin_changed' }); }
    } else if (msg.type === 'ptt_start') {
      const ch = channels.get(String(msg.ch));
      if (!ch || !ch.members.has(client)) return;
      if (ch.mode !== 'open' && ch.talkers.size && !ch.talkers.has(client)) { sendTo(client, { type: 'denied', ch: ch.name, by: [...ch.talkers][0].name }); return; }
      grantFloor(ch, client);
      broadcastState();
    } else if (msg.type === 'ptt_wait') {
      // "I want the floor as soon as it's free": joins the line, and is granted automatically when it's their turn.
      const ch = channels.get(String(msg.ch));
      if (!ch || !ch.members.has(client) || ch.talkers.has(client)) return;
      if (!ch.waiters.includes(client)) ch.waiters.push(client);
      serveWaiters(ch); broadcastState();
    } else if (msg.type === 'ptt_unwait') {
      const ch = channels.get(String(msg.ch));
      if (ch) ch.waiters = ch.waiters.filter((w) => w !== client);
    } else if (msg.type === 'ptt_end') {
      if (client.talkingIn) { releaseFloor(client.talkingIn, client); broadcastState(); }

    } else if (msg.type === 'set_callsign') {
      const name = cleanName(msg.name, MAX_NAME);
      if (!name) { sendTo(client, { type: 'callsign_result', ok: false, error: 'Type a callsign.' }); return; }
      if (callsignTaken(name, client)) { sendTo(client, { type: 'callsign_result', ok: false, error: `"${name}" is in use right now. Pick another.` }); return; }
      client.name = name; client.user.lastCallsign = name;
      store.saveUser(client.user).catch(() => {});
      sendTo(client, { type: 'callsign_result', ok: true, name });
      broadcastState(); notifyStaff({ type: 'admin_changed' });

    } else if (msg.type === 'change_password') {
      const key = 'pw:' + client.user.id, lim = pwLimiter.check(key);
      if (!lim.ok) { sendTo(client, { type: 'password_result', ok: false, error: `Too many tries. Wait ${lim.wait} seconds.` }); return; }
      const r = await accounts.changeOwnPassword(client.user, String(msg.current || ''), String(msg.next || ''));
      if (!r.ok) pwLimiter.fail(key); else pwLimiter.success(key);
      sendTo(client, r.ok ? { type: 'password_result', ok: true, token: mintToken(client.user) } : { type: 'password_result', ok: false, error: r.error });

    // ---- moderation ----
    } else if (msg.type === 'mod_kick_channel') {
      const target = clients.get(Number(msg.id)), ch = channels.get(String(msg.ch));
      if (!isStaff(client) || !target || !target.user || target === client || !accounts.canManage(client.user, target.user) || !ch || !ch.members.has(target)) return;
      leaveChannel(target, ch);
      bans.set(`${target.user.id}|${ch.name}`, Date.now() + KICK_BLOCK_MS);
      sendTo(target, { type: 'kicked', ch: ch.name, by: client.name, minutes: KICK_BLOCK_MS / 60000 });
      store.addAudit(client.user.username, 'kicked_from_channel', target.user.username, ch.name);
      broadcastState(); notifyStaff({ type: 'admin_changed' });
    } else if (msg.type === 'mod_set_mode') {
      // Moderators switch a channel between "one at a time" and "open net" (everyone can talk at once).
      const ch = channels.get(String(msg.ch)), mode = msg.mode === 'open' ? 'open' : 'queue';
      if (!isStaff(client) || !ch || ch.mode === mode) return;
      ch.mode = mode;
      if (mode === 'queue' && ch.talkers.size > 1) {                    // going back to one-at-a-time: the earliest talker keeps the channel
        for (const t of [...ch.talkers].slice(1)) { releaseFloor(ch, t); sendTo(t, { type: 'timeout', ch: ch.name }); }
      }
      serveWaiters(ch);                                                  // switching to open net: anyone waiting goes on air now
      if (mode === 'open') modes[ch.name] = 'open'; else delete modes[ch.name];
      store.setMeta('channel_modes', JSON.stringify(modes)).catch((e) => console.error('could not save channel modes:', e.message));
      store.addAudit(client.user.username, 'set_channel_mode', ch.name, mode === 'open' ? 'open net' : 'one at a time');
      for (const m of ch.members) sendTo(m, { type: 'mode_changed', ch: ch.name, mode, by: client.name });
      broadcastState(); notifyStaff({ type: 'admin_changed' });
    } else if (msg.type === 'mod_kick_app') {
      const target = clients.get(Number(msg.id));
      if (!isStaff(client) || !target || !target.user || target === client || !accounts.canManage(client.user, target.user)) return;
      target.user.tokver++;                                              // their saved login stops working: they must sign in again
      store.saveUser(target.user).catch(() => {});
      sendTo(target, { type: 'kicked_app', reason: 'kicked', by: client.name });
      store.addAudit(client.user.username, 'kicked_from_app', target.user.username);
      try { target.ws.close(4001, 'kicked'); } catch {}
      notifyStaff({ type: 'admin_changed' });

    } else if (msg.type === 'admin') {
      await handleAdmin(client, msg);
    }
  };
  ws.on('message', (data, isBinary) => { onMessage(data, isBinary).catch((e) => console.error('message error:', e.message)); });

  ws.on('close', () => {
    clearTimeout(authTimer);
    for (const ch of [...client.channels]) leaveChannel(client, ch);
    clients.delete(client.id);
    if (client.user) { broadcastState(); notifyStaff({ type: 'admin_changed' }); }
  });
  ws.on('error', () => {});
});

// Drop dead connections so a vanished player can't keep holding the floor.
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; c.ws.ping();
  }
}, 8_000);

// Hosting proxies can take a while to report a dropped player. A live talker sends audio
// every ~20 ms, so if the floor holder goes silent for 3 s, take the floor back.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const ch of channels.values()) {
    for (const t of [...ch.talkers]) {
      if (now - (t.lastFrame || 0) > 3000) {
        releaseFloor(ch, t);
        sendTo(t, { type: 'timeout', ch: ch.name });
        changed = true;
      }
    }
  }
  if (changed) broadcastState();
  for (const [k, until] of bans) if (until < now) bans.delete(k);
}, 1000);

// ---- start ---------------------------------------------------------------
let store;
async function main() {
  store = await createStore({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.DATA_DIR });
  if (!store.meta.secret) await store.setMeta('secret', crypto.randomBytes(32).toString('hex'));   // signs login tokens; kept with the accounts
  SECRET = store.meta.secret;
  try { Object.assign(modes, JSON.parse(store.meta.channel_modes || '{}')); } catch {}      // remembered open-net channels
  for (const ch of channels.values()) ch.mode = modes[ch.name] === 'open' ? 'open' : 'queue';
  accounts = new Accounts(store, { disconnectUser, onlineUserIds: () => new Set(authed().map((c) => c.user.id)) });

  const boot = await accounts.bootstrapAdmin(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);
  const hasAdmin = [...store.users.values()].some((u) => u.role === 'admin');
  console.log(`Accounts stored in: ${store.kind}${store.kind === 'file' ? '  (temporary on free hosting - set DATABASE_URL)' : ''}`);
  if (boot === 'invalid') console.error('ADMIN_USER / ADMIN_PASSWORD are not valid (username 3-24 letters/numbers, password 8+ characters).');
  if (!hasAdmin) console.error('NO ADMIN ACCOUNT YET. Set ADMIN_USER and ADMIN_PASSWORD, then restart. Nobody can sign in until then.');
  else console.log(`Admin account ready (${boot}).`);

  server.listen(PORT, () => console.log(`Roger listening on :${PORT}`));
  const bye = async () => { try { await store.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
main().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
