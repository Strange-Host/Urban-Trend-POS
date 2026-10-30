const db = require('../config/db');
const settingsService = require('./settings.service');

// A "session" is one sign-in on one device. It is what carries the rules that stop the POS staying signed in forever:
//   active  -> normal use
//   locked  -> idle longer than the lock time: the server refuses everything except unlocking, so even a stolen
//              browser can't carry on without the password/PIN (the screen lock in the app is just the friendly face of this)
//   expired -> idle past the sign-out time (unless "remember this device" was ticked), or past the hard maximum
//              length for the role: signing in again is the only way back
// Refresh tokens rotate INSIDE a session and can never stretch it past absolute_expires_at.

// A 'store' account has no timing rules of its own: policyFor() falls back to the cashier rules for it.
const ROLES = ['admin', 'manager', 'cashier'];
const WRITE_THROTTLE_MS = 15 * 1000;          // don't hit the disk for every click
const HOUR = 3600 * 1000;

let cache = null;
let cacheAt = 0;
function settings() {
  if (!cache || Date.now() - cacheAt > 10 * 1000) { cache = settingsService.getAll(); cacheAt = Date.now(); }
  return cache;
}
function clearCache() { cache = null; }

const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

/** The timing rules for a role, in minutes/hours. */
function policyFor(role) {
  const s = settings();
  const r = ROLES.includes(role) ? role : 'cashier';
  const defaults = { cashier: [5, 30, 12], manager: [10, 60, 168], admin: [10, 30, 24] }[r];
  return {
    lockMinutes: int(s[`security_lock_minutes_${r}`], defaults[0], 1, 1440),
    idleSignOutMinutes: int(s[`security_idle_signout_minutes_${r}`], defaults[1], 1, 10080),
    maxHours: int(s[`security_max_session_hours_${r}`], defaults[2], 1, 720),
    unrememberedMaxHours: int(s.security_unremembered_max_hours, 12, 1, 720),
    reauthMinutes: int(s.security_reauth_minutes, 5, 1, 120),
  };
}

/** Timestamps are ISO strings written by the app, or SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC). */
function parseTs(v) {
  if (!v) return NaN;
  const s = String(v);
  return Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

const get = (id) => (id ? db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) : undefined);

function create(user, { remember = false, ip = null, userAgent = null } = {}) {
  const p = policyFor(user.role);
  const now = Date.now();
  const hours = remember ? p.maxHours : Math.min(p.maxHours, p.unrememberedMaxHours);
  const iso = new Date(now).toISOString();
  const id = db.prepare(`
    INSERT INTO auth_sessions (user_id, remember, user_agent, ip, created_at, last_activity_at, reauth_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, remember ? 1 : 0, userAgent ? String(userAgent).slice(0, 300) : null, ip, iso, iso, iso, new Date(now + hours * HOUR).toISOString()).lastInsertRowid;
  prune();
  return get(id);
}

/** Where a session stands right now: { state: 'active' | 'locked' | 'expired' | 'revoked', reason? } */
function evaluate(session, role, nowMs = Date.now()) {
  if (!session || session.revoked_at) return { state: 'revoked' };
  if (nowMs >= parseTs(session.absolute_expires_at)) return { state: 'expired', reason: 'max' };
  const p = policyFor(role);
  const idle = nowMs - parseTs(session.last_activity_at);
  if (!session.remember && idle >= p.idleSignOutMinutes * 60000) return { state: 'expired', reason: 'idle' };
  if (idle >= p.lockMinutes * 60000) return { state: 'locked' };
  return { state: 'active' };
}

/** Real use of the app happened: push the idle clock back to zero. */
function touch(session) {
  const now = Date.now();
  if (now - parseTs(session.last_activity_at) < WRITE_THROTTLE_MS) return;
  db.prepare('UPDATE auth_sessions SET last_activity_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date(now).toISOString(), session.id);
}

/** The password/PIN was just typed correctly: unlocks, and counts as 'recently confirmed' for risky actions. */
function confirm(sessionId) {
  const iso = new Date().toISOString();
  db.prepare('UPDATE auth_sessions SET last_activity_at = ?, reauth_at = ? WHERE id = ? AND revoked_at IS NULL').run(iso, iso, sessionId);
  return get(sessionId);
}

function recentlyConfirmed(session, role, nowMs = Date.now()) {
  return nowMs - parseTs(session.reauth_at) < policyFor(role).reauthMinutes * 60000;
}

function revoke(sessionId, reason = 'signed_out') {
  if (!sessionId) return;
  db.prepare(`UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), reason, sessionId);
  db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE session_id = ? AND revoked_at IS NULL`).run(sessionId);
}

/** Signs a user out of every device (optionally keeping one). Returns how many sessions were ended. */
function revokeAllForUser(userId, { exceptSessionId = null, reason = 'signed_out_everywhere' } = {}) {
  const rows = db.prepare('SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND id != ?').all(userId, exceptSessionId || 0);
  rows.forEach((r) => revoke(r.id, reason));
  db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL AND (session_id IS NULL OR session_id != ?)`).run(userId, exceptSessionId || 0);
  return rows.length;
}

function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  const os = /Android/i.test(s) ? 'Android' : /iPhone|iPad|iOS/i.test(s) ? 'iPhone/iPad' : /Windows/i.test(s) ? 'Windows' : /Mac OS X|Macintosh/i.test(s) ? 'Mac' : /CrOS/i.test(s) ? 'Chromebook' : /Linux/i.test(s) ? 'Linux' : null;
  const browser = /SamsungBrowser/i.test(s) ? 'Samsung Internet' : /Edg\//i.test(s) ? 'Edge' : /OPR\/|Opera/i.test(s) ? 'Opera' : /Firefox|FxiOS/i.test(s) ? 'Firefox' : /Chrome|CriOS/i.test(s) ? 'Chrome' : /Safari/i.test(s) ? 'Safari' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

/** Live sessions for one person (what the 'signed-in devices' screen shows). */
function listForUser(user, currentSessionId) {
  const rows = db.prepare('SELECT * FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_activity_at DESC').all(user.id);
  return rows
    .map((r) => ({ r, ev: evaluate(r, user.role) }))
    .filter(({ ev }) => ev.state === 'active' || ev.state === 'locked')
    .map(({ r, ev }) => ({
      id: r.id, current: r.id === currentSessionId, device: deviceLabel(r.user_agent), ip: r.ip,
      remember: !!r.remember, state: ev.state, signedInAt: r.created_at, lastActiveAt: r.last_activity_at, expiresAt: r.absolute_expires_at,
    }));
}

/** What the browser needs to run its lock screen and warnings. */
function clientPolicy(user, session) {
  const p = policyFor(user.role);
  return {
    id: session.id,
    remember: !!session.remember,
    lockAfterSeconds: p.lockMinutes * 60,
    signOutAfterSeconds: session.remember ? null : p.idleSignOutMinutes * 60,
    expiresAt: session.absolute_expires_at,
    reauthMinutes: p.reauthMinutes,
    lastActivityAt: session.last_activity_at,
    // How long ago the server last saw real use, measured on the server's own clock (so the browser needn't trust its own).
    idleSeconds: Math.max(0, Math.round((Date.now() - parseTs(session.last_activity_at)) / 1000)),
  };
}

let lastPrune = 0;
/** Housekeeping: sessions that ended more than 30 days ago (and their refresh tokens) are deleted, at most hourly. */
function prune() {
  if (Date.now() - lastPrune < HOUR) return;
  lastPrune = Date.now();
  const cutoff = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
  const old = `SELECT id FROM auth_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR absolute_expires_at < ?`;
  db.prepare(`DELETE FROM refresh_tokens WHERE session_id IN (${old})`).run(cutoff, cutoff);
  db.prepare(`DELETE FROM auth_sessions WHERE id IN (${old})`).run(cutoff, cutoff);
}

module.exports = { policyFor, create, get, evaluate, touch, confirm, recentlyConfirmed, revoke, revokeAllForUser, listForUser, clientPolicy, deviceLabel, parseTs, clearCache, prune };
