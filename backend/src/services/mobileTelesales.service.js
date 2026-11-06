const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const cursorUtil = require('../utils/cursor');
const settingsService = require('./settings.service');
const permissionsService = require('./permissions.service');
const notifications = require('./notifications.service');

// What a telesales agent works from on the phone: the online COD orders assigned to them that still wait for a phone
// confirmation, oldest first. Every rule that matters (the COD gate, the confirmation window, the state machine) stays in
// orders.service; this file adds only what the phone needs on top: "mine only", the duplicate-phone approval, rescheduling.
//
// An order that is not yours is a plain 404, never a 403: the app must not be able to tell whether an order number exists.

const iso = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'}`).toISOString() : null);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const numberOf = (o) => o.product_code || `#${o.id}`;
const MAX_RESCHEDULE_DAYS = 7;

const ORDER_SELECT = `
  SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.city AS customer_city, c.phone_normalized AS phone_norm,
         c.risk_flag AS customer_risk_flag, c.prepay_required AS customer_prepay_required
  FROM orders o JOIN customers c ON c.id = o.customer_id`;

function loadOwn({ id, user }) {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ? AND o.store_id = ? AND o.deleted_at IS NULL`).get(id, user.storeId);
  // admin sees every order (they can always step in); everyone else only their own assignment
  if (!o || (user.role !== 'admin' && o.assigned_staff_id !== user.id)) throw new ApiError(404, 'Order not found.');
  return o;
}

/** Other ACTIVE orders on the same customer phone. Merged-away and cancelled orders do not count. */
function duplicatesOf(order) {
  if (!order.phone_norm) return [];
  const ordersService = require('./orders.service');
  const marks = ordersService.ACTIVE_STATUSES.map(() => '?').join(',');
  return db.prepare(`
    SELECT o.id, o.product_code, o.status, o.total, o.created_at FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.store_id = ? AND c.phone_normalized = ? AND o.id != ? AND o.status IN (${marks}) AND o.deleted_at IS NULL
    ORDER BY o.created_at DESC`).all(order.store_id, order.phone_norm, order.id, ...ordersService.ACTIVE_STATUSES)
    .map((d) => ({ orderId: d.id, number: numberOf(d), status: d.status, totalCents: d.total, createdAt: iso(d.created_at) }));
}

function approvalOf(orderId) {
  const r = db.prepare(`SELECT * FROM duplicate_order_approvals WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(orderId);
  return r ? { id: r.id, status: r.status, requestedAt: iso(r.requested_at), reviewNote: r.review_note || null } : null;
}

const canOverrideDuplicates = (user) => user.role === 'admin' || permissionsService.can(user, 'orders.approve_duplicate');

function summary(o, extra = {}) {
  return {
    id: o.id, number: numberOf(o), status: o.status, paymentType: o.payment_type,
    customer: { name: o.customer_name, phone: o.customer_phone || null, city: o.customer_city || null },
    totalCents: o.total, deliveryFeeCents: o.delivery_fee, createdAt: iso(o.created_at),
    confirmBy: iso(o.cod_confirmation_expires_at), callbackAt: iso(o.callback_at), callbackCount: o.callback_count || 0,
    ...extra,
  };
}

function list({ user, cursor, limit = 30 }) {
  const cur = cursorUtil.decode(cursor);
  const keyset = cur && typeof cur.c === 'string' && Number.isInteger(cur.i) ? 'AND (o.created_at > @c OR (o.created_at = @c AND o.id > @i))' : '';
  const base = `o.assigned_staff_id = @me AND o.store_id = @store AND o.status = 'awaiting_dispatch' AND o.payment_type = 'cod'
                AND o.cod_confirmed_at IS NULL AND o.deleted_at IS NULL`;
  const rows = db.prepare(`${ORDER_SELECT} WHERE ${base} ${keyset} ORDER BY o.created_at ASC, o.id ASC LIMIT @take`)
    .all({ me: user.id, store: user.storeId, c: cur && cur.c, i: cur && cur.i, take: limit + 1 });
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${base}`).get({ me: user.id, store: user.storeId }).n;
  return {
    items: page.map((o) => summary(o, { itemCount: db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM order_items WHERE order_id = ?').get(o.id).n, duplicateCount: duplicatesOf(o).length })),
    nextCursor: more ? cursorUtil.encode({ c: page[page.length - 1].created_at, i: page[page.length - 1].id }) : null,
    total, serverTime: new Date().toISOString(),
  };
}

function detail({ id, user }) {
  const o = loadOwn({ id, user });
  const items = db.prepare(`SELECT oi.quantity, oi.unit_price, oi.discount, oi.line_total, p.name, p.sku FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(o.id)
    .map((i) => ({ name: i.name, sku: i.sku, quantity: i.quantity, unitPriceCents: i.unit_price, discountCents: i.discount, lineTotalCents: i.line_total }));
  const history = db.prepare(`SELECT h.to_status, h.notes, h.changed_at, u.name AS who FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by_staff_id WHERE h.order_id = ? ORDER BY h.id DESC LIMIT 10`).all(o.id)
    .map((h) => ({ status: h.to_status, note: h.notes || null, at: iso(h.changed_at), by: h.who || null }));
  const duplicates = duplicatesOf(o);
  return {
    ...summary(o), subtotalCents: o.subtotal, discountCents: o.discount_total, notes: o.notes || null, confirmed: Boolean(o.cod_confirmed_at),
    customerRisk: { flag: o.customer_risk_flag, prepayRequired: Boolean(o.customer_prepay_required) },
    items, history, duplicates, duplicateApproval: duplicates.length ? approvalOf(o.id) : null,
    mayOverrideDuplicates: canOverrideDuplicates(user),
  };
}

function assertWaiting(o) {
  if (o.status !== 'awaiting_dispatch' || o.payment_type !== 'cod' || o.cod_confirmed_at) {
    throw new ApiError(409, 'This order is not waiting for a confirmation call any more.', null, 'NOT_AWAITING');
  }
}

function confirm({ id, user }) {
  const o = loadOwn({ id, user });
  assertWaiting(o);
  const dups = duplicatesOf(o);
  if (dups.length && !canOverrideDuplicates(user)) {
    const a = approvalOf(o.id);
    if (!a || a.status !== 'approved') {
      throw new ApiError(409, 'This phone number already has another active order. A manager has to approve confirming this one.', { duplicates: dups, approval: a }, 'DUPLICATE_PHONE');
    }
  }
  const ordersService = require('./orders.service');
  db.transaction(() => {
    ordersService.confirmCod({ orderId: o.id, storeId: user.storeId, staffId: user.id });
    db.prepare(`UPDATE orders SET callback_at = NULL WHERE id = ?`).run(o.id);
  })();
  return detail({ id, user });
}

function requestApproval({ id, user, note, deviceId }) {
  const o = loadOwn({ id, user });
  assertWaiting(o);
  const dups = duplicatesOf(o);
  if (!dups.length) throw new ApiError(409, 'This order has no duplicate phone number, so it needs no approval.', null, 'NO_DUPLICATE');
  const open = db.prepare(`SELECT * FROM duplicate_order_approvals WHERE order_id = ? AND status IN ('pending','approved')`).get(o.id);
  if (open) return { approval: approvalOf(o.id), created: false };
  const rowId = Number(db.prepare(`INSERT INTO duplicate_order_approvals (store_id, order_id, other_order_ids, note, requested_by, device_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(o.store_id, o.id, dups.map((d) => d.orderId).join(','), note || null, user.id, deviceId).lastInsertRowid);
  notifications.notify({
    storeId: o.store_id, userIds: permissionsService.userIdsWith(o.store_id, 'orders.approve_duplicate', user.id), type: 'approval_requested', severity: 'info',
    title: `Confirm ${numberOf(o)}? ${o.customer_name} already has another order`, body: note || null,
    entityType: 'approval', entityId: rowId, dedupeKey: `duplicate_order_requested:${rowId}`,
  });
  return { approval: approvalOf(o.id), created: true, id: rowId };
}

function reschedule({ id, user, callbackAt, note }) {
  const o = loadOwn({ id, user });
  assertWaiting(o);
  const when = new Date(callbackAt);
  const now = Date.now();
  if (Number.isNaN(when.getTime()) || when.getTime() <= now) throw new ApiError(400, 'Pick a time in the future to call back.', null, 'INVALID_TIME');
  if (when.getTime() > now + MAX_RESCHEDULE_DAYS * 86400000) throw new ApiError(400, `You can reschedule up to ${MAX_RESCHEDULE_DAYS} days ahead.`, null, 'INVALID_TIME');
  const windowMin = parseInt(settingsService.getAll().cod_confirmation_window_minutes, 10) || 120;
  // The order must not auto-cancel before the agent has had the promised call: the window restarts from the callback time.
  const newExpiry = sqlTime(new Date(when.getTime() + windowMin * 60000));
  const keep = o.cod_confirmation_expires_at && o.cod_confirmation_expires_at > newExpiry ? o.cod_confirmation_expires_at : newExpiry;
  db.transaction(() => {
    db.prepare(`UPDATE orders SET callback_at = ?, callback_count = callback_count + 1, cod_confirmation_expires_at = ?, updated_at = datetime('now') WHERE id = ?`).run(sqlTime(when), keep, o.id);
    db.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id) VALUES (?, ?, ?, ?, ?)`)
      .run(o.id, o.status, o.status, `Call rescheduled to ${when.toISOString()}${note ? `: ${note}` : ''}`, user.id);
  })();
  return detail({ id, user });
}

function cancel({ id, user, reason }) {
  const o = loadOwn({ id, user });
  assertWaiting(o);
  const ordersService = require('./orders.service');
  db.transaction(() => {
    ordersService.cancel({ orderId: o.id, storeId: user.storeId, staffId: user.id, notes: `Cancelled by telesales: ${reason}` });
    db.prepare(`UPDATE duplicate_order_approvals SET status = 'cancelled' WHERE order_id = ? AND status IN ('pending','approved')`).run(o.id);
  })();
  return detail({ id, user });
}

module.exports = { list, detail, confirm, requestApproval, reschedule, cancel, duplicatesOf, approvalOf, loadOwn, MAX_RESCHEDULE_DAYS };
