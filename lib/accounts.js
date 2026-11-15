// Who can do what. Every rule here is enforced on the server; the app only mirrors it.
//
//   admin  : you. Everything, including creating and removing moderators.
//   mod    : moderators. Create / delete / disable regular and joint-op accounts, reset their passwords,
//            kick people. They can NOT touch admins or other moderators.
//   user   : your group's regular members.
//   joint  : people from other groups in a joint operation (faction leader, HICOM 1, HICOM 2 ...).
const { hashPassword, verifyPassword, burnTime, generatePassword } = require('./auth');

const rank = (role) => (role === 'admin' ? 3 : role === 'mod' ? 2 : 0);
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,23}$/;
const MIN_PASSWORD = 8;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 14) || 'faction';
const cleanText = (s, max) => String(s || '').replace(/[^\p{L}\p{N} _\-.#/&()]/gu, '').trim().slice(0, max);
const fail = (error) => ({ ok: false, error });

class Accounts {
  // hooks: { disconnectUser(userId, reason), onlineUserIds(): Set }
  constructor(store, hooks = {}) { this.store = store; this.hooks = hooks; }

  // ---- who may act on whom ----
  canManage(actor, target) {
    if (!actor || !target) return false;
    if (actor.role === 'admin') return true;
    return actor.role === 'mod' && rank(target.role) === 0;
  }
  isStaff(actor) { return !!actor && (actor.role === 'admin' || actor.role === 'mod'); }

  factionName(u) { const f = u.factionId != null ? this.store.factions.get(u.factionId) : null; return f ? f.name : ''; }
  publicUser(u, online = new Set()) {
    return {
      id: u.id, username: u.username, role: u.role, title: u.title || '', disabled: !!u.disabled,
      factionId: u.factionId, factionName: this.factionName(u), createdBy: u.createdBy, createdAt: u.createdAt,
      lastLogin: u.lastLogin || 0, online: online.has(u.id),
    };
  }

  // ---- sign in ----
  async authenticate(username, password) {
    const u = this.store.userByName(username);
    if (!u) { await burnTime(password); return fail('bad_credentials'); }
    if (!(await verifyPassword(password, u.passHash))) return fail('bad_credentials');
    const block = this.blockedReason(u);
    return block ? fail(block) : { ok: true, user: u };
  }
  blockedReason(u) {
    if (u.disabled) return 'disabled';
    const f = u.factionId != null ? this.store.factions.get(u.factionId) : null;
    if (u.factionId != null && (!f || !f.enabled)) return 'faction_disabled';
    return null;
  }
  // A token is only good while the account exists, is enabled and nobody has bumped its version (kick / password reset).
  userForToken(payload) {
    const u = payload && this.store.users.get(payload.u);
    if (!u || u.tokver !== payload.v || this.blockedReason(u)) return null;
    return u;
  }

  async bootstrapAdmin(username, password) {
    if (!username || !password) return 'skipped';
    if (!USERNAME_RE.test(username) || String(password).length < MIN_PASSWORD) return 'invalid';
    let u = this.store.userByName(username);
    if (!u) {
      await this.store.createUser({ username, passHash: await hashPassword(password), role: 'admin', createdBy: 'setup' });
      await this.store.addAudit('setup', 'admin_created', username);
      return 'created';
    }
    let changed = false;
    if (u.role !== 'admin' || u.disabled || u.factionId != null) { u.role = 'admin'; u.disabled = false; u.factionId = null; changed = true; }
    if (!(await verifyPassword(password, u.passHash))) { u.passHash = await hashPassword(password); u.tokver++; changed = true; }
    if (changed) await this.store.saveUser(u);
    return changed ? 'updated' : 'unchanged';
  }

  // ---- reading ----
  list(actor) {
    if (!this.isStaff(actor)) return fail('forbidden');
    const online = this.hooks.onlineUserIds ? this.hooks.onlineUserIds() : new Set();
    const all = [...this.store.users.values()];
    return {
      ok: true,
      data: {
        users: all.filter((u) => u.role !== 'joint').sort((a, b) => rank(b.role) - rank(a.role) || a.username.localeCompare(b.username)).map((u) => this.publicUser(u, online)),
        factions: [...this.store.factions.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({
          id: f.id, name: f.name, enabled: f.enabled,
          users: all.filter((u) => u.factionId === f.id).sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true })).map((u) => this.publicUser(u, online)),
        })),
        audit: this.store.audit.slice(-120).reverse(),
        storage: this.store.kind,
      },
    };
  }

  // ---- accounts ----
  async _newAccount(actor, { username, role, password, factionId = null, title = '' }) {
    username = String(username || '').trim();
    if (!USERNAME_RE.test(username)) return fail('Usernames are 3-24 characters: letters, numbers, dot, dash or underscore.');
    if (this.store.userByName(username)) return fail(`The username "${username}" is already taken.`);
    if (password != null && password !== '' && String(password).length < MIN_PASSWORD) return fail(`Passwords need at least ${MIN_PASSWORD} characters.`);
    const pw = password ? String(password) : generatePassword();
    const u = await this.store.createUser({ username, passHash: await hashPassword(pw), role, factionId, title: cleanText(title, 24), createdBy: actor.username });
    return { ok: true, user: u, password: pw };
  }

  async createUser(actor, { username, role = 'user', password, factionId, title } = {}) {
    if (!this.isStaff(actor)) return fail('forbidden');
    if (!['user', 'joint', 'mod'].includes(role)) return fail('That kind of account can\'t be created here.');
    if (role === 'mod' && actor.role !== 'admin') return fail('Only the admin can create moderators.');
    let fid = null;
    if (role === 'joint') {
      fid = Number(factionId);
      if (!this.store.factions.has(fid)) return fail('Pick the joint-op faction this person belongs to.');
    }
    const r = await this._newAccount(actor, { username, role, password, factionId: fid, title });
    if (!r.ok) return r;
    await this.store.addAudit(actor.username, `created_${role}`, r.user.username, fid != null ? this.store.factions.get(fid).name : '');
    return { ok: true, data: { user: this.publicUser(r.user), password: r.password } };
  }

  async deleteUser(actor, id) {
    const t = this.store.users.get(Number(id));
    if (!t) return fail('That account no longer exists.');
    if (t.id === actor.id) return fail('You can\'t delete your own account.');
    if (!this.canManage(actor, t)) return fail('forbidden');
    this.hooks.disconnectUser && this.hooks.disconnectUser(t.id, 'removed');
    await this.store.deleteUser(t.id);
    await this.store.addAudit(actor.username, 'deleted_user', t.username);
    return { ok: true };
  }

  async setDisabled(actor, id, disabled) {
    const t = this.store.users.get(Number(id));
    if (!t) return fail('That account no longer exists.');
    if (t.id === actor.id) return fail('You can\'t disable your own account.');
    if (!this.canManage(actor, t)) return fail('forbidden');
    t.disabled = !!disabled; if (t.disabled) t.tokver++;
    await this.store.saveUser(t);
    if (t.disabled && this.hooks.disconnectUser) this.hooks.disconnectUser(t.id, 'disabled');
    await this.store.addAudit(actor.username, t.disabled ? 'disabled_user' : 'enabled_user', t.username);
    return { ok: true };
  }

  async resetPassword(actor, id, password) {
    const t = this.store.users.get(Number(id));
    if (!t) return fail('That account no longer exists.');
    if (!this.canManage(actor, t) && t.id !== actor.id) return fail('forbidden');
    if (password && String(password).length < MIN_PASSWORD) return fail(`Passwords need at least ${MIN_PASSWORD} characters.`);
    const pw = password ? String(password) : generatePassword();
    t.passHash = await hashPassword(pw); t.tokver++;
    await this.store.saveUser(t);
    if (this.hooks.disconnectUser && t.id !== actor.id) this.hooks.disconnectUser(t.id, 'password_reset');
    await this.store.addAudit(actor.username, 'reset_password', t.username);
    return { ok: true, data: { password: pw, username: t.username } };
  }

  async setRole(actor, id, role) {
    if (actor.role !== 'admin') return fail('Only the admin can change roles.');
    const t = this.store.users.get(Number(id));
    if (!t) return fail('That account no longer exists.');
    if (t.id === actor.id) return fail('You can\'t change your own role.');
    if (!['user', 'mod'].includes(role) || !['user', 'mod'].includes(t.role)) return fail('That role change isn\'t allowed.');
    t.role = role; await this.store.saveUser(t);
    await this.store.addAudit(actor.username, 'set_role', t.username, role);
    return { ok: true };
  }

  async setTitle(actor, id, title) {
    const t = this.store.users.get(Number(id));
    if (!t) return fail('That account no longer exists.');
    if (!this.canManage(actor, t)) return fail('forbidden');
    t.title = cleanText(title, 24); await this.store.saveUser(t);
    return { ok: true };
  }

  async changeOwnPassword(user, current, next) {
    if (!(await verifyPassword(current, user.passHash))) return fail('Your current password is wrong.');
    if (String(next || '').length < MIN_PASSWORD) return fail(`Passwords need at least ${MIN_PASSWORD} characters.`);
    user.passHash = await hashPassword(next); user.tokver++;
    await this.store.saveUser(user);
    await this.store.addAudit(user.username, 'changed_own_password', user.username);
    return { ok: true, token: true };
  }

  // ---- joint-op factions ----
  async createFaction(actor, { name, leader, hicoms = 2 } = {}) {
    if (!this.isStaff(actor)) return fail('forbidden');
    name = cleanText(name, 30);
    if (name.length < 2) return fail('Give the faction a name (at least 2 characters).');
    if ([...this.store.factions.values()].some((f) => f.name.toLowerCase() === name.toLowerCase())) return fail('A faction with that name already exists.');
    const n = Math.max(0, Math.min(10, parseInt(hicoms, 10) || 0));
    const base = slug(name);
    const free = (want) => { let u = want, i = 2; while (this.store.userByName(u)) u = `${want}${i++}`; return u; };
    const leaderName = leader ? String(leader).trim() : free(`${base}-leader`);
    if (!USERNAME_RE.test(leaderName)) return fail('The leader\'s username is 3-24 characters: letters, numbers, dot, dash or underscore.');
    if (this.store.userByName(leaderName)) return fail(`The username "${leaderName}" is already taken.`);
    const f = await this.store.createFaction(name, actor.username);
    const accounts = [];
    const make = async (username, title) => {
      const r = await this._newAccount(actor, { username, role: 'joint', factionId: f.id, title });
      if (r.ok) accounts.push({ username: r.user.username, title, password: r.password });
    };
    await make(leaderName, 'Faction Leader');
    for (let i = 1; i <= n; i++) await make(free(`${base}-hicom${i}`), `HICOM ${i}`);
    await this.store.addAudit(actor.username, 'created_faction', name, `${accounts.length} accounts`);
    return { ok: true, data: { faction: { id: f.id, name: f.name }, accounts } };
  }

  async addFactionUser(actor, { factionId, username, title, password } = {}) {
    if (!this.isStaff(actor)) return fail('forbidden');
    const f = this.store.factions.get(Number(factionId));
    if (!f) return fail('That faction no longer exists.');
    const r = await this._newAccount(actor, { username, role: 'joint', password, factionId: f.id, title: title || 'HICOM' });
    if (!r.ok) return r;
    await this.store.addAudit(actor.username, 'created_joint', r.user.username, f.name);
    return { ok: true, data: { user: this.publicUser(r.user), password: r.password } };
  }

  async setFactionEnabled(actor, id, enabled) {
    if (!this.isStaff(actor)) return fail('forbidden');
    const f = this.store.factions.get(Number(id));
    if (!f) return fail('That faction no longer exists.');
    f.enabled = !!enabled; await this.store.saveFaction(f);
    if (!f.enabled && this.hooks.disconnectUser) for (const u of this.store.users.values()) if (u.factionId === f.id) this.hooks.disconnectUser(u.id, 'faction_disabled');
    await this.store.addAudit(actor.username, f.enabled ? 'enabled_faction' : 'disabled_faction', f.name);
    return { ok: true };
  }

  async renameFaction(actor, id, name) {
    if (!this.isStaff(actor)) return fail('forbidden');
    const f = this.store.factions.get(Number(id));
    if (!f) return fail('That faction no longer exists.');
    name = cleanText(name, 30);
    if (name.length < 2) return fail('Give the faction a name (at least 2 characters).');
    if ([...this.store.factions.values()].some((x) => x.id !== f.id && x.name.toLowerCase() === name.toLowerCase())) return fail('A faction with that name already exists.');
    f.name = name; await this.store.saveFaction(f);
    return { ok: true };
  }

  async deleteFaction(actor, id) {
    if (!this.isStaff(actor)) return fail('forbidden');
    const f = this.store.factions.get(Number(id));
    if (!f) return fail('That faction no longer exists.');
    for (const u of this.store.users.values()) if (u.factionId === f.id && this.hooks.disconnectUser) this.hooks.disconnectUser(u.id, 'removed');
    await this.store.deleteFaction(f.id);
    await this.store.addAudit(actor.username, 'deleted_faction', f.name);
    return { ok: true };
  }
}

module.exports = { Accounts, rank, USERNAME_RE, MIN_PASSWORD };
