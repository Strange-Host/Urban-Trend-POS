const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');
const securityAlerts = require('./securityAlerts.service');

// Wrong passwords and PINs are counted per account. After too many in a row the account locks for a while:
// the per-address rate limit alone doesn't stop someone who changes address, and a 4-digit PIN only has 10,000 options.
// Password sign-in and PIN sign-in are locked separately, so someone guessing a till PIN can't lock the person
// out of signing in with their password.

const COLS = {
  password: { count: 'failed_login_count', until: 'locked_until' },
  pin: { count: 'pin_failed_count', until: 'pin_locked_until' },
};
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
function rules() {
  const s = settingsService.getAll();
  return { attempts: int(s.security_lockout_attempts, 5, 3, 20), minutes: int(s.security_lockout_minutes, 15, 1, 1440) };
}

function minutesLeft(user, channel) {
  const until = user[COLS[channel].until];
  if (!until) return 0;
  const ms = Date.parse(until) - Date.now();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

/** Throws 429 when this account (or its PIN) is currently locked. Call BEFORE checking the secret. */
function assertNotLocked(user, channel = 'password') {
  if (!user) return;
  const m = minutesLeft(user, channel);
  if (m > 0) {
    throw new ApiError(429, `Too many wrong ${channel === 'pin' ? 'PINs' : 'passwords'}. Try again in ${m} minute${m === 1 ? '' : 's'}, or ask an admin.`, { retryAfterMinutes: m }, 'ACCOUNT_LOCKED');
  }
}

/** Counts a wrong attempt. Returns { locked, attemptsLeft }. */
function recordFailure(user, channel = 'password', { ip } = {}) {
  if (!user) return { locked: false, attemptsLeft: null };
  const c = COLS[channel];
  const { attempts, minutes } = rules();
  const fresh = db.prepare(`SELECT ${c.count} AS n FROM users WHERE id = ?`).get(user.id);
  const n = (fresh?.n || 0) + 1;
  if (n >= attempts) {
    const until = new Date(Date.now() + minutes * 60000).toISOString();
    db.prepare(`UPDATE users SET ${c.count} = 0, ${c.until} = ? WHERE id = ?`).run(until, user.id);
    securityAlerts.accountLocked({ user, channel, minutes, attempts, ip });
    return { locked: true, attemptsLeft: 0 };
  }
  db.prepare(`UPDATE users SET ${c.count} = ? WHERE id = ?`).run(n, user.id);
  return { locked: false, attemptsLeft: attempts - n };
}

function recordSuccess(user, channel = 'password') {
  const c = COLS[channel];
  if ((user[c.count] || 0) > 0 || user[c.until]) {
    db.prepare(`UPDATE users SET ${c.count} = 0, ${c.until} = NULL WHERE id = ?`).run(user.id);
  }
}

/** Admin action: lift both locks right now. */
function clearLocks(userId) {
  db.prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL, pin_failed_count = 0, pin_locked_until = NULL WHERE id = ?`).run(userId);
}

module.exports = { assertNotLocked, recordFailure, recordSuccess, clearLocks, minutesLeft, rules };
