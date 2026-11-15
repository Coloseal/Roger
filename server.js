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

// ---- state -------------------------------------------------------------
let nextClientId = 1;
let nextChannelId = 1;
const clients = new Map();   // id -> client
const channels = new Map();  // name -> channel

function getChannel(name, isDefault = false, desc = '') {
  let ch = channels.get(name);
  if (!ch) {
    if (channels.size >= MAX_CHANNELS) return null;
    ch = { id: nextChannelId++, name, isDefault, desc, members: new Set(), talker: null, timer: null };
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

function snapshot() {
  return [...channels.values()].map((ch) => ({
    id: ch.id,
    name: ch.name,
    desc: ch.desc || '',
    restricted: ch.isDefault && ch.name !== 'RADIO CHECK',   // preset operational channels: only join if your element is listed
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
  finalizeRecording(client);
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
      client.lastFrame = Date.now();
      const out = Buffer.allocUnsafe(2 + data.length);
      out.writeUInt16BE(ch.id, 0);
      data.copy ? data.copy(out, 2) : Buffer.from(data).copy(out, 2);
      for (const m of ch.members) if (m !== client && m.ws.readyState === 1) m.ws.send(out, { binary: true });
      if (client.rec && client.rec.bytes < MAX_TALK_MS * 32) { client.rec.chunks.push(Buffer.from(data)); client.rec.bytes += data.length; }
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
      ws.send(JSON.stringify({ type: 'history', ch: ch.name, items: history.filter((h) => h.ch === ch.name).slice(-HISTORY_PER_CHANNEL).map(metaOf) }));
    } else if (msg.type === 'get_audio') {
      // Replay a past message. Only members of that message's channel may fetch it.
      const item = history.find((h) => h.id === msg.id);
      if (!item || ![...client.channels].some((c) => c.name === item.ch)) { ws.send(JSON.stringify({ type: 'audio_missing', id: msg.id })); return; }
      const out = Buffer.allocUnsafe(6 + item.pcm.length);
      out.writeUInt16BE(0xFFFF, 0); out.writeUInt32BE(item.id, 2); item.pcm.copy(out, 6);
      ws.send(out, { binary: true });
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
      ch.talker = client; client.talkingIn = ch; client.lastFrame = Date.now();
      client.rec = { ch, chunks: [], bytes: 0, ts: Date.now() };
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
}, 8_000);

// Hosting proxies can take a while to report a dropped player. A live talker sends audio
// every ~20 ms, so if the floor holder goes silent for 3 s, take the floor back.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const ch of channels.values()) {
    const t = ch.talker;
    if (t && now - (t.lastFrame || 0) > 3000) {
      releaseFloor(ch, t);
      if (t.ws.readyState === 1) t.ws.send(JSON.stringify({ type: 'timeout', ch: ch.name }));
      changed = true;
    }
  }
  if (changed) broadcastState();
}, 1000);

server.listen(PORT, () => console.log(`Roger listening on :${PORT}`));
