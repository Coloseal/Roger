// Password hashing, signed login tokens and brute-force limiting. Uses only Node's built-in crypto.
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const N = 16384, R = 8, P = 1, KEYLEN = 64, MAXMEM = 64 * 1024 * 1024;

// "scrypt$N$r$p$salt$hash" - a slow, salted hash: stolen data can't be turned back into passwords quickly.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, saltB, hashB] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hashB, 'base64');
    const got = await scrypt(String(password), Buffer.from(saltB, 'base64'), want.length, { N: +n, r: +r, p: +p, maxmem: MAXMEM });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

// Used when a username doesn't exist, so "no such user" takes as long as "wrong password".
let dummy;
async function burnTime(password) {
  if (!dummy) dummy = await hashPassword('not-a-real-password');
  await verifyPassword(password, dummy);
}

// Readable random password (no 0/O, 1/l/I).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function generatePassword(len = 12) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

// Token = base64url(payload) + "." + HMAC(payload). Payload: {u: userId, v: tokenVersion, e: expiresAtMs}
function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function readToken(token, secret) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p && p.e > Date.now() ? p : null;
  } catch { return null; }
}

// Counts failures per key (IP address or username). Too many in a row locks that key for a while.
class Limiter {
  constructor({ max = 6, windowMs = 15 * 60_000, lockMs = 5 * 60_000 } = {}) {
    this.max = max; this.windowMs = windowMs; this.lockMs = lockMs; this.hits = new Map();
    this.timer = setInterval(() => this.prune(), 60_000); this.timer.unref();
  }
  check(key) {
    const e = this.hits.get(key), now = Date.now();
    if (e && e.lockUntil > now) return { ok: false, wait: Math.ceil((e.lockUntil - now) / 1000) };
    return { ok: true, wait: 0 };
  }
  fail(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.first > this.windowMs) e = { n: 0, first: now, lockUntil: 0 };
    e.n++;
    if (e.n >= this.max) { e.lockUntil = now + this.lockMs; e.n = 0; e.first = now; }
    this.hits.set(key, e);
  }
  success(key) { this.hits.delete(key); }
  prune() { const now = Date.now(); for (const [k, e] of this.hits) if (e.lockUntil < now && now - e.first > this.windowMs) this.hits.delete(k); }
}

module.exports = { hashPassword, verifyPassword, burnTime, generatePassword, signToken, readToken, Limiter };
