const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const ordersService = require('../services/orders.service');
const reconciliationService = require('../services/reconciliation.service');
const atRiskService = require('../services/atRisk.service');

// GET /api/orders?status=&assigned_staff_id=&search=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total, summary } = ordersService.list({
    storeId: req.user.storeId, status: req.query.status, channel: req.query.channel,
    assignedStaffId: req.query.assigned_staff_id, search: req.query.search, limit, offset,
  });
  res.json({ ...paginatedResponse({ rows, total, page, limit }), summary });
});

// GET /api/orders/integrity — orders whose lines/subtotal/total disagree (detect-only; empty = all good)
const checkIntegrity = asyncHandler(async (req, res) => {
  res.json({ data: reconciliationService.findOrderLineMismatches({ storeId: req.user.storeId }) });
});

// GET /api/orders/at-risk — the manager's daily list of where money or goods may be going missing.
// Optional thresholds (whole days, or hours for the till): dispatched_no_outcome_days, delivered_unpaid_days,
// returning_days, session_open_hours. A bad or negative value falls back to the default.
const atRisk = asyncHandler(async (req, res) => {
  const num = (v) => (v === undefined || v === '' ? undefined : Math.min(Number(v), 3650));
  const q = req.query;
  const data = atRiskService.moneyAtRisk({
    storeId: req.user.storeId,
    dispatchedNoOutcomeDays: num(q.dispatched_no_outcome_days),
    deliveredUnpaidDays: num(q.delivered_unpaid_days),
    returningDays: num(q.returning_days),
    sessionOpenHours: num(q.session_open_hours),
    cashHeldDays: num(q.cash_held_days),
  });
  res.json({ data, summary: atRiskService.summarize(data) });
});

// GET /api/orders/:id — includes items, payments, and status history
const getById = asyncHandler(async (req, res) => {
  const order = ordersService.getOrderWithItems(req.params.id, req.user.storeId);
  if (!order) throw new ApiError(404, 'Order not found.');
  res.json({ data: order });
});

// POST /api/orders
const create = asyncHandler(async (req, res) => {
  const { name, phone, email, city, lead_id, assigned_staff_id, channel, items, discount_total, notes, payment_type, courier_type } = req.body;
  const order = ordersService.create({
    storeId: req.user.storeId, staffId: req.user.id,
    name, phone, email, city, leadId: lead_id, assignedStaffId: assigned_staff_id, channel,
    items, discountTotal: discount_total, notes, paymentType: payment_type, courierType: courier_type,
  });
  res.status(201).json({ data: ordersService.getOrderWithItems(order.id, req.user.storeId) });
});

// POST /api/orders/:id/confirm-cod
const confirmCod = asyncHandler(async (req, res) => {
  const order = ordersService.confirmCod({ orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id });
  res.json({ data: order });
});

// POST /api/orders/:id/courier
const setCourier = asyncHandler(async (req, res) => {
  const order = ordersService.setCourier({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, courierType: req.body.courier_type, courierId: req.body.courier_id,
  });
  res.json({ data: order });
});

// POST /api/orders/:id/merge-items
const mergeItems = asyncHandler(async (req, res) => {
  const order = ordersService.mergeItems({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, items: req.body.items,
  });
  res.json({ data: order });
});

// POST /api/orders/:id/dispatch  — body (optional): { package_fee } in cents, what the order's named courier earns
const dispatch = asyncHandler(async (req, res) => {
  // package_fee (cents) and package_fee_zero_reason: required only when the order's courier is an organization.
  const { package_fee, package_fee_zero_reason } = req.body || {};
  const order = ordersService.dispatch({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id,
    packageFee: package_fee, packageFeeZeroReason: package_fee_zero_reason,
  });
  res.json({ data: order });
});

// POST /api/orders/:id/payments
const recordPayment = asyncHandler(async (req, res) => {
  const { method, amount, reference } = req.body;
  const order = ordersService.recordPayment({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, method, amount, reference,
  });
  res.status(201).json({ data: order });
});

// POST /api/orders/:id/shop-cash  { amount, reason }
const recordShopCash = asyncHandler(async (req, res) => {
  const result = require('../services/custody.service').recordShopCash({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, amount: req.body.amount, reason: req.body.reason,
  });
  res.status(201).json({ data: result });
});

// POST /api/orders/:id/returned-in-transit
const markReturnedInTransit = asyncHandler(async (req, res) => {
  const order = ordersService.markReturnedInTransit({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, notes: req.body.notes, reasonCode: req.body.reason_code,
  });
  res.json({ data: order });
});

// POST /api/orders/:id/returned-awaiting-inspection
const markReturnedAwaitingInspection = asyncHandler(async (req, res) => {
  const order = ordersService.markReturnedAwaitingInspection({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id,
  });
  res.json({ data: order });
});

// POST /api/orders/:id/inspect — manager/admin only (route-gated)
const inspectReturn = asyncHandler(async (req, res) => {
  const { result, notes } = req.body;
  const order = ordersService.inspectReturn({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, result, notes,
  });
  res.json({ data: order });
});

// POST /api/orders/:id/cancel
const cancel = asyncHandler(async (req, res) => {
  const order = ordersService.cancel({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, notes: req.body.notes,
  });
  res.json({ data: order });
});

// POST /api/orders/:id/owner-decision — admin only (route-gated); resolves
// a 'returned_damaged' order with a write-off or disposal decision.
const decideOwnerAction = asyncHandler(async (req, res) => {
  const { decision, notes } = req.body;
  const order = ordersService.decideOwnerAction({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, decision, notes,
  });
  res.json({ data: order });
});

// GET /api/orders/pending-owner-decision — every 'returned_damaged' order
// still waiting on a write-off/disposal call. This IS the "owner
// notification" for now (see orders.service.js inspectReturn) — a
// reviewable queue rather than a push notification.
const listPendingOwnerDecisions = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total } = ordersService.listPendingOwnerDecisions({ storeId: req.user.storeId, limit, offset });
  res.json(paginatedResponse({ rows, total, page, limit }));
});

// POST /api/orders/expire-unconfirmed — admin-triggerable manual sweep,
// same pattern as POST /api/inventory/reconcile. server.js also runs this
// on a 15-minute interval; this exists for on-demand runs/testing.
const expireUnconfirmed = asyncHandler(async (req, res) => {
  const expiredIds = ordersService.expireUnconfirmedOrders();
  res.json({ data: { expiredOrderIds: expiredIds } });
});

// POST /api/orders/:id/dispute  { reason }
const openDispute = asyncHandler(async (req, res) => {
  const order = ordersService.openDispute({ orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, reason: req.body.reason });
  res.status(201).json({ data: order });
});

// POST /api/orders/:id/dispute/resolve  { outcome, notes }
const resolveDispute = asyncHandler(async (req, res) => {
  const order = ordersService.resolveDispute({
    orderId: req.params.id, storeId: req.user.storeId, staffId: req.user.id, outcome: req.body.outcome, notes: req.body.notes,
  });
  res.json({ data: order });
});

module.exports = {
  list, checkIntegrity, atRisk, getById, create, mergeItems, confirmCod, setCourier, dispatch, recordPayment, recordShopCash,
  markReturnedInTransit, markReturnedAwaitingInspection, inspectReturn, decideOwnerAction,
  listPendingOwnerDecisions, openDispute, resolveDispute, cancel, expireUnconfirmed,
};
