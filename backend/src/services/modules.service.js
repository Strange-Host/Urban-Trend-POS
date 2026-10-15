const db = require('../config/db');
const settingsService = require('./settings.service');
const { logStaffAction } = require('../utils/auditLog');

// Optional parts of the system an owner can switch off to keep the shop simple. Off = the screens
// are hidden AND the matching API refuses requests (see middleware/requireModule.js); no data is
// deleted, so switching back on restores everything.
//
//   hr      HR & back office: attendance/clock-in, payroll, onboarding (employee documents and
//           agreements), requisitions.
//   control extras: per-user permission overrides, SMS two-factor set-up, order disputes
//           and the customer "risk" badges.
//
// Both are OFF unless an admin switches them on (a missing setting counts as off).
const KEYS = { hr: 'module_hr_enabled', control: 'module_control_enabled' };

function isEnabled(name) {
  const key = KEYS[name];
  if (!key) throw new Error(`Unknown module "${name}"`);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return !!row && row.value === '1';
}

function getAll() {
  return { hr: isEnabled('hr'), control: isEnabled('control') };
}

function setMany(updates, actorId) {
  const before = getAll();
  const toWrite = {};
  for (const name of Object.keys(KEYS)) {
    if (typeof updates[name] === 'boolean') toWrite[KEYS[name]] = updates[name] ? '1' : '0';
  }
  if (Object.keys(toWrite).length) settingsService.setMany(toWrite, actorId);
  const after = getAll();
  if (before.hr !== after.hr || before.control !== after.control) {
    logStaffAction({ staffId: actorId, action: 'update', entityType: 'modules', entityId: 0, before, after });
  }
  return after;
}

module.exports = { KEYS, isEnabled, getAll, setMany };
