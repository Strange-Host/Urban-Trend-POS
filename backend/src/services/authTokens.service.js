const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');

const REFRESH_TOKEN_EXPIRES_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 30;

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Issues a new refresh token for a user. Returns the RAW token — only ever available here, never stored. */
function issue(userId) {
  const raw = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)
  `).run(userId, hashToken(raw), expiresAt);
  return raw;
}

/**
 * Validates a raw refresh token and rotates it: the old one is marked
 * revoked (pointing at its replacement), a new one is issued. Returns
 * { user, refreshToken (new raw) }. Throws ApiError(401) for anything
 * invalid — expired, already revoked/used, unknown, or the user no longer
 * active — without distinguishing which in the response (same reasoning as
 * a failed login: don't tell an attacker which part was wrong).
 */
function rotate(rawToken) {
  if (!rawToken) throw new ApiError(401, 'Refresh token required.');
  const hash = hashToken(rawToken);
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash);

  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    throw new ApiError(401, 'Invalid or expired refresh token.');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
  if (!user) throw new ApiError(401, 'Invalid or expired refresh token.');

  const txn = db.transaction(() => {
    const newRaw = issue(user.id);
    const newRow = db.prepare('SELECT id FROM refresh_tokens WHERE token_hash = ?').get(hashToken(newRaw));
    db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now'), replaced_by_id = ? WHERE id = ?`).run(newRow.id, row.id);
    return newRaw;
  });

  return { user, refreshToken: txn() };
}

/** Logout — revokes one refresh token. Silently no-ops on an unknown/already-revoked token (logout should never error). */
function revoke(rawToken) {
  if (!rawToken) return;
  db.prepare(`
    UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL
  `).run(hashToken(rawToken));
}

/** Revokes every outstanding refresh token for a user — password change, admin reset, deactivation. */
function revokeAllForUser(userId) {
  db.prepare(`
    UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL
  `).run(userId);
}

module.exports = { issue, rotate, revoke, revokeAllForUser };
