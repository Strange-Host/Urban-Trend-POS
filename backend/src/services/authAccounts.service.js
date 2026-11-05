const db = require('../config/db');

// The account lookups and the password write behind the sign-in endpoints. The controller keeps the HTTP side
// (cookies, status codes); every query lives here.

const findActiveByEmail = (email) => db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND is_active = 1').get(email);
const findActiveById = (id) => db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(id);
const findById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const findIdAndRole = (id) => db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);

// Stores the new password hash, clears the forced-change flag and bumps token_version so older tokens stop working.
function setPasswordHash(userId, hash) {
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1,
      password_changed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(hash, userId);
}

module.exports = { findActiveByEmail, findActiveById, findById, findIdAndRole, setPasswordHash };
