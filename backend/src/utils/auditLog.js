const db = require('../config/db');

// Shared logging utility (§0 / §6 Staff Logs). Called explicitly from each
// module's service/controller layer on every create/update/delete — this repo
// uses raw better-sqlite3 rather than an ORM, so there are no lifecycle hooks
// to attach to; this single call site per mutation is the equivalent guardrail.
function diffFields(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    const b = before ? before[key] ?? null : null;
    const a = after[key] ?? null;
    if (b !== a) changes[key] = { from: b, to: a };
  }
  return changes;
}

function logStaffAction({ staffId, action, entityType, entityId, before = null, after = null }) {
  const changes = action === 'delete' ? (before || {}) : diffFields(before, after || {});
  db.prepare(`
    INSERT INTO staff_logs (staff_id, action, entity_type, entity_id, changes)
    VALUES (?, ?, ?, ?, ?)
  `).run(staffId, action, entityType, entityId, JSON.stringify(changes));
}

module.exports = { logStaffAction };
