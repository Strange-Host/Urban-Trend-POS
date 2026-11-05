const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const permissionsService = require('./permissions.service');
const notifications = require('./notifications.service');
const stock = require('./stock.service');

// Inter-branch transfers. Requesting a transfer moves nothing. Approving it writes the two movements together
// (out of the sending store, into the receiving one) in a single transaction, so stock is never "in transit" or lost.
// The person who requested it cannot approve it (an admin can).

const isAdmin = (u) => u.role === 'admin';
const canReview = (u) => permissionsService.can(u, 'stock.review');

const TRANSFER_SELECT = `
  SELECT t.*, f.name AS from_store_name, d.name AS to_store_name, ru.name AS requested_by_name, vu.name AS reviewed_by_name
  FROM stock_transfers t
  JOIN stores f ON f.id = t.from_store_id
  JOIN stores d ON d.id = t.to_store_id
  JOIN users ru ON ru.id = t.requested_by_staff_id
  LEFT JOIN users vu ON vu.id = t.reviewed_by_staff_id
`;

function withItems(rows) {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const items = db.prepare(`
    SELECT i.id, i.transfer_id, i.product_id, i.quantity, p.name AS product_name, p.sku
    FROM stock_transfer_items i JOIN products p ON p.id = i.product_id
    WHERE i.transfer_id IN (${ids.map(() => '?').join(',')}) ORDER BY i.id
  `).all(...ids);
  const map = new Map(rows.map((r) => [r.id, []]));
  for (const it of items) map.get(it.transfer_id).push(it);
  return rows.map((r) => ({ ...r, items: map.get(r.id), total_units: map.get(r.id).reduce((n, i) => n + i.quantity, 0) }));
}

// A branch sees transfers it sends or receives. Reviewers (admin/manager) see every branch's.
function visibleTo(user, t) {
  return canReview(user) || t.from_store_id === user.storeId || t.to_store_id === user.storeId;
}

// GET /api/stock/transfers?status=&page=&limit=
function listTransfers({ query, user }) {
  const { page, limit, offset } = parsePagination(query);
  const where = [];
  const params = {};
  if (!canReview(user)) { where.push('(t.from_store_id = @storeId OR t.to_store_id = @storeId)'); params.storeId = user.storeId; }
  if (query.status) { where.push('t.status = @status'); params.status = String(query.status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`${TRANSFER_SELECT} ${whereSql} ORDER BY t.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });
  const total = db.prepare(`SELECT COUNT(*) AS c FROM stock_transfers t ${whereSql}`).get(params).c;
  return paginatedResponse({ rows: withItems(rows), total, page, limit });
}

// GET /api/stock/transfers/:id
function getTransfer({ params, user }) {
  const row = db.prepare(`${TRANSFER_SELECT} WHERE t.id = ?`).get(params.id);
  if (!row || !visibleTo(user, row)) throw new ApiError(404, 'Transfer not found.');
  return { data: withItems([row])[0] };
}

// POST /api/stock/transfers  { to_store_id, from_store_id?, note?, items: [{ product_id, quantity }] }
function createTransfer({ user: reqUser, body }) {
  const user = reqUser;
  const b = body || {};
  const fromId = b.from_store_id ? Number(b.from_store_id) : user.storeId;
  const toId = Number(b.to_store_id);
  if (!toId) throw new ApiError(400, 'to_store_id is required.');
  if (fromId === toId) throw new ApiError(400, 'A transfer needs two different branches.');
  if (fromId !== user.storeId && !canReview(user)) throw new ApiError(403, 'You can only send stock out of your own branch.');
  for (const [label, id] of [['sending', fromId], ['receiving', toId]]) {
    const s = stock.getStore(id);
    if (!s || !s.is_active) throw new ApiError(400, `The ${label} branch does not exist (or is switched off).`);
  }
  if (!Array.isArray(b.items) || b.items.length === 0) throw new ApiError(400, 'Add at least one product to transfer.');
  if (b.items.length > 200) throw new ApiError(400, 'A transfer can have at most 200 products.');

  const seen = new Set();
  const lines = b.items.map((it, idx) => {
    let qty;
    try { qty = stock.parseQty(it.quantity); } catch (e) { throw new ApiError(400, `Line ${idx + 1}: ${e.message}`); }
    const p = db.prepare('SELECT id, name, is_active, approval_status FROM products WHERE id = ?').get(it.product_id);
    if (!p) throw new ApiError(404, `Line ${idx + 1}: product not found.`);
    if (p.approval_status !== 'approved' || !p.is_active) throw new ApiError(409, `Line ${idx + 1}: "${p.name}" is not an active, approved product.`);
    if (seen.has(p.id)) throw new ApiError(400, `"${p.name}" is listed twice; combine it into one line.`);
    seen.add(p.id);
    const onHand = stock.quantityOf(p.id, fromId);
    if (onHand < qty) throw new ApiError(409, `Not enough "${p.name}" at the sending branch: ${onHand} on hand, ${qty} asked.`, null, 'INSUFFICIENT_STOCK');
    return { product_id: p.id, quantity: qty };
  });

  const id = db.transaction(() => {
    const tid = db.prepare(`
      INSERT INTO stock_transfers (from_store_id, to_store_id, note, requested_by_staff_id) VALUES (?, ?, ?, ?)
    `).run(fromId, toId, stock.trimmed(b.note) || null, user.id).lastInsertRowid;
    const ins = db.prepare('INSERT INTO stock_transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)');
    for (const l of lines) ins.run(tid, l.product_id, l.quantity);
    return tid;
  })();

  const transfer = withItems([db.prepare(`${TRANSFER_SELECT} WHERE t.id = ?`).get(id)])[0];
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'stock_transfer', entityId: id, after: { from_store_id: fromId, to_store_id: toId, lines: lines.length, units: transfer.total_units } });
  for (const storeId of new Set([fromId, toId])) {
    notifications.notify({
      storeId, roles: ['admin', 'manager'], type: 'stock_transfer_pending',
      title: 'Stock transfer waiting for approval',
      body: `${user.name} asked to move ${transfer.total_units} unit(s) from ${transfer.from_store_name} to ${transfer.to_store_name}.`,
      entityType: 'stock_transfer', entityId: id, dedupeKey: `stock_transfer_pending:${id}`,
    });
  }
  return { data: transfer };
}

function loadPending({ params, user }, { forDecision }) {
  const t = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(params.id);
  if (!t || !visibleTo(user, t)) throw new ApiError(404, 'Transfer not found.');
  if (t.status !== 'pending') throw new ApiError(409, `This transfer is already ${t.status}.`);
  if (forDecision && t.requested_by_staff_id === user.id && !isAdmin(user)) {
    throw new ApiError(403, 'You requested this transfer, so someone else has to decide it.');
  }
  return t;
}

// POST /api/stock/transfers/:id/approve — moves the stock.
function approveTransfer({ params, user }) {
  const t = loadPending({ params: params, user: user }, { forDecision: true });
  const items = db.prepare('SELECT product_id, quantity FROM stock_transfer_items WHERE transfer_id = ?').all(t.id);

  db.transaction(() => {
    // Re-read the status inside the transaction so two approvers clicking together cannot move the stock twice.
    const fresh = db.prepare('SELECT status FROM stock_transfers WHERE id = ?').get(t.id);
    if (fresh.status !== 'pending') throw new ApiError(409, `This transfer is already ${fresh.status}.`);
    for (const it of items) {
      stock.applyMovement({ productId: it.product_id, storeId: t.from_store_id, change: -it.quantity, reason: 'transfer_out', referenceType: 'transfer', referenceId: t.id, userId: user.id });
      stock.applyMovement({ productId: it.product_id, storeId: t.to_store_id, change: it.quantity, reason: 'transfer_in', referenceType: 'transfer', referenceId: t.id, userId: user.id });
    }
    db.prepare(`UPDATE stock_transfers SET status = 'approved', reviewed_by_staff_id = ?, reviewed_at = datetime('now'), review_note = NULL WHERE id = ?`).run(user.id, t.id);
  })();

  const after = withItems([db.prepare(`${TRANSFER_SELECT} WHERE t.id = ?`).get(t.id)])[0];
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'stock_transfer', entityId: t.id, before: t, after: { ...t, status: 'approved', reviewed_by_staff_id: user.id } });
  notifications.notify({
    storeId: t.from_store_id, userIds: [t.requested_by_staff_id], type: 'stock_transfer_approved',
    title: 'Stock transfer approved', body: `${after.total_units} unit(s) moved from ${after.from_store_name} to ${after.to_store_name}.`,
    entityType: 'stock_transfer', entityId: t.id,
  });
  return { data: after };
}

// POST /api/stock/transfers/:id/reject  { note }
function rejectTransfer({ params, user, body }) {
  const t = loadPending({ params: params, user: user }, { forDecision: true });
  const note = stock.trimmed(body && body.note);
  if (!note) throw new ApiError(400, 'Say why you are rejecting it (note is required).');
  db.prepare(`UPDATE stock_transfers SET status = 'rejected', reviewed_by_staff_id = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`).run(user.id, note, t.id);
  const after = withItems([db.prepare(`${TRANSFER_SELECT} WHERE t.id = ?`).get(t.id)])[0];
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'stock_transfer', entityId: t.id, before: t, after: { ...t, status: 'rejected', review_note: note } });
  notifications.notify({
    storeId: t.from_store_id, userIds: [t.requested_by_staff_id], type: 'stock_transfer_rejected', severity: 'warning',
    title: 'Stock transfer rejected', body: note, entityType: 'stock_transfer', entityId: t.id,
  });
  return { data: after };
}

// POST /api/stock/transfers/:id/cancel — the requester withdraws it (or an admin does).
function cancelTransfer({ params, user }) {
  const t = loadPending({ params: params, user: user }, { forDecision: false });
  if (t.requested_by_staff_id !== user.id && !isAdmin(user)) throw new ApiError(403, 'Only the person who requested a transfer can withdraw it.');
  db.prepare(`UPDATE stock_transfers SET status = 'cancelled', reviewed_by_staff_id = ?, reviewed_at = datetime('now') WHERE id = ?`).run(user.id, t.id);
  const after = withItems([db.prepare(`${TRANSFER_SELECT} WHERE t.id = ?`).get(t.id)])[0];
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'stock_transfer', entityId: t.id, before: t, after: { ...t, status: 'cancelled' } });
  return { data: after };
}

module.exports = { listTransfers, getTransfer, createTransfer, approveTransfer, rejectTransfer, cancelTransfer };
