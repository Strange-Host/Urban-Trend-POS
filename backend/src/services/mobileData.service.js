const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');

// Read shapes for the phone: stock lookup, orders and the alert feed, plus the person's own app preferences (quiet hours).
// The rule for everything here: money is integer cents named ...Cents, times are ISO-8601 UTC, and NOTHING returned ever
// includes cost or margin - the phone does not get those fields at all, rather than getting them and hiding them.

const iso = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'}`).toISOString() : null);
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// ---- stock lookup ---------------------------------------------------------------------------------------------------------

const UNPAID = ['dispatched_unpaid', 'dispatched_partial'];
const RETURNED = ['returned_in_transit', 'returned_awaiting_inspection', 'returned_damaged'];   // resellable returns are already back in "available"

/** Products matching a barcode/SKU (exact) or a name/SKU search, each with its stock by state. At most 20. */
function stockLookup({ storeId, barcode, q }) {
  const code = typeof barcode === 'string' ? barcode.trim() : '';
  const text = typeof q === 'string' ? q.trim() : '';
  if (!code && !text) throw new ApiError(400, 'Give a barcode or a search text.');

  const base = `SELECT p.id, p.sku, p.barcode, p.name FROM products p WHERE p.is_active = 1 AND p.approval_status = 'approved'`;
  const products = code
    ? db.prepare(`${base} AND (p.barcode = ? OR p.sku = ?) LIMIT 20`).all(code, code)
    : db.prepare(`${base} AND (p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\') ORDER BY p.name LIMIT 20`).all(`%${likeEscape(text)}%`, `%${likeEscape(text)}%`);
  if (!products.length) return [];

  const ids = products.map((p) => p.id);
  const marks = ids.map(() => '?').join(',');
  const onHand = new Map(db.prepare(`SELECT product_id, quantity FROM inventory WHERE store_id = ? AND product_id IN (${marks})`).all(storeId, ...ids).map((r) => [r.product_id, r.quantity]));
  const byState = db.prepare(`
    SELECT oi.product_id, o.status, SUM(oi.quantity) AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.store_id = ? AND o.deleted_at IS NULL AND oi.product_id IN (${marks})
    GROUP BY oi.product_id, o.status`).all(storeId, ...ids);
  const sum = (productId, statuses) => byState.filter((r) => r.product_id === productId && statuses.includes(r.status)).reduce((t, r) => t + r.qty, 0);

  return products.map((p) => ({
    id: p.id, sku: p.sku, barcode: p.barcode, name: p.name,
    available: onHand.get(p.id) ?? 0,
    awaitingDispatch: sum(p.id, ['awaiting_dispatch']),
    dispatchedUnpaid: sum(p.id, UNPAID),
    dispatchedPaid: sum(p.id, ['dispatched_paid']),
    returned: sum(p.id, RETURNED),
  }));
}

// ---- orders ---------------------------------------------------------------------------------------------------------------

const ORDER_STATUSES = ['awaiting_dispatch', 'dispatched_unpaid', 'dispatched_partial', 'dispatched_paid', 'returned_in_transit',
  'returned_awaiting_inspection', 'returned_resellable', 'returned_damaged', 'cancelled'];

const paymentState = (o) => (o.amount_paid >= o.total && o.total > 0 ? 'paid' : o.amount_paid > 0 ? 'partial' : 'unpaid');
const summarise = (o) => ({
  id: o.id, number: o.product_code || `#${o.id}`, customerName: o.customer_name, status: o.status, paymentState: paymentState(o),
  courier: o.courier_name || null, totalCents: o.total, createdAt: iso(o.created_at),
});

/** Newest first, paged by id: cursor = the last id seen. */
function ordersList({ storeId, status, courier, unpaid, cursor, limit = 25 }) {
  if (status && !ORDER_STATUSES.includes(status)) throw new ApiError(400, `status must be one of ${ORDER_STATUSES.join(', ')}.`);
  const where = ['o.store_id = ?', 'o.deleted_at IS NULL'];
  const params = [storeId];
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (unpaid) where.push(`o.status IN ('dispatched_unpaid','dispatched_partial')`);
  if (courier) { where.push('cr.name = ?'); params.push(courier); }
  const facets = db.prepare(`SELECT DISTINCT cr.name FROM orders o JOIN couriers cr ON cr.id = o.courier_id WHERE o.store_id = ? AND o.deleted_at IS NULL ORDER BY cr.name`).all(storeId).map((r) => r.name);
  const after = Number.parseInt(cursor, 10);
  if (Number.isInteger(after) && after > 0) { where.push('o.id < ?'); params.push(after); }

  const rows = db.prepare(`
    SELECT o.id, o.product_code, o.status, o.total, o.amount_paid, o.created_at, c.name AS customer_name, cr.name AS courier_name
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN couriers cr ON cr.id = o.courier_id
    WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ?`).all(...params, limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(summarise), nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null, couriers: facets };
}

function orderDetail({ storeId, id }) {
  const o = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, cr.name AS courier_name, cr.phone AS courier_phone
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN couriers cr ON cr.id = o.courier_id
    WHERE o.id = ? AND o.store_id = ? AND o.deleted_at IS NULL`).get(id, storeId);
  if (!o) throw new ApiError(404, 'Order not found.');
  const items = db.prepare(`SELECT p.name, oi.quantity AS qty, oi.unit_price AS priceCents FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(id);
  return {
    ...summarise(o), customerPhone: o.customer_phone || null, courierPhone: o.courier_phone || null,
    deliveryFeeCents: o.delivery_fee, items, notes: o.notes || undefined,
  };
}

// ---- alerts (the bell) ----------------------------------------------------------------------------------------------------

function notificationsList({ userId, cursor, limit = 25 }) {
  const params = [userId];
  let sql = 'SELECT id, type, title, body, severity, entity_type, entity_id, read_at, created_at FROM notifications WHERE user_id = ?';
  const after = Number.parseInt(cursor, 10);
  if (Number.isInteger(after) && after > 0) { sql += ' AND id < ?'; params.push(after); }
  const rows = db.prepare(`${sql} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((n) => ({
      id: n.id, type: n.type, severity: n.severity, title: n.title, body: n.body || '', createdAt: iso(n.created_at), read: n.read_at != null,
      deepLink: n.entity_type && n.entity_id ? `${n.entity_type}:${n.entity_id}` : '',
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  };
}

// ---- the person's own app preferences -------------------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function getPreferences(userId) {
  const u = db.prepare('SELECT quiet_start, quiet_end FROM users WHERE id = ?').get(userId);
  const on = Boolean(u?.quiet_start && u?.quiet_end);
  return { quietHours: { enabled: on, start: on ? u.quiet_start : '22:00', end: on ? u.quiet_end : '06:00' } };
}

function setPreferences({ userId, quietHours, device = null }) {
  if (!quietHours || typeof quietHours.enabled !== 'boolean') throw new ApiError(400, 'quietHours.enabled (true or false) is required.');
  if (quietHours.enabled) {
    if (!HHMM.test(quietHours.start || '') || !HHMM.test(quietHours.end || '')) throw new ApiError(400, 'Quiet hours start and end must look like 22:00.');
    if (quietHours.start === quietHours.end) throw new ApiError(400, 'Quiet hours cannot start and end at the same time.');
  }
  const before = getPreferences(userId);
  db.prepare('UPDATE users SET quiet_start = ?, quiet_end = ? WHERE id = ?')
    .run(quietHours.enabled ? quietHours.start : null, quietHours.enabled ? quietHours.end : null, userId);
  const after = getPreferences(userId);
  logStaffAction({ staffId: userId, action: 'update', entityType: 'app_preferences', entityId: userId, before: { quiet: JSON.stringify(before.quietHours) }, after: { quiet: JSON.stringify(after.quietHours), device } });
  return after;
}

module.exports = { stockLookup, ordersList, orderDetail, notificationsList, getPreferences, setPreferences, ORDER_STATUSES };
