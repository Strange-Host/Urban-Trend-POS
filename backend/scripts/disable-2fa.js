#!/usr/bin/env node
// Break-glass: turn off SMS sign-in codes for one account from the server, for
// the case where the SMS provider is down (or the phone number is lost) and an
// admin can't get a code. Usage:  npm run disable-2fa -- admin@example.com
// Needs shell access to the server, which is the point — it is not reachable
// over the API.
require('dotenv').config();
const db = require('../src/config/db');

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run disable-2fa -- <email>');
  process.exit(1);
}
const user = db.prepare('SELECT id, email, two_factor_enabled FROM users WHERE lower(email) = lower(?)').get(email.trim());
if (!user) {
  console.error(`No user with email "${email}".`);
  process.exit(1);
}
db.prepare(`UPDATE users SET two_factor_enabled = 0, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?`).run(user.id);
db.prepare(`INSERT INTO staff_logs (staff_id, action, entity_type, entity_id, changes) VALUES (NULL, 'update', 'staff', ?, ?)`)
  .run(user.id, JSON.stringify({ two_factor_enabled: { before: user.two_factor_enabled, after: 0 }, via: 'scripts/disable-2fa.js' }));
console.log(`Sign-in codes are now OFF for ${user.email}. Their existing sessions were signed out.`);
