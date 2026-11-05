const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');

// GET /api/stores — every branch, so screens can offer "send to ..." pickers. Names only: no figures here.
function listStores({ user }) {
  const rows = db.prepare('SELECT id, name, address, is_active, is_main FROM stores ORDER BY is_main DESC, name ASC').all();
  return { data: rows.map((r) => ({ ...r, is_current: r.id === user.storeId })) };
}

// POST /api/stores  { name, address }  (admin) — adds an outlet. There is only ever one main store.
function createStore({ body, user }) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new ApiError(400, 'name is required.');
  if (db.prepare('SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE').get(name)) throw new ApiError(409, 'A branch with that name already exists.');
  const result = db.prepare('INSERT INTO stores (name, address, is_main) VALUES (?, ?, 0)').run(name, body.address ? String(body.address).trim() : null);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'store', entityId: store.id, after: store });
  return { data: store };
}

// PUT /api/stores/:id  { name?, address?, is_active? }  (admin)
function updateStore({ params, body, user }) {
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(params.id);
  if (!existing) throw new ApiError(404, 'Branch not found.');
  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  if (!name) throw new ApiError(400, 'name cannot be empty.');
  const clash = db.prepare('SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE AND id != ?').get(name, existing.id);
  if (clash) throw new ApiError(409, 'A branch with that name already exists.');
  const active = body.is_active === undefined ? existing.is_active : (body.is_active ? 1 : 0);
  if (existing.is_main && !active) throw new ApiError(400, 'The main store cannot be switched off.');
  db.prepare('UPDATE stores SET name = ?, address = ?, is_active = ? WHERE id = ?')
    .run(name, body.address !== undefined ? (body.address || null) : existing.address, active, existing.id);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'store', entityId: store.id, before: existing, after: store });
  return { data: store };
}

module.exports = { listStores, createStore, updateStore };
