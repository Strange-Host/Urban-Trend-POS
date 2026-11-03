const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { dateOf } = require('../utils/storeTime');

// Delivery settlement: for every dispatched order, what the delivery EARNED against what it COST.
//
//   Earned   The part of the delivery fee the customer actually paid (delivery_fee_receipts). Staff are asked at
//            every dispatch whether the customer paid and how much. A fee that was charged but not paid is the
//            shop's loss, not income.
//   Cost     Four sources, each read where it already lives so nothing is entered twice:
//              1. the courier's package fee            (package_fees)
//              2. a rider's approved extra costs       (courier_costs with this order_id)
//              3. extra costs paid by the shop         (delivery_costs): outpost-to-destination legs, handling,
//                                                      storage ... each with a mandatory reason
//   Result   earned - cost. Positive = the delivery made money, negative = it cost the shop. Costs and earnings
//            reach the profit figures on their own as they are approved (see reportsPnl.service.js), so the books
//            are right at every moment; closing a settlement freezes the per-delivery figures and confirms the
//            outcome.
//
// The settlement stays OPEN until someone confirms the order was delivered (or came back). While it is open,
// fees and costs can be added; corrections are made by adding a reversal with a reason, never by editing.
// Costs need approval by a different person than the one who entered them. All amounts are integer cents.

const COST_KINDS = ['outpost_leg', 'onward_transport', 'handling', 'storage', 'fuel', 'return_trip', 'packaging', 'other'];
const PAY_METHODS = ['cash', 'mobile_money', 'bank_transfer'];

const isDispatched = (status) => status.startsWith('dispatched_');
const isReturned = (status) => status.startsWith('returned_');

function assertCents(n, field) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new ApiError(422, `${field} must be a positive whole number of cents.`);
}

function requireReason(text, message) {
  if (typeof text !== 'string' || !text.trim()) throw new ApiError(422, message);
  return text.trim();
}

function getOrder(orderId, storeId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
  if (!order) throw new ApiError(404, 'Order not found.');
  return order;
}

// ---- Opening ---------------------------------------------------------------------------------------------

/**
 * The answer every dispatch must give about the delivery fee, validated BEFORE anything else happens so a dispatch
 * with no answer changes nothing. A fee of 0 asks nothing. Returns { collected, method, reference }.
 */
function validateFeeAnswer({ order, deliveryFeePaid, deliveryFeeCollected, deliveryFeeMethod, deliveryFeeReference }) {
  if (!order.delivery_fee || order.delivery_fee <= 0) return { collected: 0 };
  if (typeof deliveryFeePaid !== 'boolean') {
    throw new ApiError(422, 'Say whether the customer has paid the delivery fee before dispatching (delivery_fee_paid: true or false).', null, 'DELIVERY_FEE_ANSWER_REQUIRED');
  }
  if (!deliveryFeePaid) {
    if (deliveryFeeCollected) throw new ApiError(422, 'delivery_fee_collected must be empty when the fee was not paid.');
    return { collected: 0 };
  }
  assertCents(deliveryFeeCollected, 'delivery_fee_collected');
  if (deliveryFeeCollected > order.delivery_fee) {
    throw new ApiError(422, `The customer cannot have paid more than the delivery fee charged (${order.delivery_fee} cents).`);
  }
  if (!PAY_METHODS.includes(deliveryFeeMethod)) throw new ApiError(422, `delivery_fee_method must be one of ${PAY_METHODS.join(', ')}.`);
  return { collected: deliveryFeeCollected, method: deliveryFeeMethod, reference: deliveryFeeReference?.trim() || null };
}

/** Called inside orders.dispatch's transaction: opens the settlement and records what the customer paid. */
function openAtDispatch({ order, staffId, answer }) {
  db.prepare(`INSERT INTO delivery_settlements (store_id, order_id) VALUES (?, ?)`).run(order.store_id, order.id);
  if (answer.collected > 0) {
    const result = db.prepare(`
      INSERT INTO delivery_fee_receipts (store_id, order_id, amount, method, reference, note, recorded_by)
      VALUES (?, ?, ?, ?, ?, 'Recorded at dispatch', ?)
    `).run(order.store_id, order.id, answer.collected, answer.method, answer.reference, staffId);
    logStaffAction({ staffId, action: 'create', entityType: 'delivery_fee_receipt', entityId: result.lastInsertRowid, after: { order_id: order.id, amount: answer.collected, method: answer.method } });
  }
}

// Orders dispatched before this feature existed have no settlement; one is opened the first time it is looked at.
function ensureSettlement(order) {
  let row = db.prepare('SELECT * FROM delivery_settlements WHERE order_id = ?').get(order.id);
  if (row) return row;
  if (!isDispatched(order.status) && !isReturned(order.status)) {
    throw new ApiError(409, 'A delivery settlement exists only once the order has been dispatched.', null, 'NOT_DISPATCHED');
  }
  db.prepare(`INSERT INTO delivery_settlements (store_id, order_id) VALUES (?, ?)`).run(order.store_id, order.id);
  row = db.prepare('SELECT * FROM delivery_settlements WHERE order_id = ?').get(order.id);
  return row;
}

function assertOpen(order) {
  const settlement = ensureSettlement(order);
  if (settlement.status === 'closed') {
    throw new ApiError(409, 'This delivery settlement is closed. An administrator must reopen it, with a reason, before anything is added.', null, 'SETTLEMENT_CLOSED');
  }
  return settlement;
}

/** For other services (a rider's cost entry) to refuse work against a closed settlement. */
function assertOrderSettlementOpen(orderId) {
  const row = db.prepare('SELECT status FROM delivery_settlements WHERE order_id = ?').get(orderId);
  if (row && row.status === 'closed') {
    throw new ApiError(409, 'This order\'s delivery settlement is closed. An administrator must reopen it before more costs are added.', null, 'SETTLEMENT_CLOSED');
  }
}

// ---- The figures -----------------------------------------------------------------------------------------

const NET_DIRECT = `CASE WHEN reverses_cost_id IS NULL THEN amount ELSE -amount END`;

function figures(order) {
  const feeCollected = db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM delivery_fee_receipts WHERE order_id = ?').get(order.id).t;
  const pkg = db.prepare('SELECT f.*, c.name AS courier_name, c.kind AS courier_kind FROM package_fees f JOIN couriers c ON c.id = f.courier_id WHERE f.order_id = ?').get(order.id);
  const rider = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN status = 'approved' THEN amount END), 0) AS approved,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending,
           SUM(status = 'pending') AS pending_count
      FROM courier_costs WHERE order_id = ?
  `).get(order.id);
  const direct = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN status = 'approved' THEN ${NET_DIRECT} END), 0) AS approved,
           SUM(status = 'pending') AS pending_count
      FROM delivery_costs WHERE order_id = ?
  `).get(order.id);
  const packageFee = pkg ? pkg.amount : 0;
  const costsTotal = packageFee + rider.approved + direct.approved;
  return {
    fee_charged: order.delivery_fee,
    fee_collected: feeCollected,
    fee_uncollected: order.delivery_fee - feeCollected,
    package_fee: packageFee,
    package_fee_courier: pkg ? pkg.courier_name : null,
    rider_costs: rider.approved,
    extra_costs: direct.approved,
    costs_total: costsTotal,
    result: feeCollected - costsTotal,
    pending_count: (rider.pending_count || 0) + (direct.pending_count || 0),
    pending_rider_costs: rider.pending,
  };
}

function listLines(order) {
  const receipts = db.prepare(`
    SELECT r.id, r.amount, r.method, r.reference, r.note, r.recorded_at AS at, u.name AS by
      FROM delivery_fee_receipts r JOIN users u ON u.id = r.recorded_by WHERE r.order_id = ? ORDER BY r.id
  `).all(order.id);
  const extraCosts = db.prepare(`
    SELECT c.*, u.name AS recorded_by_name, d.name AS decided_by_name
      FROM delivery_costs c JOIN users u ON u.id = c.recorded_by LEFT JOIN users d ON d.id = c.decided_by
     WHERE c.order_id = ? ORDER BY c.id
  `).all(order.id);
  const riderCosts = db.prepare(`
    SELECT c.id, c.kind, c.amount, c.description AS reason, c.receipt_ref, c.status, c.created_at, k.name AS courier_name
      FROM courier_costs c JOIN couriers k ON k.id = c.courier_id WHERE c.order_id = ? ORDER BY c.id
  `).all(order.id);
  return { fee_receipts: receipts, extra_cost_lines: extraCosts, rider_cost_lines: riderCosts };
}

/** The settlement for one order, live while open and frozen once closed. */
function get({ orderId, storeId }) {
  const order = getOrder(orderId, storeId);
  const settlement = ensureSettlement(order);
  const live = figures(order);
  const frozen = settlement.status === 'closed'
    ? { fee_charged: settlement.fee_charged, fee_collected: settlement.fee_collected, costs_total: settlement.costs_total, result: settlement.result }
    : {};
  return {
    order: { id: order.id, status: order.status, delivery_fee: order.delivery_fee, dispatched_at: order.dispatched_at },
    settlement: { ...settlement },
    ...live, ...frozen,
    ...listLines(order),
  };
}

// ---- Fee received ----------------------------------------------------------------------------------------

/** The customer paid (more of) the delivery fee after dispatch. Capped at the fee charged. */
function recordFeeReceipt({ orderId, storeId, staffId, amount, method, reference, note }) {
  assertCents(amount, 'amount');
  if (!PAY_METHODS.includes(method)) throw new ApiError(422, `method must be one of ${PAY_METHODS.join(', ')}.`);
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    assertOpen(order);
    const collected = db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM delivery_fee_receipts WHERE order_id = ?').get(orderId).t;
    if (collected + amount > order.delivery_fee) {
      throw new ApiError(409, `That would take the fee collected past the fee charged. Still unpaid: ${order.delivery_fee - collected} cents.`, null, 'FEE_OVERPAYMENT');
    }
    const result = db.prepare(`
      INSERT INTO delivery_fee_receipts (store_id, order_id, amount, method, reference, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, orderId, amount, method, reference?.trim() || null, note?.trim() || null, staffId);
    logStaffAction({ staffId, action: 'create', entityType: 'delivery_fee_receipt', entityId: result.lastInsertRowid, after: { order_id: orderId, amount, method } });
    return get({ orderId, storeId });
  })();
}

// ---- Extra costs paid by the shop ------------------------------------------------------------------------

function getCost(id, storeId) {
  const row = db.prepare('SELECT * FROM delivery_costs WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!row) throw new ApiError(404, 'Delivery cost not found.');
  return row;
}

/** Enters a cost the shop paid. It counts only once someone else approves it. The reason is mandatory. */
function recordCost({ orderId, storeId, staffId, kind, amount, reason, paidVia, reference }) {
  if (!COST_KINDS.includes(kind)) throw new ApiError(422, `kind must be one of ${COST_KINDS.join(', ')}.`);
  assertCents(amount, 'amount');
  const why = requireReason(reason, 'Say why this cost was incurred: every delivery cost needs a reason.');
  if (!PAY_METHODS.includes(paidVia)) throw new ApiError(422, `paid_via must be one of ${PAY_METHODS.join(', ')}.`);
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    assertOpen(order);
    const result = db.prepare(`
      INSERT INTO delivery_costs (store_id, order_id, kind, amount, reason, paid_via, reference, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, orderId, kind, amount, why, paidVia, reference?.trim() || null, staffId);
    const row = getCost(result.lastInsertRowid, storeId);
    logStaffAction({ staffId, action: 'create', entityType: 'delivery_cost', entityId: row.id, after: row });
    return row;
  })();
}

/**
 * Takes back all or part of an approved cost (entered twice, wrong amount). A reversal is its own row with its own
 * reason and its own approval; the original is never touched. Several reversals of one cost can never add up to
 * more than the cost, counting those still waiting for approval.
 */
function reverseCost({ costId, storeId, staffId, amount, reason }) {
  assertCents(amount, 'amount');
  const why = requireReason(reason, 'Say why this cost is being reversed.');
  return db.transaction(() => {
    const original = getCost(costId, storeId);
    if (original.reverses_cost_id) throw new ApiError(409, 'A reversal cannot itself be reversed: enter the cost again instead.');
    if (original.status !== 'approved') throw new ApiError(409, 'Only an approved cost can be reversed. Reject a pending one instead.');
    const order = getOrder(original.order_id, storeId);
    assertOpen(order);
    const taken = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM delivery_costs WHERE reverses_cost_id = ? AND status IN ('pending','approved')`).get(costId).t;
    if (taken + amount > original.amount) {
      throw new ApiError(409, `At most ${original.amount - taken} cents of this cost can still be reversed.`, null, 'REVERSAL_EXCEEDS_COST');
    }
    const result = db.prepare(`
      INSERT INTO delivery_costs (store_id, order_id, kind, amount, reason, paid_via, reference, reverses_cost_id, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, original.order_id, original.kind, amount, why, original.paid_via, original.reference, costId, staffId);
    const row = getCost(result.lastInsertRowid, storeId);
    logStaffAction({ staffId, action: 'create', entityType: 'delivery_cost', entityId: row.id, after: row });
    return row;
  })();
}

function decide({ costId, storeId, staffId, status, reason }) {
  return db.transaction(() => {
    const cost = getCost(costId, storeId);
    if (cost.status !== 'pending') throw new ApiError(409, `This cost has already been ${cost.status}.`);
    if (cost.recorded_by === staffId) {
      throw new ApiError(403, 'A cost must be approved or rejected by someone other than the person who entered it.');
    }
    assertOpen(getOrder(cost.order_id, storeId));
    const changed = db.prepare(`
      UPDATE delivery_costs SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ?
       WHERE id = ? AND status = 'pending'
    `).run(status, staffId, reason || null, costId).changes;
    if (changed !== 1) throw new ApiError(409, 'This cost has already been decided.');
    const after = getCost(costId, storeId);
    logStaffAction({ staffId, action: 'update', entityType: 'delivery_cost', entityId: costId, before: cost, after });
    return after;
  })();
}

const approveCost = ({ costId, storeId, staffId }) => decide({ costId, storeId, staffId, status: 'approved' });
const rejectCost = ({ costId, storeId, staffId, reason }) => decide({
  costId, storeId, staffId, status: 'rejected', reason: requireReason(reason, 'A reason is required to reject a cost.'),
});

/** Extra costs still waiting for a decision, oldest first: the approver's queue. */
function listPendingCosts({ storeId }) {
  return db.prepare(`
    SELECT c.*, u.name AS recorded_by_name FROM delivery_costs c JOIN users u ON u.id = c.recorded_by
     WHERE c.store_id = ? AND c.status = 'pending' ORDER BY c.id
  `).all(storeId);
}

// ---- Closing ---------------------------------------------------------------------------------------------

/**
 * Confirms the outcome and freezes the figures. A dispatched order closes as 'delivered'; one that came back to
 * the shop closes as 'returned' (its costs still stand and the shop carries them). Refuses while any cost is still
 * waiting for approval, so the frozen result is never provisional.
 */
function close({ orderId, storeId, staffId, note }) {
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    const settlement = assertOpen(order);
    let outcome;
    if (isDispatched(order.status)) outcome = 'delivered';
    else if (isReturned(order.status) && order.status !== 'returned_in_transit') outcome = 'returned';
    else throw new ApiError(409, `A settlement cannot be closed while the order is "${order.status}".`, null, 'ORDER_NOT_FINAL');

    const f = figures(order);
    if (f.pending_count > 0) {
      throw new ApiError(409, `${f.pending_count} cost(s) are still waiting for approval. Approve or reject them before closing.`, null, 'COSTS_PENDING');
    }
    db.prepare(`
      UPDATE delivery_settlements
         SET status = 'closed', outcome = ?, fee_charged = ?, fee_collected = ?, costs_total = ?, result = ?,
             closed_by = ?, closed_at = datetime('now'), close_note = ?
       WHERE id = ? AND status = 'open'
    `).run(outcome, f.fee_charged, f.fee_collected, f.costs_total, f.result, staffId, note?.trim() || null, settlement.id);
    const after = db.prepare('SELECT * FROM delivery_settlements WHERE id = ?').get(settlement.id);
    logStaffAction({ staffId, action: 'update', entityType: 'delivery_settlement', entityId: settlement.id, before: settlement, after });
    return get({ orderId, storeId });
  })();
}

/** Administrator-only, with a reason, for the rare late cost or late fee. The old frozen figures stay in the audit log. */
function reopen({ orderId, storeId, staffId, reason }) {
  const why = requireReason(reason, 'A reason is required to reopen a closed settlement.');
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    const settlement = ensureSettlement(order);
    if (settlement.status !== 'closed') throw new ApiError(409, 'This settlement is already open.');
    db.prepare(`
      UPDATE delivery_settlements
         SET status = 'open', outcome = NULL, fee_charged = NULL, fee_collected = NULL, costs_total = NULL, result = NULL,
             closed_by = NULL, closed_at = NULL, close_note = ?
       WHERE id = ?
    `).run(`Reopened: ${why}`, settlement.id);
    const after = db.prepare('SELECT * FROM delivery_settlements WHERE id = ?').get(settlement.id);
    logStaffAction({ staffId, action: 'update', entityType: 'delivery_settlement', entityId: settlement.id, before: settlement, after });
    return get({ orderId, storeId });
  })();
}

// ---- Reporting -------------------------------------------------------------------------------------------

/**
 * Every dispatched order with what it earned and cost. Closed rows show their frozen figures, open rows live
 * ones. `from`/`to` filter on the dispatch date. Includes dispatched orders that predate settlements.
 */
function list({ storeId, status, from, to, lossOnly }) {
  const where = [`o.store_id = ?`, `o.deleted_at IS NULL`, `(o.status LIKE 'dispatched\\_%' ESCAPE '\\' OR o.status LIKE 'returned\\_%' ESCAPE '\\')`];
  const args = [storeId];
  if (from) { where.push(`${dateOf('o.dispatched_at')} >= ?`); args.push(from); }
  if (to) { where.push(`${dateOf('o.dispatched_at')} <= ?`); args.push(to); }
  const orders = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.city AS customer_city
      FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE ${where.join(' AND ')} AND o.dispatched_at IS NOT NULL
     ORDER BY o.dispatched_at DESC, o.id DESC
  `).all(...args);

  const rows = [];
  for (const order of orders) {
    const s = db.prepare('SELECT * FROM delivery_settlements WHERE order_id = ?').get(order.id);
    const state = s ? s.status : 'open';
    if (status && status !== state) continue;
    const f = figures(order);
    const closed = s && s.status === 'closed';
    const row = {
      order_id: order.id, customer_name: order.customer_name, customer_city: order.customer_city, order_status: order.status,
      dispatched_at: order.dispatched_at, settlement_status: state, outcome: s?.outcome || null,
      fee_charged: closed ? s.fee_charged : f.fee_charged,
      fee_collected: closed ? s.fee_collected : f.fee_collected,
      costs_total: closed ? s.costs_total : f.costs_total,
      result: closed ? s.result : f.result,
      pending_count: closed ? 0 : f.pending_count,
    };
    if (lossOnly && row.result >= 0) continue;
    rows.push(row);
  }
  const sum = (key) => rows.reduce((t, r) => t + r[key], 0);
  const totals = {
    deliveries: rows.length,
    open: rows.filter((r) => r.settlement_status === 'open').length,
    fee_charged: sum('fee_charged'), fee_collected: sum('fee_collected'), costs_total: sum('costs_total'), result: sum('result'),
    losing_deliveries: rows.filter((r) => r.result < 0).length,
  };
  return { rows, totals };
}

module.exports = {
  COST_KINDS, PAY_METHODS,
  validateFeeAnswer, openAtDispatch, assertOrderSettlementOpen,
  get, recordFeeReceipt, recordCost, reverseCost, approveCost, rejectCost, listPendingCosts, close, reopen, list,
};
