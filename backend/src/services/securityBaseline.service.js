const bcrypt = require('bcryptjs');
const db = require('../config/db');
const logger = require('../utils/logger');

// Installs seeded before v28 gave the first admin the register PIN "1234". Remove
// it wherever it is still set on an admin account, so the well-known default can
// never be used to sign in. Any other PIN is left alone. Safe to run every start.
function clearDefaultAdminPins() {
  const rows = db.prepare(
    `SELECT id, email, pin_code_hash FROM users WHERE role = 'admin' AND pin_code_hash IS NOT NULL`
  ).all();
  let cleared = 0;
  for (const u of rows) {
    if (bcrypt.compareSync('1234', u.pin_code_hash)) {
      db.prepare(`UPDATE users SET pin_code_hash = NULL, updated_at = datetime('now') WHERE id = ?`).run(u.id);
      cleared += 1;
      logger.warn('[security] removed the default register PIN from an admin account', { userId: u.id });
    }
  }
  return cleared;
}

module.exports = { clearDefaultAdminPins };
