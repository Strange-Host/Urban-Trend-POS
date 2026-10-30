'use strict';

const defaultDb = require('../config/db');

// A database-backed store for express-rate-limit. Ported in spirit from the update branch's auth/rateLimit.ts.
//
// The default store keeps counts in memory, so a restart (a deploy, a crash, pm2 bringing the process back) gives every
// address a fresh allowance, and two processes would each count separately. This one counts in the rate_limits table:
// the count survives a restart and is shared by every process using the same database file. It sits beside the
// per-account lockout (services/loginGuard.service.js): lockout stops guessing at one person, this stops one address
// trying many people.
//
// Used for the sign-in endpoints only (password, PIN, one-time code, unlock). Those are low volume and are exactly what
// an attacker guesses at. The blanket API limiter and the webhook limiters stay in memory: they are hot paths where
// a database write per request is not worth it, and a restart resetting them is harmless.

const SWEEP_EVERY_MS = 60 * 60 * 1000;
const KEEP_EXPIRED_MS = 24 * 60 * 60 * 1000;

class SqliteRateLimitStore {
  /** @param {{ scope: string, db?: object, now?: () => number }} opts  `scope` keeps one limiter's counts apart from another's. */
  constructor({ scope, db = defaultDb, now = Date.now }) {
    if (!scope) throw new Error('SqliteRateLimitStore needs a scope');
    this.scope = scope;
    this.db = db;
    this.now = now;
    this.windowMs = 15 * 60 * 1000;
    this.lastSweep = 0;
    // One statement does the whole step atomically: start a window, count in it, or roll over to a new one once it has ended.
    this.upsert = db.prepare(`
      INSERT INTO rate_limits (key, window_start_ms, count) VALUES (@key, @now, 1)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN window_start_ms + @windowMs <= @now THEN 1 ELSE count + 1 END,
        window_start_ms = CASE WHEN window_start_ms + @windowMs <= @now THEN @now ELSE window_start_ms END
      RETURNING count, window_start_ms`);
    this.read = db.prepare('SELECT count, window_start_ms FROM rate_limits WHERE key = ?');
  }

  /** express-rate-limit hands the store its options once; the window length comes from there. */
  init(options) {
    if (options && options.windowMs) this.windowMs = options.windowMs;
  }

  k(key) { return `${this.scope}:${key}`; }

  increment(key) {
    const now = this.now();
    const row = this.upsert.get({ key: this.k(key), now, windowMs: this.windowMs });
    this.sweep(now);
    return { totalHits: row.count, resetTime: new Date(row.window_start_ms + this.windowMs) };
  }

  decrement(key) {
    this.db.prepare('UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE key = ?').run(this.k(key));
  }

  get(key) {
    const row = this.read.get(this.k(key));
    if (!row || row.window_start_ms + this.windowMs <= this.now()) return undefined;
    return { totalHits: row.count, resetTime: new Date(row.window_start_ms + this.windowMs) };
  }

  resetKey(key) {
    this.db.prepare('DELETE FROM rate_limits WHERE key = ?').run(this.k(key));
  }

  resetAll() {
    this.db.prepare('DELETE FROM rate_limits WHERE key LIKE ?').run(`${this.scope}:%`);
  }

  // Old windows are useless; clear them now and then, from inside a request that is already writing.
  sweep(now) {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    this.db.prepare('DELETE FROM rate_limits WHERE window_start_ms + ? < ?').run(this.windowMs + KEEP_EXPIRED_MS, now);
  }
}

module.exports = SqliteRateLimitStore;
