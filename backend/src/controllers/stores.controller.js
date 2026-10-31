const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { logStaffAction } = require('../utils/auditLog');

// GET /api/stores — every branch, so screens can offer "send to ..." pickers. Names only: no figures here.
const list = asyncHandler(async (req, res) => {
  const rows = db.prepare('SELECT id, name, address, is_active, is_main FROM stores ORDER BY is_main DESC, name ASC').all();
  res.json({ data: rows.map((r) => ({ ...r, is_current: r.id === req.user.storeId })) });
});

// POST /api/stores  { name, address }  (admin) — adds an outlet. There is only ever one main store.
const create = asyncHandler(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) throw new ApiError(400, 'name is required.');
  if (db.prepare('SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE').get(name)) throw new ApiError(409, 'A branch with that name already exists.');
  const result = db.prepare('INSERT INTO stores (name, address, is_main) VALUES (?, ?, 0)').run(name, req.body.address ? String(req.body.address).trim() : null);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: req.user.id, action: 'create', entityType: 'store', entityId: store.id, after: store });
  res.status(201).json({ data: store });
});

// PUT /api/stores/:id  { name?, address?, is_active? }  (admin)
const update = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Branch not found.');
  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  if (!name) throw new ApiError(400, 'name cannot be empty.');
  const clash = db.prepare('SELECT 1 FROM stores WHERE name = ? COLLATE NOCASE AND id != ?').get(name, existing.id);
  if (clash) throw new ApiError(409, 'A branch with that name already exists.');
  const active = req.body.is_active === undefined ? existing.is_active : (req.body.is_active ? 1 : 0);
  if (existing.is_main && !active) throw new ApiError(400, 'The main store cannot be switched off.');
  db.prepare('UPDATE stores SET name = ?, address = ?, is_active = ? WHERE id = ?')
    .run(name, req.body.address !== undefined ? (req.body.address || null) : existing.address, active, existing.id);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'store', entityId: store.id, before: existing, after: store });
  res.json({ data: store });
});

module.exports = { list, create, update };
