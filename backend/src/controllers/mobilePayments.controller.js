const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1 } = require('../utils/mobileAudit');
const reconciliation = require('../services/paymentReconciliation.service');
const suggestions = require('../services/paymentSuggestions.service');

// Unmatched payments (payments.reconcile). Matching goes through the same service as the website, so a payment is turned
// into revenue exactly once: one payment record, order.amount_paid moved once, the notification marked matched.

const ageMinutes = (createdAt) => Math.max(0, Math.floor((Date.now() - Date.parse(`${String(createdAt).replace(' ', 'T')}Z`)) / 60000));
const toIso = (s) => (s && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);

const presentPayment = (n) => ({
  id: n.id, source: n.source, method: n.method, amountCents: n.amount, payerName: n.payer_name || null,
  reference: n.external_reference || null, createdAt: toIso(n.created_at), ageMinutes: ageMinutes(n.created_at),
});

const list = asyncHandler(async (req, res) => {
  const limit = cursorUtil.pageSize(req.query.limit);
  const cur = cursorUtil.decode(req.query.cursor);
  const params = { storeId: req.user.storeId, take: limit + 1 };
  let after = '';
  if (cur && typeof cur.t === 'string' && Number.isInteger(cur.i)) { after = 'AND (created_at > @t OR (created_at = @t AND id > @i))'; params.t = cur.t; params.i = cur.i; }
  const rows = db.prepare(`
    SELECT * FROM payment_notifications WHERE store_id = @storeId AND direction = 'incoming' AND status = 'unmatched' ${after}
    ORDER BY created_at, id LIMIT @take
  `).all(params);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const agg = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount), 0) a FROM payment_notifications WHERE store_id = ? AND direction = 'incoming' AND status = 'unmatched'`).get(req.user.storeId);
  const last = page[page.length - 1];
  res.json({ items: page.map(presentPayment), nextCursor: more && last ? cursorUtil.encode({ t: last.created_at, i: last.id }) : null, total: agg.c, unallocatedCents: agg.a });
});

function loadUnmatched(req) {
  const n = db.prepare('SELECT * FROM payment_notifications WHERE id = ? AND store_id = ?').get(Number(req.params.id), req.user.storeId);
  if (!n) throw new ApiError(404, 'Payment not found.', null, 'NOT_FOUND');
  return n;
}
const alreadyDealtWith = (n) => new ApiError(409, `This payment was already ${n.status === 'matched' ? 'matched to an order' : 'ignored'}.`, null, n.status === 'matched' ? 'ALREADY_MATCHED' : 'ALREADY_IGNORED');

const suggest = asyncHandler(async (req, res) => {
  const n = loadUnmatched(req);
  if (n.status !== 'unmatched') throw alreadyDealtWith(n);
  res.json({ items: suggestions.suggest({ notification: n, q: req.query.q }) });
});

const match = asyncHandler(async (req, res) => {
  const { orderId, method, reference } = req.body;
  const result = db.transaction(() => {
    // Re-read inside the transaction: whoever is second to tap Match finds it already matched.
    const n = loadUnmatched(req);
    if (n.status !== 'unmatched') throw alreadyDealtWith(n);
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, req.user.storeId);
    if (!order) throw new ApiError(404, 'Order not found.', null, 'ORDER_NOT_FOUND');
    if (!['dispatched_unpaid', 'dispatched_partial'].includes(order.status)) {
      throw new ApiError(409, 'That order cannot take a payment right now.', null, 'ORDER_NOT_PAYABLE');
    }
    const balance = order.total - order.amount_paid;
    if (n.amount > balance) {
      throw new ApiError(422, `The payment is more than the ${balance} still owed on that order.`, { balanceCents: balance, amountCents: n.amount }, 'AMOUNT_EXCEEDS_BALANCE');
    }
    reconciliation.manualMatch({ notificationId: n.id, storeId: req.user.storeId, orderId, staffId: req.user.id, method, reference });
    const after = db.prepare('SELECT id, product_code, total, amount_paid FROM orders WHERE id = ?').get(orderId);
    return { n, after };
  })();
  const balanceAfter = result.after.total - result.after.amount_paid;
  auditV1(req, { action: 'update', entityType: 'payment_notification', entityId: result.n.id, before: { status: 'unmatched' },
    after: { status: 'matched', order_id: orderId, amount: result.n.amount } });
  res.json({
    payment: { id: result.n.id, status: 'matched' },
    order: { id: orderId, number: result.after.product_code || `#${orderId}`, paymentState: balanceAfter <= 0 ? 'paid' : 'partial', balanceCents: Math.max(balanceAfter, 0) },
  });
});

const ignore = asyncHandler(async (req, res) => {
  const n = loadUnmatched(req);
  if (n.status !== 'unmatched') throw alreadyDealtWith(n);
  reconciliation.ignore({ notificationId: n.id, storeId: req.user.storeId, staffId: req.user.id });
  auditV1(req, { action: 'update', entityType: 'payment_notification', entityId: n.id, before: { status: 'unmatched' }, after: { status: 'ignored' }, reason: req.body.reason });
  res.json({ payment: { id: n.id, status: 'ignored' } });
});

module.exports = { list, suggest, match, ignore };
