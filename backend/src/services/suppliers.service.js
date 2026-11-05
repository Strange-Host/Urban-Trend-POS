const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { trimmed } = require('./stock.service');

// GET /api/suppliers?include_inactive=1
function listSuppliers({ query }) {
  const all = query.include_inactive === '1' || query.include_inactive === 'true';
  const rows = db.prepare(`SELECT * FROM suppliers ${all ? '' : 'WHERE is_active = 1'} ORDER BY name ASC`).all();
  return { data: rows };
}

// Used here and by the receiving flow, which may add a supplier on the spot.
function createSupplier({ name, phone, email, address, note }, userId) {
  const clean = trimmed(name);
  if (!clean) throw new ApiError(400, 'name is required.');
  const clash = db.prepare('SELECT id, is_active FROM suppliers WHERE name = ? COLLATE NOCASE').get(clean);
  if (clash) throw new ApiError(409, clash.is_active ? 'A supplier with that name already exists.' : 'A switched-off supplier already has that name; switch it back on instead.');
  const result = db.prepare(`
    INSERT INTO suppliers (name, phone, email, address, note, created_by_staff_id) VALUES (?, ?, ?, ?, ?, ?)
  `).run(clean, trimmed(phone) || null, trimmed(email) || null, trimmed(address) || null, trimmed(note) || null, userId);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: userId, action: 'create', entityType: 'supplier', entityId: supplier.id, after: supplier });
  return supplier;
}

// POST /api/suppliers  { name, phone, email, address, note }
function addSupplier({ body, user }) {
  return { data: createSupplier(body || {}, user.id) };
}

// PUT /api/suppliers/:id — renaming or switching one off is for people who manage products, not the storekeeper.
function updateSupplier({ params, body, user }) {
  const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(params.id);
  if (!existing) throw new ApiError(404, 'Supplier not found.');
  const b = body || {};
  const name = b.name !== undefined ? trimmed(b.name) : existing.name;
  if (!name) throw new ApiError(400, 'name cannot be empty.');
  if (db.prepare('SELECT 1 FROM suppliers WHERE name = ? COLLATE NOCASE AND id != ?').get(name, existing.id)) {
    throw new ApiError(409, 'A supplier with that name already exists.');
  }
  const pick = (k) => (b[k] !== undefined ? (trimmed(b[k]) || null) : existing[k]);
  db.prepare(`
    UPDATE suppliers SET name = ?, phone = ?, email = ?, address = ?, note = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(name, pick('phone'), pick('email'), pick('address'), pick('note'), b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0), existing.id);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'supplier', entityId: supplier.id, before: existing, after: supplier });
  return { data: supplier };
}

module.exports = { listSuppliers, addSupplier, updateSupplier, createSupplier };
