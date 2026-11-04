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
const COST_PAID_VIA = [...PAY_METHODS, 'deducted_by_courier'];

const isDispatched = (status) => status.startsWith('dispatched_');
const isReturned = (status) => status.startsWith('returned_');

function assertCents(n, field) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new ApiError(422, `${field} must be a positive whole number of cents.`);
}

function requireReason(text, message) {
  if (typeof text !== 'string' || !text.trim()) throw new ApiError(422, message);
  return text.trim();
}

// Who may approve. A second person approves what someone else entered; an administrator may also approve their own
// entry (so the shop is never stuck when only one person is working), and that is written to the staff log. Managers
// cannot approve their own.
function assertMayDecide({ recordedBy, staffId, staffRole, what }) {
  if (recordedBy !== staffId) return false;
  if (staffRole === 'admin') return true;
  throw new ApiError(403, `${what} must be approved or rejected by someone other than the person who entered it (an administrator may approve their own).`);
}

function getOrder(orderId, storeId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
  if (!order) throw new ApiError(404, 'Order not found.');
  return order;
}

// A mobile-money or bank reference is one real payment. It can back one delivery fee receipt and nothing else: the same
// reference already on another fee receipt, on a goods payment, or on a matched incoming notification is refused, so one
// payment can never be counted twice.
function assertReferenceUnused(storeId, reference) {
  if (!reference) return;
  const ref = reference.trim();
  const clash = db.prepare(`
    SELECT 'a delivery fee receipt' AS what FROM delivery_fee_receipts WHERE store_id = ? AND upper(trim(reference)) = upper(?)
    UNION ALL
    SELECT 'a payment on an order' FROM payment_records WHERE (store_id = ? OR store_id IS NULL) AND direction = 'incoming' AND deleted_at IS NULL AND upper(trim(reference)) = upper(?)
    UNION ALL
    SELECT 'a payment already matched to an order' FROM payment_notifications
     WHERE store_id = ? AND direction = 'incoming' AND status = 'matched' AND delivery_fee_receipt_id IS NULL AND upper(trim(external_reference)) = upper(?)
    LIMIT 1
  `).get(storeId, ref, storeId, ref, storeId, ref);
  if (clash) {
    throw new ApiError(409, `The reference ${ref} is already recorded as ${clash.what}. One payment cannot be counted twice.`, null, 'REFERENCE_ALREADY_USED');
  }
}

// ---- Verification: is the money real? ------------------------------------------------------------------

function isVerified(receiptId) {
  return !!db.prepare('SELECT 1 FROM delivery_fee_verifications WHERE receipt_id = ?').get(receiptId);
}

/** A mobile-money/bank receipt matches a real incoming payment already sitting unmatched in the reconciliation queue. */
function autoVerifyFromNotification(receipt, staffId) {
  if (!receipt.reference || !['mobile_money', 'bank_transfer'].includes(receipt.method)) return false;
  const n = db.prepare(`
    SELECT * FROM payment_notifications
     WHERE store_id = ? AND direction = 'incoming' AND status = 'unmatched'
       AND upper(trim(external_reference)) = upper(trim(?)) AND amount = ?
  `).get(receipt.store_id, receipt.reference, receipt.amount);
  if (!n) return false;
  db.prepare(`
    UPDATE payment_notifications SET status = 'matched', order_id = ?, delivery_fee_receipt_id = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(receipt.order_id, receipt.id, staffId, n.id);
  db.prepare(`INSERT INTO delivery_fee_verifications (store_id, receipt_id, via, notification_id, note, verified_by) VALUES (?, ?, 'notification', ?, ?, ?)`)
    .run(receipt.store_id, receipt.id, n.id, `Matched the incoming payment ${n.external_reference}`, staffId);
  return true;
}

/**
 * Called by paymentReconciliation when an incoming payment arrives. If its reference belongs to a delivery fee receipt that
 * is not verified yet, the money is the fee, not a payment for the goods: returns { receipt, exact }, where exact says the
 * amount agrees. The caller must NOT apply it to the order.
 */
function claimIncomingForFeeReceipt({ storeId, reference, amount }) {
  if (!reference) return null;
  const receipt = db.prepare(`
    SELECT r.* FROM delivery_fee_receipts r
     WHERE r.store_id = ? AND upper(trim(r.reference)) = upper(trim(?)) AND r.method IN ('mobile_money','bank_transfer')
       AND NOT EXISTS (SELECT 1 FROM delivery_fee_verifications v WHERE v.receipt_id = r.id)
  `).get(storeId, reference);
  return receipt ? { receipt, exact: receipt.amount === amount } : null;
}

function verifyByNotification({ receipt, notificationId, staffId }) {
  db.prepare(`INSERT INTO delivery_fee_verifications (store_id, receipt_id, via, notification_id, note, verified_by) VALUES (?, ?, 'notification', ?, 'Matched the incoming payment', ?)`)
    .run(receipt.store_id, receipt.id, notificationId, staffId);
}

/** A manager confirms a receipt: cash reached the shop (deposited), or a mobile/bank payment was seen on the statement. */
function verifyReceipt({ receiptId, storeId, staffId, staffRole, note }) {
  const why = requireReason(note, 'Say how it was confirmed (deposit slip, statement line, who handed it in).');
  return db.transaction(() => {
    const receipt = db.prepare('SELECT * FROM delivery_fee_receipts WHERE id = ? AND store_id = ?').get(receiptId, storeId);
    if (!receipt) throw new ApiError(404, 'Delivery fee receipt not found.');
    if (isVerified(receiptId)) throw new ApiError(409, 'This fee payment is already verified.');
    assertMayDecide({ recordedBy: receipt.recorded_by, staffId, staffRole, what: 'A fee payment' });
    const via = receipt.method === 'cash' ? 'deposit' : 'statement';
    db.prepare(`INSERT INTO delivery_fee_verifications (store_id, receipt_id, via, note, verified_by) VALUES (?, ?, ?, ?, ?)`)
      .run(storeId, receiptId, via, why, staffId);
    logStaffAction({ staffId, action: 'create', entityType: 'delivery_fee_verification', entityId: receiptId, after: { receipt_id: receiptId, via, note: why, self_verified: receipt.recorded_by === staffId ? 1 : 0 } });
    return db.prepare('SELECT * FROM delivery_fee_verifications WHERE receipt_id = ?').get(receiptId);
  })();
}

/** Fee payments recorded but not yet confirmed as real money, oldest first. */
function listUnverifiedReceipts({ storeId }) {
  const rows = db.prepare(`
    SELECT r.id, r.order_id, r.amount, r.method, r.reference, r.recorded_at, u.name AS recorded_by_name, r.recorded_by, c.name AS customer_name
      FROM delivery_fee_receipts r
      JOIN users u ON u.id = r.recorded_by
      JOIN orders o ON o.id = r.order_id
      JOIN customers c ON c.id = o.customer_id
     WHERE r.store_id = ? AND NOT EXISTS (SELECT 1 FROM delivery_fee_verifications v WHERE v.receipt_id = r.id)
     ORDER BY r.id
  `).all(storeId);
  return { rows, total: rows.reduce((t, r) => t + r.amount, 0) };
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
  const reference = deliveryFeeReference?.trim() || null;
  if (deliveryFeeMethod !== 'cash') {
    if (!reference) throw new ApiError(422, 'Enter the M-Pesa code or bank reference so the payment can be checked against the real money received.', null, 'FEE_REFERENCE_REQUIRED');
    assertReferenceUnused(order.store_id, reference);
  }
  return { collected: deliveryFeeCollected, method: deliveryFeeMethod, reference };
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
    autoVerifyFromNotification(db.prepare('SELECT * FROM delivery_fee_receipts WHERE id = ?').get(result.lastInsertRowid), staffId);
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
  const unverified = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS t FROM delivery_fee_receipts r
     WHERE r.order_id = ? AND NOT EXISTS (SELECT 1 FROM delivery_fee_verifications v WHERE v.receipt_id = r.id)
  `).get(order.id);
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
  const adj = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN status = 'approved' AND target_type = 'package_fee' THEN delta END), 0) AS fee_adj,
           COALESCE(SUM(CASE WHEN status = 'approved' AND target_type = 'courier_cost' THEN delta END), 0) AS cost_adj,
           SUM(status = 'pending') AS pending_count
      FROM delivery_adjustments WHERE order_id = ?
  `).get(order.id);
  const settlement = db.prepare('SELECT fee_written_off FROM delivery_settlements WHERE order_id = ?').get(order.id);
  const writtenOff = settlement ? settlement.fee_written_off : 0;

  const packageFee = (pkg ? pkg.amount : 0) + adj.fee_adj;
  const riderCosts = rider.approved + adj.cost_adj;
  const costsTotal = packageFee + riderCosts + direct.approved;
  return {
    fee_charged: order.delivery_fee,
    fee_collected: feeCollected,
    fee_written_off: writtenOff,
    fee_uncollected: order.delivery_fee - feeCollected,
    fee_outstanding: order.delivery_fee - feeCollected - writtenOff,
    unverified_receipts: unverified.n,
    unverified_amount: unverified.t,
    package_fee: packageFee,
    package_fee_courier: pkg ? pkg.courier_name : null,
    package_fee_id: pkg ? pkg.id : null,
    rider_costs: riderCosts,
    extra_costs: direct.approved,
    costs_total: costsTotal,
    result: feeCollected - costsTotal,
    pending_count: (rider.pending_count || 0) + (direct.pending_count || 0) + (adj.pending_count || 0),
    pending_rider_costs: rider.pending,
  };
}

function listLines(order) {
  const receipts = db.prepare(`
    SELECT r.id, r.amount, r.method, r.reference, r.note, r.recorded_at AS at, r.recorded_by, u.name AS by,
           v.via AS verified_via, v.verified_at, v.note AS verified_note, vu.name AS verified_by_name
      FROM delivery_fee_receipts r
      JOIN users u ON u.id = r.recorded_by
      LEFT JOIN delivery_fee_verifications v ON v.receipt_id = r.id
      LEFT JOIN users vu ON vu.id = v.verified_by
     WHERE r.order_id = ? ORDER BY r.id
  `).all(order.id);
  const adjustments = db.prepare(`
    SELECT a.*, u.name AS recorded_by_name, d.name AS decided_by_name
      FROM delivery_adjustments a JOIN users u ON u.id = a.recorded_by LEFT JOIN users d ON d.id = a.decided_by
     WHERE a.order_id = ? ORDER BY a.id
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
  return { fee_receipts: receipts, extra_cost_lines: extraCosts, rider_cost_lines: riderCosts, adjustment_lines: adjustments };
}

/** The live figures for one order by id (used by the at-risk page). */
function getFigures(orderId) {
  return figures(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
}

/** The settlement for one order, live while open and frozen once closed. */
function get({ orderId, storeId }) {
  const order = getOrder(orderId, storeId);
  const settlement = ensureSettlement(order);
  const live = figures(order);
  const frozen = settlement.status === 'closed'
    ? { fee_charged: settlement.fee_charged, fee_collected: settlement.fee_collected, costs_total: settlement.costs_total, result: settlement.result, fee_outstanding: 0 }
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
  const ref = reference?.trim() || null;
  if (method !== 'cash' && !ref) throw new ApiError(422, 'Enter the M-Pesa code or bank reference so the payment can be checked against the real money received.', null, 'FEE_REFERENCE_REQUIRED');
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    assertOpen(order);
    const collected = db.prepare('SELECT COALESCE(SUM(amount), 0) AS t FROM delivery_fee_receipts WHERE order_id = ?').get(orderId).t;
    if (collected + amount > order.delivery_fee) {
      throw new ApiError(409, `That would take the fee collected past the fee charged. Still unpaid: ${order.delivery_fee - collected} cents.`, null, 'FEE_OVERPAYMENT');
    }
    if (method !== 'cash') assertReferenceUnused(storeId, ref);
    const result = db.prepare(`
      INSERT INTO delivery_fee_receipts (store_id, order_id, amount, method, reference, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, orderId, amount, method, ref, note?.trim() || null, staffId);
    logStaffAction({ staffId, action: 'create', entityType: 'delivery_fee_receipt', entityId: result.lastInsertRowid, after: { order_id: orderId, amount, method } });
    autoVerifyFromNotification(db.prepare('SELECT * FROM delivery_fee_receipts WHERE id = ?').get(result.lastInsertRowid), staffId);
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
  if (!COST_PAID_VIA.includes(paidVia)) throw new ApiError(422, `paid_via must be one of ${COST_PAID_VIA.join(', ')}.`);
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    assertOpen(order);
    // "Deducted by the courier" means the organization taking the leg out of what it remits: the cost then rides on that
    // organization's next statement and is netted off the remittance.
    let courierId = null;
    if (paidVia === 'deducted_by_courier') {
      const org = order.courier_id ? db.prepare(`SELECT id, kind FROM couriers WHERE id = ? AND store_id = ?`).get(order.courier_id, storeId) : null;
      if (!org || org.kind !== 'organization') {
        throw new ApiError(422, 'Only a courier organization can deduct a cost from what it remits. Pick the organization on the order first.', null, 'DEDUCTION_NEEDS_ORGANIZATION');
      }
      courierId = org.id;
    }
    const result = db.prepare(`
      INSERT INTO delivery_costs (store_id, order_id, kind, amount, reason, paid_via, courier_id, reference, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, orderId, kind, amount, why, paidVia, courierId, reference?.trim() || null, staffId);
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
      INSERT INTO delivery_costs (store_id, order_id, kind, amount, reason, paid_via, courier_id, reference, reverses_cost_id, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, original.order_id, original.kind, amount, why, original.paid_via, original.courier_id, original.reference, costId, staffId);
    const row = getCost(result.lastInsertRowid, storeId);
    logStaffAction({ staffId, action: 'create', entityType: 'delivery_cost', entityId: row.id, after: row });
    return row;
  })();
}

function decide({ costId, storeId, staffId, staffRole, status, reason }) {
  return db.transaction(() => {
    const cost = getCost(costId, storeId);
    if (cost.status !== 'pending') throw new ApiError(409, `This cost has already been ${cost.status}.`);
    const self = assertMayDecide({ recordedBy: cost.recorded_by, staffId, staffRole, what: 'A cost' });
    assertOpen(getOrder(cost.order_id, storeId));
    const changed = db.prepare(`
      UPDATE delivery_costs SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ?
       WHERE id = ? AND status = 'pending'
    `).run(status, staffId, reason || null, costId).changes;
    if (changed !== 1) throw new ApiError(409, 'This cost has already been decided.');
    const after = getCost(costId, storeId);
    logStaffAction({ staffId, action: 'update', entityType: 'delivery_cost', entityId: costId, before: cost, after: { ...after, self_decided: self ? 1 : 0 } });
    return after;
  })();
}

const approveCost = ({ costId, storeId, staffId, staffRole }) => decide({ costId, storeId, staffId, staffRole, status: 'approved' });
const rejectCost = ({ costId, storeId, staffId, staffRole, reason }) => decide({
  costId, storeId, staffId, staffRole, status: 'rejected', reason: requireReason(reason, 'A reason is required to reject a cost.'),
});

// ---- Corrections to what a courier is owed -------------------------------------------------------------

/**
 * Fixes a wrong package fee, or a rider cost that was approved (even paid out) wrongly, without touching the original.
 * delta > 0: the courier is owed more; delta < 0: the courier owes the shop back. The difference is settled in the
 * courier's next payout (rider) or statement (organization). The corrected amount can never go below zero.
 */
function recordAdjustment({ orderId, storeId, staffId, targetType, delta, reason }) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw new ApiError(422, 'delta must be a whole number of cents, not 0 (negative takes money back).');
  if (!['package_fee', 'courier_cost'].includes(targetType)) throw new ApiError(422, 'target_type must be package_fee or courier_cost.');
  const why = requireReason(reason, 'Say why the amount is being corrected.');
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    assertOpen(order);
    let target;
    if (targetType === 'package_fee') {
      target = db.prepare('SELECT id, courier_id, amount FROM package_fees WHERE order_id = ? AND store_id = ?').get(orderId, storeId);
      if (!target) throw new ApiError(404, 'This order has no package fee to correct.');
    } else {
      throw new ApiError(422, 'courier_cost corrections name the cost: use recordCostAdjustment.');
    }
    return insertAdjustment({ order, storeId, staffId, targetType, target, delta, why });
  })();
}

function recordCostAdjustment({ orderId, costId, storeId, staffId, delta, reason }) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw new ApiError(422, 'delta must be a whole number of cents, not 0 (negative takes money back).');
  const why = requireReason(reason, 'Say why the amount is being corrected.');
  return db.transaction(() => {
    const target = db.prepare(`SELECT id, courier_id, amount, order_id, status FROM courier_costs WHERE id = ? AND store_id = ?`).get(costId, storeId);
    if (!target) throw new ApiError(404, 'Courier cost not found.');
    if (!target.order_id) throw new ApiError(409, 'This courier cost is not tied to an order, so it has no delivery settlement to correct.');
    if (orderId && target.order_id !== orderId) throw new ApiError(404, 'That courier cost belongs to a different order.');
    if (target.status !== 'approved') throw new ApiError(409, 'Only an approved courier cost can be corrected. Reject a pending one instead.');
    const order = getOrder(target.order_id, storeId);
    assertOpen(order);
    return insertAdjustment({ order, storeId, staffId, targetType: 'courier_cost', target, delta, why });
  })();
}

function insertAdjustment({ order, storeId, staffId, targetType, target, delta, why }) {
  const counted = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS t FROM delivery_adjustments
     WHERE target_type = ? AND target_id = ? AND status IN ('pending','approved')
  `).get(targetType, target.id).t;
  if (target.amount + counted + delta < 0) {
    throw new ApiError(409, `That would take the amount below zero. At most ${target.amount + counted} cents can be taken back.`, null, 'ADJUSTMENT_BELOW_ZERO');
  }
  const result = db.prepare(`
    INSERT INTO delivery_adjustments (store_id, order_id, courier_id, target_type, target_id, delta, reason, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(storeId, order.id, target.courier_id, targetType, target.id, delta, why, staffId);
  const row = db.prepare('SELECT * FROM delivery_adjustments WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId, action: 'create', entityType: 'delivery_adjustment', entityId: row.id, after: row });
  return row;
}

function decideAdjustment({ adjustmentId, storeId, staffId, staffRole, status, reason }) {
  return db.transaction(() => {
    const adj = db.prepare('SELECT * FROM delivery_adjustments WHERE id = ? AND store_id = ?').get(adjustmentId, storeId);
    if (!adj) throw new ApiError(404, 'Adjustment not found.');
    if (adj.status !== 'pending') throw new ApiError(409, `This adjustment has already been ${adj.status}.`);
    const self = assertMayDecide({ recordedBy: adj.recorded_by, staffId, staffRole, what: 'An adjustment' });
    assertOpen(getOrder(adj.order_id, storeId));
    const changed = db.prepare(`
      UPDATE delivery_adjustments SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ? WHERE id = ? AND status = 'pending'
    `).run(status, staffId, reason || null, adjustmentId).changes;
    if (changed !== 1) throw new ApiError(409, 'This adjustment has already been decided.');
    const after = db.prepare('SELECT * FROM delivery_adjustments WHERE id = ?').get(adjustmentId);
    logStaffAction({ staffId, action: 'update', entityType: 'delivery_adjustment', entityId: adjustmentId, before: adj, after: { ...after, self_decided: self ? 1 : 0 } });
    return after;
  })();
}

const approveAdjustment = ({ adjustmentId, storeId, staffId, staffRole }) => decideAdjustment({ adjustmentId, storeId, staffId, staffRole, status: 'approved' });
const rejectAdjustment = ({ adjustmentId, storeId, staffId, staffRole, reason }) => decideAdjustment({
  adjustmentId, storeId, staffId, staffRole, status: 'rejected', reason: requireReason(reason, 'A reason is required to reject an adjustment.'),
});

/** Extra costs still waiting for a decision, oldest first: the approver's queue. */
function listPendingCosts({ storeId }) {
  const costs = db.prepare(`
    SELECT c.*, 'cost' AS item_type, u.name AS recorded_by_name FROM delivery_costs c JOIN users u ON u.id = c.recorded_by
     WHERE c.store_id = ? AND c.status = 'pending' ORDER BY c.id
  `).all(storeId);
  const adjustments = db.prepare(`
    SELECT a.*, 'adjustment' AS item_type, a.target_type AS kind, ABS(a.delta) AS amount, u.name AS recorded_by_name
      FROM delivery_adjustments a JOIN users u ON u.id = a.recorded_by
     WHERE a.store_id = ? AND a.status = 'pending' ORDER BY a.id
  `).all(storeId);
  return [...costs, ...adjustments];
}

// ---- Closing ---------------------------------------------------------------------------------------------

/**
 * Confirms the outcome and freezes the figures. A dispatched order closes as 'delivered'; one that came back to
 * the shop closes as 'returned' (its costs still stand and the shop carries them). Refuses while any cost is still
 * waiting for approval, so the frozen result is never provisional.
 */
function close({ orderId, storeId, staffId, note, writeOffReason }) {
  return db.transaction(() => {
    const order = getOrder(orderId, storeId);
    const settlement = assertOpen(order);
    let outcome;
    if (isDispatched(order.status)) outcome = 'delivered';
    else if (isReturned(order.status) && order.status !== 'returned_in_transit') outcome = 'returned';
    else throw new ApiError(409, `A settlement cannot be closed while the order is "${order.status}".`, null, 'ORDER_NOT_FINAL');

    const f = figures(order);
    if (f.pending_count > 0) {
      throw new ApiError(409, `${f.pending_count} cost(s) or correction(s) are still waiting for approval. Approve or reject them before closing.`, null, 'COSTS_PENDING');
    }
    if (f.unverified_receipts > 0) {
      throw new ApiError(409, `${f.unverified_receipts} fee payment(s) have not been confirmed as real money yet. Confirm them (matched payment, statement line, or deposit) before closing.`, null, 'FEES_UNVERIFIED');
    }
    // A fee that was charged and never paid is the shop's loss. Closing is where that is decided on purpose, with a reason,
    // so nothing is left silently outstanding.
    let writtenOff = 0;
    let writeOffWhy = null;
    if (f.fee_outstanding > 0) {
      writeOffWhy = typeof writeOffReason === 'string' && writeOffReason.trim() ? writeOffReason.trim() : null;
      if (!writeOffWhy) {
        throw new ApiError(409, `${f.fee_outstanding} cents of the delivery fee were charged and never paid. Collect it, or write it off with a reason to close.`, null, 'FEE_OUTSTANDING');
      }
      writtenOff = f.fee_outstanding;
    }
    db.prepare(`
      UPDATE delivery_settlements
         SET status = 'closed', outcome = ?, fee_charged = ?, fee_collected = ?, costs_total = ?, result = ?,
             fee_written_off = ?, write_off_reason = ?,
             closed_by = ?, closed_at = datetime('now'), close_note = ?
       WHERE id = ? AND status = 'open'
    `).run(outcome, f.fee_charged, f.fee_collected, f.costs_total, f.result, writtenOff, writeOffWhy, staffId, note?.trim() || null, settlement.id);
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
             fee_written_off = 0, write_off_reason = NULL,
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
      fee_outstanding: closed ? 0 : f.fee_outstanding,
      unverified_receipts: f.unverified_receipts,
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
    fee_outstanding: rows.reduce((t, r) => t + r.fee_outstanding, 0),
    unverified_receipts: rows.reduce((t, r) => t + r.unverified_receipts, 0),
  };
  return { rows, totals };
}

module.exports = {
  COST_KINDS, PAY_METHODS, COST_PAID_VIA,
  validateFeeAnswer, openAtDispatch, assertOrderSettlementOpen, getFigures,
  claimIncomingForFeeReceipt, verifyByNotification, verifyReceipt, listUnverifiedReceipts,
  get, recordFeeReceipt, recordCost, reverseCost, approveCost, rejectCost, listPendingCosts, close, reopen, list,
  recordAdjustment, recordCostAdjustment, approveAdjustment, rejectAdjustment,
};
