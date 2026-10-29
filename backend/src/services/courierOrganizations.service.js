const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { localDate } = require('../utils/storeTime');

// Courier organizations: firms that collect the customer's payment and remit it afterwards.
// Ported from the update branch's server/src/couriers/organizations.ts. That version posts to a
// double-entry ledger; this one has no ledger, so the same numbers are read from the tables:
//
//   recordCollection  the organization collected for an order: the order counts as paid, and the
//                     organization now holds that money.
//   createStatement   a settlement: the organization remits cash, we net off the package fees we owe
//                     it, and whatever is left stays owing. Expected, charged, received and variance
//                     are all kept.
//
// An organization's receivable always equals: collected, minus remitted, minus fees netted.
// All amounts are integer cents. Collection dates are the shop's calendar dates (Africa/Nairobi).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const BUCKETS = ['0-7', '8-14', '15-30', '30+'];
const bucketFor = (age) => (age <= 7 ? '0-7' : age <= 14 ? '8-14' : age <= 30 ? '15-30' : '30+');
const isRealDate = (s) => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isCents = (n) => Number.isSafeInteger(n);

function getOrganization(courierId, storeId) {
  const c = db.prepare('SELECT * FROM couriers WHERE id = ? AND store_id = ?').get(courierId, storeId);
  if (!c) throw new ApiError(404, 'Courier not found.', null, 'COURIER_NOT_FOUND');
  return c;
}

// ---------------------------------------------------------------- package fee (written at dispatch)

// Called by orders.dispatch() inside its transaction. Only for a parcel going out with an
// organization: riders have no package fee here. A zero fee needs a reason, so a missing fee is
// never mistaken for "nothing owed".
function recordPackageFeeAtDispatch({ order, storeId, staffId, packageFee, zeroReason }) {
  if (!order.courier_id) return null;
  const courier = db.prepare('SELECT * FROM couriers WHERE id = ? AND store_id = ?').get(order.courier_id, storeId);
  if (!courier || courier.kind !== 'organization') return null;

  if (packageFee === undefined || packageFee === null) {
    throw new ApiError(422, 'Enter the package fee we owe this organization for the parcel (0 with a reason, if there is none).', null, 'PACKAGE_FEE_REQUIRED');
  }
  if (!isCents(packageFee) || packageFee < 0) {
    throw new ApiError(422, 'The package fee must be a whole, non-negative number of cents.', null, 'PACKAGE_FEE_BAD_AMOUNT');
  }
  if (packageFee === 0 && !String(zeroReason || '').trim()) {
    throw new ApiError(422, 'A zero package fee needs a reason.', null, 'PACKAGE_FEE_ZERO_NEEDS_REASON');
  }

  if (order.payment_type === 'cod' && courier.collects_payment) {
    const standing = organizationStanding({ storeId, courierId: courier.id });
    if (standing.paused) {
      throw new ApiError(409, `${courier.name} is over its overdue limit. New collect-on-delivery parcels to this organization are paused until it remits.`, null, 'ORGANIZATION_PAUSED');
    }
  }

  const info = db.prepare(`
    INSERT INTO package_fees (store_id, order_id, courier_id, amount, zero_reason, recorded_by) VALUES (?, ?, ?, ?, ?, ?)
  `).run(storeId, order.id, courier.id, packageFee, packageFee === 0 ? String(zeroReason).trim() : null, staffId);
  return { id: info.lastInsertRowid, courierId: courier.id, orderId: order.id, amount: packageFee };
}

// ---------------------------------------------------------------- collections

function recordCollection({ storeId, staffId, courierId, orderId, amount, collectedOn }) {
  if (!staffId) throw new ApiError(422, 'The person recording this is required.', null, 'COLLECTION_NO_ACTOR');
  if (!isCents(amount) || amount <= 0) throw new ApiError(422, 'The amount must be a positive whole number of cents.', null, 'COLLECTION_BAD_AMOUNT');
  if (collectedOn !== undefined && collectedOn !== null && !isRealDate(collectedOn)) {
    throw new ApiError(422, 'Use the date format YYYY-MM-DD.', null, 'COLLECTION_BAD_DATE');
  }
  // Required, not defaulted, so the order service can be required lazily (it requires this module's callers).
  const ordersService = require('./orders.service');

  const txn = db.transaction(() => {
    const courier = getOrganization(courierId, storeId);
    if (courier.kind !== 'organization' || !courier.collects_payment) {
      throw new ApiError(409, 'Only an organization that collects payment can collect for an order. Riders never handle customer money.', null, 'COLLECTION_NOT_A_COLLECTOR');
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.', null, 'ORDER_NOT_FOUND');
    if (!['dispatched_unpaid', 'dispatched_partial', 'dispatched_paid'].includes(order.status)) {
      throw new ApiError(409, `An order that is ${order.status.replace(/_/g, ' ')} cannot have a collection recorded.`, null, 'COLLECTION_WRONG_STATE');
    }
    const fee = db.prepare('SELECT courier_id FROM package_fees WHERE order_id = ?').get(order.id);
    if (!fee || fee.courier_id !== courierId) {
      throw new ApiError(409, 'This order was not dispatched with that organization.', null, 'COLLECTION_WRONG_COURIER');
    }
    const balance = Math.max(order.total - order.amount_paid, 0);
    if (amount > balance) {
      throw new ApiError(422, `That is more than the ${balance} cents this order still owes.`, null, 'COLLECTION_EXCEEDS_BALANCE');
    }

    // The order counts as paid, but the money is the organization's to remit, not the shop's: so this
    // moves amount_paid and the status directly and writes NO payment_records row (those are cash the
    // shop actually received, and feed the till and bank reports).
    const newPaid = order.amount_paid + amount;
    db.prepare(`UPDATE orders SET amount_paid = ?, updated_at = datetime('now') WHERE id = ?`).run(newPaid, order.id);
    const toStatus = newPaid >= order.total ? 'dispatched_paid' : 'dispatched_partial';
    if (toStatus !== order.status) {
      ordersService.transitionTo(order.id, { ...order, amount_paid: newPaid }, toStatus, staffId, `Collected by organization ${courier.name}: ${amount}.`);
    }

    const date = collectedOn || localDate();
    const info = db.prepare(`
      INSERT INTO org_collections (store_id, courier_id, order_id, amount, collected_on, recorded_by) VALUES (?, ?, ?, ?, ?, ?)
    `).run(storeId, courierId, order.id, amount, date, staffId);
    const row = db.prepare('SELECT * FROM org_collections WHERE id = ?').get(info.lastInsertRowid);
    logStaffAction({ staffId, action: 'create', entityType: 'org_collection', entityId: row.id, after: row });
    return row;
  });
  return txn();
}

// ---------------------------------------------------------------- statements

function createStatement({ storeId, staffId, courierId, periodStart, periodEnd, collectionIds, chargeEntered, remitted, remittanceRef }) {
  if (!staffId) throw new ApiError(422, 'The person entering the statement is required.', null, 'STATEMENT_NO_ACTOR');
  for (const [label, v] of [['charge', chargeEntered], ['remitted amount', remitted]]) {
    if (!isCents(v) || v < 0) throw new ApiError(422, `The ${label} must be a whole, non-negative number of cents.`, null, 'STATEMENT_BAD_AMOUNT');
  }
  if (!isRealDate(periodStart || '') || !isRealDate(periodEnd || '') || periodEnd < periodStart) {
    throw new ApiError(422, 'The period needs a start and an end date (YYYY-MM-DD), end not before start.', null, 'STATEMENT_BAD_PERIOD');
  }
  if (!Array.isArray(collectionIds) || collectionIds.length === 0) {
    throw new ApiError(422, 'A statement lists the parcels the organization collected for.', null, 'STATEMENT_NO_PARCELS');
  }
  if (new Set(collectionIds).size !== collectionIds.length) throw new ApiError(422, 'A parcel was listed twice.', null, 'STATEMENT_DUPLICATE_PARCEL');
  const ref = remittanceRef ? String(remittanceRef).trim() || null : null;

  // BEGIN IMMEDIATE (better-sqlite3 .immediate) takes the write lock up front: statements for an
  // organization are serialized, so two cannot both list the same parcel or fee.
  const txn = db.transaction(() => {
    const org = getOrganization(courierId, storeId);
    if (org.kind !== 'organization') throw new ApiError(409, 'Statements are for organizations. Riders are paid by payout.', null, 'STATEMENT_NOT_AN_ORGANIZATION');

    const marks = collectionIds.map(() => '?').join(',');
    const cols = db.prepare(`
      SELECT k.*, EXISTS (SELECT 1 FROM org_statement_lines l WHERE l.collection_id = k.id) AS on_statement
        FROM org_collections k WHERE k.store_id = ? AND k.id IN (${marks}) ORDER BY k.collected_on, k.id
    `).all(storeId, ...collectionIds);
    if (cols.length !== collectionIds.length) throw new ApiError(404, 'One of the listed parcels does not exist.', null, 'COLLECTION_NOT_FOUND');
    for (const k of cols) {
      if (k.courier_id !== courierId) throw new ApiError(409, `Parcel ${k.order_id} was collected by a different organization.`, null, 'STATEMENT_WRONG_ORGANIZATION');
      if (k.on_statement) throw new ApiError(409, `Parcel ${k.order_id} is already on another statement.`, null, 'STATEMENT_PARCEL_ALREADY_LISTED');
      if (k.collected_on > periodEnd) throw new ApiError(422, `Parcel ${k.order_id} was collected after the statement period ended.`, null, 'STATEMENT_PARCEL_OUTSIDE_PERIOD');
    }
    const collections = cols.reduce((s, k) => s + k.amount, 0);

    // Our own record of what we owe this organization for exactly these parcels.
    const orderIds = [...new Set(cols.map((k) => k.order_id))];
    const feeMarks = orderIds.map(() => '?').join(',');
    const fees = db.prepare(`
      SELECT f.id, f.amount FROM package_fees f
       WHERE f.courier_id = ? AND f.amount > 0 AND f.order_id IN (${feeMarks})
         AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id)
       ORDER BY f.id
    `).all(courierId, ...orderIds);
    const feesTotal = fees.reduce((s, f) => s + f.amount, 0);

    const settled = remitted + feesTotal;
    if (settled <= 0) throw new ApiError(422, 'Nothing was remitted and no fees are owed on these parcels, so there is nothing to settle.', null, 'STATEMENT_NOTHING_SETTLED');
    if (settled > collections) {
      throw new ApiError(422, `The remittance (${remitted}) plus the fees owed on these parcels (${feesTotal}) is more than the ${collections} they collected.`, null, 'STATEMENT_EXCEEDS_COLLECTIONS');
    }

    let payoutId = null;
    if (feesTotal > 0) {
      payoutId = db.prepare(`INSERT INTO courier_payouts (store_id, courier_id, total, method, payment_ref, paid_by) VALUES (?, ?, ?, 'netted_on_remittance', ?, ?)`)
        .run(storeId, courierId, feesTotal, ref, staffId).lastInsertRowid;
      const addItem = db.prepare('INSERT INTO payout_items (payout_id, package_fee_id, amount) VALUES (?, ?, ?)');
      for (const f of fees) addItem.run(payoutId, f.id, f.amount);
    }

    const chargeVariance = chargeEntered - feesTotal;
    const cashVariance = collections - feesTotal - remitted;
    const statementId = db.prepare(`
      INSERT INTO org_statements (store_id, courier_id, period_start, period_end, collections, charge_entered, fees, remitted,
                                  charge_variance, cash_variance, remittance_ref, payout_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, courierId, periodStart, periodEnd, collections, chargeEntered, feesTotal, remitted, chargeVariance, cashVariance, ref, payoutId, staffId).lastInsertRowid;

    // What this statement actually secured (cash remitted + fees netted) is credited to its parcels
    // oldest-first, the same order ageing uses. A parcel is fully secure only when covered in full;
    // this is what commission is allowed to count.
    let toSecure = settled;
    const addLine = db.prepare('INSERT INTO org_statement_lines (statement_id, collection_id, secured) VALUES (?, ?, ?)');
    for (const k of cols) {
      const secured = Math.min(k.amount, toSecure);
      toSecure -= secured;
      addLine.run(statementId, k.id, secured);
    }

    const row = db.prepare('SELECT * FROM org_statements WHERE id = ?').get(statementId);
    logStaffAction({ staffId, action: 'create', entityType: 'org_statement', entityId: statementId, after: row });
    return row;
  });
  return txn.immediate();
}

// ---------------------------------------------------------------- standing and ageing

// What an organization holds and has not remitted, aged. Remittances settle the oldest collections
// first, so what is still outstanding is made up of the newest ones: walk back from the newest until
// the outstanding amount is used up.
function organizationStanding({ storeId, courierId, now = new Date() }) {
  const org = db.prepare(`SELECT * FROM couriers WHERE id = ? AND store_id = ? AND kind = 'organization'`).get(courierId, storeId);
  if (!org) throw new ApiError(404, 'Organization not found.', null, 'COURIER_NOT_FOUND');

  const collected = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM org_collections WHERE courier_id = ?').get(courierId).n;
  const secured = db.prepare('SELECT COALESCE(SUM(remitted + fees), 0) AS n FROM org_statements WHERE courier_id = ?').get(courierId).n;
  const outstanding = Math.max(collected - secured, 0);

  const buckets = { '0-7': 0, '8-14': 0, '15-30': 0, '30+': 0 };
  let overdue = 0;
  if (outstanding > 0) {
    const cols = db.prepare('SELECT amount, collected_on FROM org_collections WHERE courier_id = ? ORDER BY collected_on DESC, id DESC').all(courierId);
    // Collection dates are the shop's dates, so "today" must be too (UTC would make a balance look
    // a day younger between 21:00 and midnight).
    const today = Date.parse(`${localDate(0, now)}T00:00:00Z`);
    let remaining = outstanding;
    for (const k of cols) {
      if (remaining <= 0) break;
      const portion = Math.min(remaining, k.amount);
      remaining -= portion;
      const age = Math.max(0, Math.floor((today - Date.parse(`${k.collected_on}T00:00:00Z`)) / DAY_MS));
      buckets[bucketFor(age)] += portion;
      if (age > org.overdue_after_days) overdue += portion;
    }
  }
  const limit = org.overdue_limit;
  return {
    courierId, outstanding,
    buckets: BUCKETS.map((label) => ({ label, cents: buckets[label] })),
    overdue, limit,
    // An overdue balance above the limit pauses new collect-on-delivery parcels to this organization.
    paused: !!org.collects_payment && limit !== null && limit !== undefined && overdue > limit,
  };
}

// Collections not yet on a statement: what staff pick from when entering one.
function listOpenCollections({ storeId, courierId }) {
  getOrganization(courierId, storeId);
  return db.prepare(`
    SELECT k.*, o.product_code FROM org_collections k JOIN orders o ON o.id = k.order_id
     WHERE k.store_id = ? AND k.courier_id = ? AND NOT EXISTS (SELECT 1 FROM org_statement_lines l WHERE l.collection_id = k.id)
     ORDER BY k.collected_on, k.id
  `).all(storeId, courierId);
}

function listStatements({ storeId, courierId }) {
  getOrganization(courierId, storeId);
  return db.prepare('SELECT * FROM org_statements WHERE store_id = ? AND courier_id = ? ORDER BY id DESC').all(storeId, courierId);
}

module.exports = { recordPackageFeeAtDispatch, recordCollection, createStatement, organizationStanding, listOpenCollections, listStatements };
