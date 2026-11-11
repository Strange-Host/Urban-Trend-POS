const db = require('../config/db');
const settingsService = require('./settings.service');
const { logStaffAction } = require('../utils/auditLog');

// Optional parts of the system an owner can switch off to keep the shop simple. Off = the screens
// are hidden AND the matching API refuses requests (see middleware/requireModule.js); no data is
// deleted, so switching back on restores everything.
//
//   control extras: per-user permission overrides, SMS two-factor set-up, order disputes
//           and the customer "risk" badges.
//   branches Multi-branch mode: adding branches, moving stock between them, looking at or adding staff in
//           another branch, and the branch comparison reports. With it off the system behaves as one shop:
//           every request is scoped to the signed-in person's own branch whatever the request says.
//
// control is OFF unless an admin switches it on (a missing setting counts as off). branches is
// the exception: until someone chooses, it is ON when more than one active branch already exists (so an
// upgrade never hides a working multi-branch setup) and OFF for a single-branch shop.
const KEYS = { control: 'module_control_enabled', branches: 'module_branches_enabled' };

function isEnabled(name) {
  const key = KEYS[name];
  if (!key) throw new Error(`Unknown module "${name}"`);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value === '1';
  if (name === 'branches') return db.prepare('SELECT COUNT(*) AS c FROM stores WHERE is_active = 1').get().c > 1;
  return false;
}

function getAll() {
  return { control: isEnabled('control'), branches: isEnabled('branches') };
}

function setMany(updates, actorId) {
  const before = getAll();
  const toWrite = {};
  for (const name of Object.keys(KEYS)) {
    if (typeof updates[name] === 'boolean') toWrite[KEYS[name]] = updates[name] ? '1' : '0';
  }
  if (Object.keys(toWrite).length) settingsService.setMany(toWrite, actorId);
  const after = getAll();
  if (Object.keys(KEYS).some((name) => before[name] !== after[name])) {
    logStaffAction({ staffId: actorId, action: 'update', entityType: 'modules', entityId: 0, before, after });
  }
  return after;
}

module.exports = { KEYS, isEnabled, getAll, setMany };
