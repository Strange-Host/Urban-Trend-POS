const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1 } = require('../utils/mobileAudit');
const permissionsService = require('../services/permissions.service');
const orders = require('../services/orders.service');

// Returned parcels on the phone. A "return" here IS the order (id = order id): staff receive it with a reason and the
// condition they found, then the existing return rules decide what happens to the stock. Nothing about those rules is new:
//   restock            = inspection "good" (needs orders.inspect: manager approval for resale) - stock comes back
//   write_off, dispose = inspection "damaged" + the owner's decision (admin only, as on the website) - stock does not come back

const iso = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'}`).toISOString() : null);
const RECEIVABLE = ['dispatched_unpaid', 'dispatched_partial', 'dispatched_paid', 'returned_in_transit'];

const SELECT = `
  SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, ru.name AS received_by_name,
         (SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE order_id = o.id) AS item_count
  FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users ru ON ru.id = o.return_received_by`;

function decisionOf(o) {
  if (o.status === 'returned_resellable') return 'restock';
  return o.owner_decision || null;
}
const shape = (o) => ({
  id: o.id, number: o.product_code || `#${o.id}`, status: o.status, customer: { name: o.customer_name, phone: o.customer_phone || null },
  totalCents: o.total, itemCount: o.item_count, reasonCode: o.return_reason || null,
  condition: o.return_received_condition || o.inspection_result || null, receivedBy: o.received_by_name || null, receivedAt: iso(o.return_received_at || o.returned_at),
  decision: decisionOf(o), decidedAt: iso(o.owner_decision_at || o.inspected_at), note: o.owner_decision_notes || null,
});
const load = (id, storeId) => db.prepare(`${SELECT} WHERE o.id = ? AND o.store_id = ? AND o.deleted_at IS NULL`).get(id, storeId);
const mustLoad = (id, storeId) => { const o = load(id, storeId); if (!o) throw new ApiError(404, 'Order not found.'); return o; };

const awaiting = `(o.status = 'returned_awaiting_inspection' OR (o.status = 'returned_damaged' AND o.owner_decision IS NULL))`;
const decided = `(o.status = 'returned_resellable' OR (o.status = 'returned_damaged' AND o.owner_decision IS NOT NULL))`;

const list = asyncHandler(async (req, res) => {
  const status = req.query.status === 'decided' ? 'decided' : 'awaiting';
  const limit = cursorUtil.pageSize(req.query.limit);
  const cur = cursorUtil.decode(req.query.cursor);
  const rows = db.prepare(`${SELECT} WHERE o.store_id = @store AND o.deleted_at IS NULL AND ${status === 'awaiting' ? awaiting : decided} ${cur && Number.isInteger(cur.i) ? 'AND o.id < @before' : ''} ORDER BY o.id DESC LIMIT @take`)
    .all({ store: req.user.storeId, before: cur && cur.i, take: limit + 1 });
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  res.json({ items: page.map(shape), nextCursor: more ? cursorUtil.encode({ i: page[page.length - 1].id }) : null });
});

// Find the parcel that came back: dispatched orders matching an order number, customer name or phone.
const receivable = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ items: [] });
  const term = `%${q}%`;
  const rows = db.prepare(`${SELECT} WHERE o.store_id = ? AND o.deleted_at IS NULL AND o.status IN (${RECEIVABLE.map(() => '?').join(',')})
    AND (o.product_code LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR CAST(o.id AS TEXT) = ?) ORDER BY o.id DESC LIMIT 20`)
    .all(req.user.storeId, ...RECEIVABLE, term, term, term, q.replace(/^#/, ''));
  res.json({ items: rows.map(shape) });
});

const receive = asyncHandler(async (req, res) => {
  const { orderId, reasonCode, condition, note } = req.body;
  const o = mustLoad(orderId, req.user.storeId);
  if (!RECEIVABLE.includes(o.status)) throw new ApiError(409, `This order is "${o.status.replace(/_/g, ' ')}", so there is no parcel to receive.`, null, 'NOT_RETURNABLE');
  db.transaction(() => {
    if (o.status !== 'returned_in_transit') orders.markReturnedInTransit({ orderId, storeId: req.user.storeId, staffId: req.user.id, notes: note || null, reasonCode });
    orders.markReturnedAwaitingInspection({ orderId, storeId: req.user.storeId, staffId: req.user.id });
    db.prepare(`UPDATE orders SET return_reason = ?, return_received_by = ?, return_received_at = datetime('now'), return_received_condition = ? WHERE id = ?`).run(reasonCode, req.user.id, condition, orderId);
  })();
  auditV1(req, { action: 'update', entityType: 'order_return', entityId: orderId, after: { reasonCode, condition }, reason: note || null });
  res.status(201).json(shape(mustLoad(orderId, req.user.storeId)));
});

const decide = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { decision, note } = req.body;
  const o = mustLoad(id, req.user.storeId);
  const isOwner = req.user.role === 'admin';
  if (decision === 'restock') {
    if (!permissionsService.can(req.user, 'orders.inspect')) throw new ApiError(403, 'You do not have permission to do that.', null, 'FORBIDDEN');
  } else if (!isOwner) {
    throw new ApiError(403, 'Only the owner can write off or dispose of returned stock.', null, 'FORBIDDEN');
  }
  if (o.status === 'returned_resellable' || (o.status === 'returned_damaged' && o.owner_decision)) throw new ApiError(409, 'This return was already decided.', null, 'ALREADY_DECIDED');
  if (o.status === 'returned_damaged' && decision === 'restock') throw new ApiError(409, 'This parcel was inspected as damaged and cannot go back on sale.', null, 'NOT_RESTOCKABLE');
  if (!['returned_awaiting_inspection', 'returned_damaged'].includes(o.status)) throw new ApiError(409, 'This parcel has not been received yet.', null, 'NOT_RECEIVED');
  const args = { orderId: id, storeId: req.user.storeId, staffId: req.user.id };
  db.transaction(() => {
    if (o.status === 'returned_awaiting_inspection') orders.inspectReturn({ ...args, result: decision === 'restock' ? 'good' : 'damaged', notes: note || null });
    if (decision !== 'restock') orders.decideOwnerAction({ ...args, decision, notes: note || null });
  })();
  auditV1(req, { action: 'update', entityType: 'order_return', entityId: id, after: { decision }, reason: note || null });
  res.json(shape(mustLoad(id, req.user.storeId)));
});

module.exports = { list, receivable, receive, decide };
