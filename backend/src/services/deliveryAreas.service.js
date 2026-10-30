const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { computeDeliveryFee } = require('../utils/delivery');

// The Joyfull Cargo rate card: one row per delivery area with its own fee. When an order's
// town matches an area, that fee replaces the flat/percent rule. Money is integer cents.

// "Kasarani - Nairobi", "kasarani, nairobi" and "KASARANI" all reduce to words we can compare.
function normalizeKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toCents(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[, ]/g, '').replace(/^ksh?\.?/i, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function list({ includeInactive = false, search } = {}) {
  const where = []; const params = [];
  if (!includeInactive) where.push('is_active = 1');
  if (search) { where.push('area_key LIKE ?'); params.push(`%${normalizeKey(search)}%`); }
  return db.prepare(`SELECT * FROM delivery_areas ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY area_name COLLATE NOCASE`).all(...params);
}

function get(id) {
  const row = db.prepare('SELECT * FROM delivery_areas WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'Delivery area not found.');
  return row;
}

function create({ staffId, areaName, fee, courierType, notes }) {
  const key = normalizeKey(areaName);
  if (!key) throw new ApiError(400, 'Area name is required.');
  if (db.prepare('SELECT 1 FROM delivery_areas WHERE area_key = ?').get(key)) {
    throw new ApiError(409, `"${areaName}" is already in the delivery-area table.`);
  }
  const id = db.prepare('INSERT INTO delivery_areas (area_name, area_key, fee, courier_type, notes) VALUES (?, ?, ?, ?, ?)')
    .run(String(areaName).trim(), key, fee, courierType || null, notes || null).lastInsertRowid;
  logStaffAction({ staffId, action: 'create', entityType: 'delivery_area', entityId: id, after: { area_name: areaName, fee } });
  return get(id);
}

function update({ id, staffId, areaName, fee, courierType, notes, isActive }) {
  const before = get(id);
  const name = areaName !== undefined ? String(areaName).trim() : before.area_name;
  const key = normalizeKey(name);
  if (!key) throw new ApiError(400, 'Area name is required.');
  const clash = db.prepare('SELECT id FROM delivery_areas WHERE area_key = ? AND id <> ?').get(key, id);
  if (clash) throw new ApiError(409, `"${name}" is already in the delivery-area table.`);
  db.prepare(`UPDATE delivery_areas SET area_name = ?, area_key = ?, fee = ?, courier_type = ?, notes = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, key, fee ?? before.fee, courierType === undefined ? before.courier_type : courierType, notes === undefined ? before.notes : notes,
      isActive === undefined ? before.is_active : (isActive ? 1 : 0), id);
  const after = get(id);
  logStaffAction({ staffId, action: 'update', entityType: 'delivery_area', entityId: id, before: { area_name: before.area_name, fee: before.fee }, after: { area_name: after.area_name, fee: after.fee } });
  return after;
}

function remove({ id, staffId }) {
  const before = get(id);
  db.prepare('DELETE FROM delivery_areas WHERE id = ?').run(id);
  logStaffAction({ staffId, action: 'delete', entityType: 'delivery_area', entityId: id, before: { area_name: before.area_name, fee: before.fee } });
}

// Bulk load (the ~150-row rate card). Existing areas are updated in place, so re-running the
// import with a corrected sheet is safe. Rows with a bad name or fee are reported, not guessed at,
// and nothing is written unless every row is valid.
function importRows({ staffId, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'No rows to import.');
  const problems = []; const clean = new Map();
  rows.forEach((r, i) => {
    const name = String(r.area_name ?? r.area ?? '').trim();
    const key = normalizeKey(name);
    const fee = toCents(r.fee ?? r.rate);
    const courier = r.courier_type ? String(r.courier_type).toLowerCase() : null;
    if (!key) problems.push(`Row ${i + 1}: area name is missing.`);
    else if (fee === null) problems.push(`Row ${i + 1} (${name}): fee "${r.fee ?? r.rate}" is not a valid amount.`);
    else if (courier && !['boda', 'g4s'].includes(courier)) problems.push(`Row ${i + 1} (${name}): courier must be boda or g4s.`);
    else clean.set(key, { name, key, fee, courier, notes: r.notes ? String(r.notes).trim() : null }); // a repeated area: the last row wins
  });
  if (problems.length) throw new ApiError(400, `Nothing was imported. ${problems.slice(0, 10).join(' ')}${problems.length > 10 ? ` (+${problems.length - 10} more)` : ''}`);

  let created = 0; let updated = 0;
  db.transaction(() => {
    const find = db.prepare('SELECT id FROM delivery_areas WHERE area_key = ?');
    const ins = db.prepare('INSERT INTO delivery_areas (area_name, area_key, fee, courier_type, notes) VALUES (?, ?, ?, ?, ?)');
    const upd = db.prepare(`UPDATE delivery_areas SET area_name = ?, fee = ?, courier_type = ?, notes = ?, is_active = 1, updated_at = datetime('now') WHERE id = ?`);
    for (const r of clean.values()) {
      const existing = find.get(r.key);
      if (existing) { upd.run(r.name, r.fee, r.courier, r.notes, existing.id); updated += 1; }
      else { ins.run(r.name, r.key, r.fee, r.courier, r.notes); created += 1; }
    }
  })();
  logStaffAction({ staffId, action: 'create', entityType: 'delivery_area', entityId: 0, after: { imported: clean.size, created, updated } });
  return { created, updated, total: clean.size };
}

// Match a customer's town to an area. Each comma/dash-separated part is tried exactly first
// ("Kasarani, Nairobi" finds Kasarani); then the longest area name that appears inside the text.
function findForTown(town) {
  const text = normalizeKey(town);
  if (!text) return null;
  const rows = db.prepare('SELECT * FROM delivery_areas WHERE is_active = 1').all();
  if (!rows.length) return null;
  const byKey = new Map(rows.map((r) => [r.area_key, r]));
  const parts = String(town).split(/[,\-/()]+/).map(normalizeKey).filter(Boolean);
  for (const part of [text, ...parts]) if (byKey.has(part)) return byKey.get(part);
  const padded = ` ${text} `;
  let best = null;
  for (const r of rows) {
    if (padded.includes(` ${r.area_key} `) && (!best || r.area_key.length > best.area_key.length)) best = r;
  }
  return best;
}

// The fee for an order: the area's own rate when the town matches one (and area rates are on),
// otherwise the flat/percent rule it always used.
function resolveFee({ town, totalCents, settings }) {
  if (String(settings.delivery_use_area_rates) !== '0') {
    const area = findForTown(town);
    if (area) return { fee: area.fee, area, source: 'area' };
  }
  return { fee: computeDeliveryFee(totalCents, settings), area: null, source: 'rule' };
}

module.exports = { normalizeKey, list, get, create, update, remove, importRows, findForTown, resolveFee };
