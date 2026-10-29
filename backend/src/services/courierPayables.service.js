const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { todaySql } = require('../utils/storeTime');

// What the business owes couriers, kept strictly apart from customer money. Ported from the update
// branch's couriers/payables.ts; the ledger there becomes plain tables here (see schema.sql).
//   Package fee   what a courier earns for a dispatch. Entered by staff at dispatch (orders.dispatch calls
//                 recordPackageFee in the same transaction). Owed from that moment whether or not the customer
//                 collects the parcel, so a returned order never cancels it.
//   Courier cost  extras: return trip, fuel, airtime, handling, repair. Entered, then approved by someone else.
// A payout lists fees and costs as separate lines, and mirrors them into expenses as two rows (two categories),
// so reports can show them side by side without mixing them. All amounts are integer cents.

const COST_KINDS = ['return_trip', 'fuel', 'airtime', 'handling', 'repair', 'other'];
const METHODS = ['mpesa', 'bank', 'cash'];

const FEES_CATEGORY = 'Courier package fees';
const COSTS_CATEGORY = 'Courier costs';

function assertCents(n, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(n) || n < 0 || (!allowZero && n === 0)) {
    throw new ApiError(422, `${field} must be a ${allowZero ? 'non-negative' : 'positive'} whole number of cents.`);
  }
}

// Payables here are for RIDERS. A courier organization holds customer money and is settled by statement
// (courierOrganizations.service.js), which nets its package fees off its remittance.
function courierOf(courierId, storeId) {
  const row = db.prepare('SELECT * FROM couriers WHERE id = ? AND store_id = ?').get(courierId, storeId);
  if (!row) throw new ApiError(404, 'Courier not found.');
  if (row.kind === 'organization') {
    throw new ApiError(409, `${row.name} is a courier organization: its fees are netted off its statements, not paid out here.`, null, 'ORGANIZATION_NOT_PAYABLE');
  }
  return row;
}

// ---- Package fees ----------------------------------------------------------------------------------------

// Called from orders.dispatch inside its transaction, so a dispatch and its fee succeed or fail together.
// Riders only: an organization's fee is written by courierOrganizations.recordPackageFeeAtDispatch (which
// requires it), so this returns null for one. A 0 fee owes nothing and is not recorded (package_fees rows
// with amount 0 need a reason, which only organizations give).
function recordPackageFee({ order, amount, staffId }) {
  assertCents(amount, 'package_fee', { allowZero: true });
  if (!order.courier_id) {
    throw new ApiError(409, 'Pick a named courier on the order before entering a package fee.');
  }
  const found = db.prepare('SELECT kind FROM couriers WHERE id = ? AND store_id = ?').get(order.courier_id, order.store_id);
  if (found && found.kind === 'organization') return null;
  if (amount === 0) return null;
  const courier = courierOf(order.courier_id, order.store_id);
  const result = db.prepare(`
    INSERT INTO package_fees (store_id, courier_id, order_id, amount, recorded_by) VALUES (?, ?, ?, ?, ?)
  `).run(order.store_id, courier.id, order.id, amount, staffId);
  const row = db.prepare('SELECT * FROM package_fees WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId, action: 'create', entityType: 'package_fee', entityId: row.id, after: row });
  return row;
}

// ---- Courier costs ---------------------------------------------------------------------------------------

function getCost(id, storeId) {
  const row = db.prepare('SELECT * FROM courier_costs WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!row) throw new ApiError(404, 'Courier cost not found.');
  return row;
}

/** Enters a cost. It owes nothing until someone else approves it. */
function recordCost({ storeId, staffId, courierId, kind, amount, description, orderId, receiptRef }) {
  if (!COST_KINDS.includes(kind)) throw new ApiError(422, `kind must be one of ${COST_KINDS.join(', ')}.`);
  assertCents(amount, 'amount');
  if (!description || !description.trim()) throw new ApiError(422, 'Say what the cost was for.');
  courierOf(courierId, storeId);
  if (orderId !== undefined && orderId !== null) {
    const order = db.prepare('SELECT id, courier_id FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
  }
  const result = db.prepare(`
    INSERT INTO courier_costs (store_id, courier_id, order_id, kind, amount, description, receipt_ref, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(storeId, courierId, orderId ?? null, kind, amount, description.trim(), receiptRef?.trim() || null, staffId);
  const row = getCost(result.lastInsertRowid, storeId);
  logStaffAction({ staffId, action: 'create', entityType: 'courier_cost', entityId: row.id, after: row });
  return row;
}

function decide({ costId, storeId, staffId, status, reason }) {
  return db.transaction(() => {
    const cost = getCost(costId, storeId);
    if (cost.status !== 'pending') throw new ApiError(409, `This cost has already been ${cost.status}.`);
    if (cost.recorded_by === staffId) {
      throw new ApiError(403, 'A cost must be approved or rejected by someone other than the person who entered it.');
    }
    // `AND status = 'pending'` makes two simultaneous decisions safe: the second changes nothing.
    const changed = db.prepare(`
      UPDATE courier_costs SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, staffId, reason || null, costId).changes;
    if (changed !== 1) throw new ApiError(409, 'This cost has already been decided.');
    const after = getCost(costId, storeId);
    logStaffAction({ staffId, action: 'update', entityType: 'courier_cost', entityId: costId, before: cost, after });
    return after;
  })();
}

function approveCost({ costId, storeId, staffId }) {
  return decide({ costId, storeId, staffId, status: 'approved' });
}

function rejectCost({ costId, storeId, staffId, reason }) {
  if (!reason || !reason.trim()) throw new ApiError(422, 'A reason is required to reject a cost.');
  return decide({ costId, storeId, staffId, status: 'rejected', reason: reason.trim() });
}

function listCosts({ storeId, courierId, status }) {
  const where = ['c.store_id = ?'];
  const args = [storeId];
  if (courierId) { where.push('c.courier_id = ?'); args.push(courierId); }
  if (status) { where.push('c.status = ?'); args.push(status); }
  return db.prepare(`
    SELECT c.*, k.name AS courier_name, r.name AS recorded_by_name, d.name AS decided_by_name,
           EXISTS (SELECT 1 FROM rider_payout_items i WHERE i.courier_cost_id = c.id) AS paid
      FROM courier_costs c
      JOIN couriers k ON k.id = c.courier_id
      JOIN users r ON r.id = c.recorded_by
      LEFT JOIN users d ON d.id = c.decided_by
     WHERE ${where.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
  `).all(...args);
}

// ---- What is owed ----------------------------------------------------------------------------------------

// Everything we owe a courier and have not yet paid, oldest first. A 0 fee owes nothing and is not listed.
// Pending and rejected costs are not owed.
function unpaidItems(courierId) {
  return db.prepare(`
    SELECT 'package_fee' AS type, f.id, f.amount, f.order_id, f.recorded_at AS since, 'Package fee' AS description
      FROM package_fees f
     WHERE f.courier_id = ? AND f.amount > 0 AND NOT EXISTS (SELECT 1 FROM rider_payout_items i WHERE i.package_fee_id = f.id)
    UNION ALL
    SELECT 'courier_cost', c.id, c.amount, c.order_id, c.decided_at, 'Courier cost (' || c.kind || '): ' || c.description
      FROM courier_costs c
     WHERE c.courier_id = ? AND c.status = 'approved' AND NOT EXISTS (SELECT 1 FROM rider_payout_items i WHERE i.courier_cost_id = c.id)
     ORDER BY since, id
  `).all(courierId, courierId);
}

function sumBy(items, type) {
  return items.filter((i) => i.type === type).reduce((s, i) => s + i.amount, 0);
}

/** One courier's position: fees and costs owed shown separately, plus costs still waiting for approval. */
function balance({ courierId, storeId }) {
  const courier = courierOf(courierId, storeId);
  const items = unpaidItems(courierId);
  const pending = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM courier_costs WHERE courier_id = ? AND status = 'pending'`).get(courierId);
  return {
    courier: { id: courier.id, name: courier.name, courier_type: courier.courier_type },
    fees_owed: sumBy(items, 'package_fee'),
    costs_owed: sumBy(items, 'courier_cost'),
    total_owed: items.reduce((s, i) => s + i.amount, 0),
    pending_costs: pending.n,
    pending_costs_amount: pending.total,
    items,
  };
}

/** Every courier with something owed or waiting, for the payables overview. */
function summary({ storeId }) {
  const couriers = db.prepare(`SELECT id FROM couriers WHERE store_id = ? AND kind = 'rider' ORDER BY name`).all(storeId);
  return couriers.map((c) => balance({ courierId: c.id, storeId }))
    .filter((b) => b.total_owed > 0 || b.pending_costs > 0)
    .map(({ items, ...rest }) => ({ ...rest, unpaid_items: items.length }));
}

// ---- Payouts ---------------------------------------------------------------------------------------------

function categoryId(name) {
  const existing = db.prepare('SELECT id FROM expense_categories WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(name).lastInsertRowid;
}

function mirrorExpense({ storeId, staffId, category, amount, description }) {
  if (amount <= 0) return null;
  const today = db.prepare(`SELECT ${todaySql()} AS d`).get().d;
  return db.prepare(`
    INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(storeId, categoryId(category), amount, description, today, staffId).lastInsertRowid;
}

/**
 * Pays a courier. With no items listed it pays everything unpaid; or pass the specific items. Records the payout with
 * every item as its own line and closes those items. The total is the sum of the items, never typed in, so it cannot
 * disagree with what is being closed. better-sqlite3 runs the transaction synchronously, so two payouts to the same
 * courier cannot interleave; the UNIQUE indexes on rider_payout_items are the backstop.
 */
function createPayout({ storeId, staffId, courierId, method, paymentRef, items }) {
  if (!METHODS.includes(method)) throw new ApiError(422, 'Pay by mpesa, bank or cash.');
  if (method !== 'cash' && !paymentRef?.trim()) {
    throw new ApiError(422, 'Enter the payment reference (M-Pesa code or bank reference).');
  }
  return db.transaction(() => {
    const courier = courierOf(courierId, storeId);
    const open = unpaidItems(courierId);
    let chosen = open;
    if (items) {
      if (new Set(items.map((i) => `${i.type}:${i.id}`)).size !== items.length) {
        throw new ApiError(422, 'An item was listed twice.');
      }
      chosen = items.map((want) => {
        const found = open.find((o) => o.type === want.type && o.id === want.id);
        if (!found) throw new ApiError(409, `${want.type.replace('_', ' ')} #${want.id} is not an unpaid item for this courier.`);
        return found;
      });
    }
    if (chosen.length === 0) throw new ApiError(409, 'There is nothing to pay this courier.');

    const feesTotal = sumBy(chosen, 'package_fee');
    const costsTotal = sumBy(chosen, 'courier_cost');
    const total = feesTotal + costsTotal;
    const ref = paymentRef?.trim() || null;
    const label = `${courier.name} (${method}${ref ? ` ${ref}` : ''})`;

    const feesExpenseId = mirrorExpense({ storeId, staffId, category: FEES_CATEGORY, amount: feesTotal, description: `Package fees paid to ${label}` });
    const costsExpenseId = mirrorExpense({ storeId, staffId, category: COSTS_CATEGORY, amount: costsTotal, description: `Courier costs paid to ${label}` });

    const payoutId = db.prepare(`
      INSERT INTO rider_payouts (store_id, courier_id, fees_total, costs_total, total, method, payment_ref, paid_by, fees_expense_id, costs_expense_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, courierId, feesTotal, costsTotal, total, method, ref, staffId, feesExpenseId, costsExpenseId).lastInsertRowid;

    const insertItem = db.prepare(`INSERT INTO rider_payout_items (payout_id, package_fee_id, courier_cost_id, amount) VALUES (?, ?, ?, ?)`);
    for (const i of chosen) {
      insertItem.run(payoutId, i.type === 'package_fee' ? i.id : null, i.type === 'courier_cost' ? i.id : null, i.amount);
    }
    const payout = getPayout({ payoutId, storeId });
    logStaffAction({ staffId, action: 'create', entityType: 'courier_payout', entityId: payoutId, after: { ...payout, lines: undefined, item_count: chosen.length } });
    return payout;
  })();
}

/** A payout with its fee lines and cost lines listed separately. */
function getPayout({ payoutId, storeId }) {
  const payout = db.prepare(`
    SELECT p.*, k.name AS courier_name, u.name AS paid_by_name
      FROM rider_payouts p JOIN couriers k ON k.id = p.courier_id JOIN users u ON u.id = p.paid_by
     WHERE p.id = ? AND p.store_id = ?
  `).get(payoutId, storeId);
  if (!payout) throw new ApiError(404, 'Payout not found.');
  const fee_lines = db.prepare(`
    SELECT i.id, i.amount, f.id AS package_fee_id, f.order_id, o.product_code AS order_code
      FROM rider_payout_items i JOIN package_fees f ON f.id = i.package_fee_id LEFT JOIN orders o ON o.id = f.order_id
     WHERE i.payout_id = ? ORDER BY i.id
  `).all(payoutId);
  const cost_lines = db.prepare(`
    SELECT i.id, i.amount, c.id AS courier_cost_id, c.kind, c.description, c.receipt_ref, c.order_id
      FROM rider_payout_items i JOIN courier_costs c ON c.id = i.courier_cost_id
     WHERE i.payout_id = ? ORDER BY i.id
  `).all(payoutId);
  return { ...payout, fee_lines, cost_lines };
}

function listPayouts({ storeId, courierId }) {
  const where = ['p.store_id = ?'];
  const args = [storeId];
  if (courierId) { where.push('p.courier_id = ?'); args.push(courierId); }
  return db.prepare(`
    SELECT p.*, k.name AS courier_name, u.name AS paid_by_name,
           (SELECT COUNT(*) FROM rider_payout_items i WHERE i.payout_id = p.id) AS item_count
      FROM rider_payouts p JOIN couriers k ON k.id = p.courier_id JOIN users u ON u.id = p.paid_by
     WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC
  `).all(...args);
}

module.exports = {
  COST_KINDS, METHODS, recordPackageFee, recordCost, approveCost, rejectCost, listCosts,
  unpaidItems, balance, summary, createPayout, getPayout, listPayouts,
};
