const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const sessions = require('./sessions.service');
const securityAlerts = require('./securityAlerts.service');

const REFRESH_TOKEN_EXPIRES_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 30;
// Two browser tabs can legitimately present the same refresh token within moments of each other; only a replay
// after this long counts as a stolen-token signal (and ends the whole session).
const REUSE_GRACE_MS = 60 * 1000;

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Issues a refresh token inside a session. Returns the RAW token — only ever available here, never stored.
 * It can never outlive the session it belongs to.
 */
function issue(userId, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('A refresh token needs a session.');
  const raw = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Math.min(
    Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
    sessions.parseTs(session.absolute_expires_at)
  )).toISOString();
  db.prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_id) VALUES (?, ?, ?, ?)
  `).run(userId, hashToken(raw), expiresAt, sessionId);
  return raw;
}

const INVALID = () => new ApiError(401, 'Invalid or expired refresh token.');

/**
 * Validates a raw refresh token and rotates it: the old one is marked revoked (pointing at its replacement),
 * a new one is issued inside the same session. Returns { user, refreshToken (new raw), session }.
 * Throws ApiError(401) for anything invalid without saying which part was wrong. Also refuses when the SESSION
 * has ended (idle too long, past its maximum, or signed out elsewhere) - code SESSION_EXPIRED.
 * A locked session may still refresh: the new access token is useless until the password/PIN unlocks it.
 */
function rotate(rawToken, { ip } = {}) {
  if (!rawToken) throw new ApiError(401, 'Refresh token required.');
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hashToken(rawToken));
  if (!row) throw INVALID();

  if (row.revoked_at) {
    // A token that was already swapped for a new one is being presented again: someone has a copy.
    if (row.replaced_by_id && row.session_id && Date.now() - sessions.parseTs(row.revoked_at) > REUSE_GRACE_MS) {
      const session = sessions.get(row.session_id);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
      if (session && !session.revoked_at && user) {
        sessions.revoke(session.id, 'token_reuse');
        securityAlerts.refreshReuse({ user, ip });
      }
    }
    throw INVALID();
  }
  if (new Date(row.expires_at) < new Date() || !row.session_id) throw INVALID();

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
  if (!user) throw INVALID();

  const session = sessions.get(row.session_id);
  const ev = sessions.evaluate(session, user.role);
  if (ev.state === 'revoked' || ev.state === 'expired') {
    if (session && !session.revoked_at) sessions.revoke(session.id, ev.reason === 'idle' ? 'idle' : 'expired');
    throw new ApiError(401, 'Your session has ended. Please sign in again.', null, 'SESSION_EXPIRED');
  }

  const txn = db.transaction(() => {
    const newRaw = issue(user.id, session.id);
    const newRow = db.prepare('SELECT id FROM refresh_tokens WHERE token_hash = ?').get(hashToken(newRaw));
    db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now'), replaced_by_id = ? WHERE id = ?`).run(newRow.id, row.id);
    return newRaw;
  });

  return { user, refreshToken: txn(), session };
}

/** Logout - ends the whole session this token belongs to. Silently no-ops on an unknown token (logout should never error). */
function revoke(rawToken) {
  if (!rawToken) return;
  const row = db.prepare('SELECT session_id FROM refresh_tokens WHERE token_hash = ?').get(hashToken(rawToken));
  db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL`).run(hashToken(rawToken));
  if (row?.session_id) sessions.revoke(row.session_id, 'signed_out');
}

/** Ends every sign-in a user has - password change, admin reset, deactivation. */
function revokeAllForUser(userId) {
  sessions.revokeAllForUser(userId, { reason: 'revoked' });
}

module.exports = { issue, rotate, revoke, revokeAllForUser };
