// Roger - push-to-talk relay server.
// One WebSocket per player. Per channel, the server hands the "floor" to one talker at a
// time (half-duplex, like a real radio) and relays that talker's audio to everyone else.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_TALK_MS = 60_000;            // safety: a stuck mic can't hog a channel forever
const MAX_CHANNELS = 200;
const MAX_NAME = 20;
const MAX_FRAME_BYTES = 16 * 1024;
const ROOM_KEY = process.env.ROOM_KEY || ''; // optional: set to require a shared password

const DEFAULT_CHANNELS = [
  'COMMAND', 'ALPHA SQUAD', 'BRAVO SQUAD', 'CHARLIE SQUAD',
  'PILOTS', 'MEDEVAC', 'GROUND TEAM', 'GENERAL',
];

// ---- state -------------------------------------------------------------
let nextClientId = 1;
let nextChannelId = 1;
const clients = new Map();   // id -> client
const channels = new Map();  // name -> channel

function getChannel(name, isDefault = false) {
  let ch = channels.get(name);
  if (!ch) {
    if (channels.size >= MAX_CHANNELS) return null;
    ch = { id: nextChannelId++, name, isDefault, members: new Set(), talker: null, timer: null };
    channels.set(name, ch);
  }
  return ch;
}
DEFAULT_CHANNELS.forEach((n) => getChannel(n, true));

const cleanName = (s, max) =>
  String(s || '').replace(/[^\p{L}\p{N} _\-.#]/gu, '').trim().slice(0, max);

function snapshot() {
  return [...channels.values()].map((ch) => ({
    id: ch.id,
    name: ch.name,
    talker: ch.talker ? ch.talker.id : null,
    members: [...ch.members].map((c) => ({ id: c.id, name: c.name })),
  }));
}

function broadcastState() {
  const msg = JSON.stringify({ type: 'state', channels: snapshot() });
  for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(msg);
}

function releaseFloor(ch, client) {
  if (ch.talker !== client) return;
  clearTimeout(ch.timer);
  ch.talker = null;
  client.talkingIn = null;
}

function leaveChannel(client, ch) {
  releaseFloor(ch, client);
  ch.members.delete(client);
  client.channels.delete(ch);
  if (!ch.isDefault && ch.members.size === 0) channels.delete(ch.name);
}

// ---- http (serves the web client) --------------------------------------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---- websocket ----------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });

wss.on('connection', (ws) => {
  const client = { id: nextClientId++, name: 'Rookie', ws, channels: new Set(), talkingIn: null, authed: !ROOM_KEY, alive: true };
  clients.set(client.id, client);
  ws.on('pong', () => { client.alive = true; });

  ws.on('message', (data, isBinary) => {
    // Binary = one chunk of 16 kHz mono Int16 PCM from the current talker.
    if (isBinary) {
      const ch = client.talkingIn;
      if (!ch || ch.talker !== client) return;
      const out = Buffer.allocUnsafe(2 + data.length);
      out.writeUInt16BE(ch.id, 0);
      data.copy ? data.copy(out, 2) : Buffer.from(data).copy(out, 2);
      for (const m of ch.members) if (m !== client && m.ws.readyState === 1) m.ws.send(out, { binary: true });
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'hello') {
      if (ROOM_KEY && msg.key !== ROOM_KEY) { ws.send(JSON.stringify({ type: 'error', code: 'bad_key' })); return; }
      client.authed = true;
      client.name = cleanName(msg.name, MAX_NAME) || `Rookie-${client.id}`;
      ws.send(JSON.stringify({ type: 'welcome', id: client.id, name: client.name, maxTalkMs: MAX_TALK_MS }));
      broadcastState();
      return;
    }
    if (!client.authed) return;

    if (msg.type === 'join') {
      const name = cleanName(msg.ch, MAX_NAME).toUpperCase();
      if (!name) return;
      const ch = getChannel(name);
      if (!ch) return;
      ch.members.add(client); client.channels.add(ch);
      broadcastState();
    } else if (msg.type === 'leave') {
      const ch = channels.get(String(msg.ch));
      if (ch) { leaveChannel(client, ch); broadcastState(); }
    } else if (msg.type === 'ptt_start') {
      const ch = channels.get(String(msg.ch));
      if (!ch || !ch.members.has(client)) return;
      if (client.talkingIn) releaseFloor(client.talkingIn, client);
      if (ch.talker && ch.talker !== client) {
        ws.send(JSON.stringify({ type: 'denied', ch: ch.name, by: ch.talker.name }));
        return;
      }
      ch.talker = client; client.talkingIn = ch;
      clearTimeout(ch.timer);
      ch.timer = setTimeout(() => {
        if (ch.talker) {
          const t = ch.talker; releaseFloor(ch, t);
          t.ws.send(JSON.stringify({ type: 'timeout', ch: ch.name }));
          broadcastState();
        }
      }, MAX_TALK_MS);
      ws.send(JSON.stringify({ type: 'granted', ch: ch.name }));
      broadcastState();
    } else if (msg.type === 'ptt_end') {
      if (client.talkingIn) { releaseFloor(client.talkingIn, client); broadcastState(); }
    }
  });

  ws.on('close', () => {
    for (const ch of [...client.channels]) leaveChannel(client, ch);
    clients.delete(client.id);
    broadcastState();
  });
  ws.on('error', () => {});
});

// Drop dead connections so a vanished player can't keep holding the floor.
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; c.ws.ping();
  }
}, 15_000);

server.listen(PORT, () => console.log(`Roger listening on :${PORT}`));
