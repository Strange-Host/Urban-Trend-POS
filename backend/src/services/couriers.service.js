const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');

const TYPES = ['boda', 'g4s'];

function list({ storeId, includeInactive }) {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM orders o WHERE o.courier_id = c.id AND o.deleted_at IS NULL
         AND o.status IN ('dispatched_unpaid','dispatched_partial')) AS unpaid_parcels,
      (SELECT COALESCE(SUM(o.total - o.amount_paid), 0) FROM orders o WHERE o.courier_id = c.id AND o.deleted_at IS NULL
         AND o.status IN ('dispatched_unpaid','dispatched_partial')) AS unpaid_amount
    FROM couriers c WHERE c.store_id = ? ${includeInactive ? '' : 'AND c.is_active = 1'} ORDER BY c.is_active DESC, c.name
  `).all(storeId);
  return rows;
}

function getById(id, storeId) {
  const row = db.prepare('SELECT * FROM couriers WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!row) throw new ApiError(404, 'Courier not found.');
  return row;
}

function create({ storeId, staffId, name, phone, vehicle, courierType, notes }) {
  if (!TYPES.includes(courierType)) throw new ApiError(400, `courier_type must be one of ${TYPES.join(', ')}.`);
  const result = db.prepare(`INSERT INTO couriers (store_id, name, phone, vehicle, courier_type, notes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(storeId, name, phone || null, vehicle || null, courierType, notes || null);
  const row = getById(result.lastInsertRowid, storeId);
  logStaffAction({ staffId, action: 'create', entityType: 'courier', entityId: row.id, after: row });
  return row;
}

function update({ id, storeId, staffId, name, phone, vehicle, courierType, notes, isActive }) {
  const existing = getById(id, storeId);
  if (courierType !== undefined && !TYPES.includes(courierType)) throw new ApiError(400, `courier_type must be one of ${TYPES.join(', ')}.`);
  db.prepare(`
    UPDATE couriers SET name = ?, phone = ?, vehicle = ?, courier_type = ?, notes = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    name ?? existing.name, phone !== undefined ? phone : existing.phone, vehicle !== undefined ? vehicle : existing.vehicle,
    courierType ?? existing.courier_type, notes !== undefined ? notes : existing.notes,
    isActive === undefined ? existing.is_active : (isActive ? 1 : 0), id,
  );
  const row = getById(id, storeId);
  logStaffAction({ staffId, action: 'update', entityType: 'courier', entityId: id, before: existing, after: row });
  return row;
}

// Never a hard delete: past orders keep pointing at the courier who carried
// them, which is the whole point of naming couriers. Deactivating also stops
// the courier appearing in the picker for new orders.
function deactivate({ id, storeId, staffId }) {
  return update({ id, storeId, staffId, isActive: false });
}

// Used by orders.setCourier — an inactive or other-store courier can't be assigned.
function assertAssignable(courierId, storeId) {
  const row = db.prepare('SELECT * FROM couriers WHERE id = ? AND store_id = ?').get(courierId, storeId);
  if (!row) throw new ApiError(404, 'Courier not found.');
  if (!row.is_active) throw new ApiError(409, 'That courier is inactive — reactivate them or pick someone else.');
  return row;
}

module.exports = { list, getById, create, update, deactivate, assertAssignable, TYPES };
