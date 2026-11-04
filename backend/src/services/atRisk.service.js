const db = require('../config/db');
const courierPayables = require('./courierPayables.service');
const courierOrganizations = require('./courierOrganizations.service');
const deliverySettlement = require('./deliverySettlement.service');

// "Money at risk": every place where money or goods could be going missing, with its age and whose
// it is. This is the data behind the manager's daily page (GET /api/orders/at-risk).
//
// Ported from the update branch's server/src/orders/atRisk.ts. That version reads a double-entry
// ledger and delivery_attempts; this one reads the SQLite tables that exist today, so the kinds
// below are the eight that can be built from them. The ninth (till variance unsigned) needs data this
// schema does not hold yet: see the note at the bottom of this file.
//
// "Delivered" is the one concept that does not carry over. This app has no delivered event: a
// parcel is dispatched_unpaid / dispatched_partial / dispatched_paid, and money arriving is the
// only outcome it records. So an outcome is read from the payments:
//   dispatched_unpaid  nothing paid, not on its way back          -> dispatched_no_outcome
//   dispatched_partial the customer has paid part and still owes  -> delivered_unpaid
// If a real delivered/failed marker is added to orders later, those two queries are where it plugs in.

const KINDS = ['dispatched_no_outcome', 'delivered_unpaid', 'unmatched_payment', 'returning', 'till_session_left_open', 'cash_not_deposited',
  'courier_unpaid', 'organization_overdue', 'delivery_fee_unverified', 'delivery_cost_pending', 'delivery_settlement_open'];

const DEFAULTS = {
  dispatchedNoOutcomeDays: 3, // dispatched, nothing paid, nothing heard, for this long
  deliveredUnpaidDays: 2,     // part paid and the balance is still owed, this long after the last payment
  returningDays: 3,           // on its way back to the shop for this long
  sessionOpenHours: 20,       // a till session should have been closed out by now
  cashHeldDays: 2,            // shop cash still in a staff member's hands (custody) for this long
  courierUnpaidDays: 7,       // a rider's oldest unpaid fee or approved cost has been waiting this long
  feeUnverifiedDays: 1,       // a delivery fee payment nobody has confirmed as real money (cash deposited, M-Pesa seen)
  costPendingDays: 1,         // an extra delivery cost or correction waiting for an approver
  settlementOpenDays: 14,     // a delivery nobody has confirmed as delivered (or returned) and closed
};

const DAY_MS = 86_400_000;

// Every timestamp in the database is UTC text, "YYYY-MM-DD HH:MM:SS", so cut-offs are built in the
// same shape and compared as text.
const toSql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const fromSql = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);

function moneyAtRisk({ storeId, now = new Date(), ...overrides }) {
  const t = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(overrides[k]) && overrides[k] >= 0) t[k] = overrides[k];

  const cutoffDays = (days) => toSql(new Date(now.getTime() - days * DAY_MS));
  const cutoffHours = (hours) => toSql(new Date(now.getTime() - hours * 3_600_000));
  const ref = (o) => o.product_code || `#${o.id}`;
  const items = [];

  // Dispatched, nothing paid, no return recorded. The staff member on the order is the owner; the
  // courier carrying it goes in the detail.
  const stuck = db.prepare(`
    SELECT o.id, o.product_code, o.total - o.amount_paid AS amount,
           COALESCE(o.dispatched_at, o.updated_at) AS since, u.name AS staff, c.name AS courier
      FROM orders o
      LEFT JOIN users u ON u.id = o.assigned_staff_id
      LEFT JOIN couriers c ON c.id = o.courier_id
     WHERE o.store_id = ? AND o.deleted_at IS NULL AND o.status = 'dispatched_unpaid'
       AND COALESCE(o.dispatched_at, o.updated_at) < ?`).all(storeId, cutoffDays(t.dispatchedNoOutcomeDays));
  for (const o of stuck) {
    items.push({
      kind: 'dispatched_no_outcome', order_id: o.id, order_ref: ref(o), amount: o.amount, since: o.since,
      owner: o.staff || o.courier || null,
      detail: `Dispatched with no payment or return recorded${o.courier ? ` (courier: ${o.courier})` : ''}`,
    });
  }

  // Part paid and the balance is still owed. Ages from the last payment that actually landed.
  const partial = db.prepare(`
    SELECT o.id, o.product_code, o.total - o.amount_paid AS amount,
           COALESCE((SELECT MAX(p.created_at) FROM payment_records p
                      WHERE p.order_id = o.id AND p.direction = 'incoming' AND p.status = 'completed' AND p.deleted_at IS NULL),
                    o.dispatched_at, o.updated_at) AS since,
           u.name AS staff, c.name AS courier
      FROM orders o
      LEFT JOIN users u ON u.id = o.assigned_staff_id
      LEFT JOIN couriers c ON c.id = o.courier_id
     WHERE o.store_id = ? AND o.deleted_at IS NULL AND o.status = 'dispatched_partial' AND o.total > o.amount_paid`).all(storeId);
  const partialCutoff = cutoffDays(t.deliveredUnpaidDays);
  for (const o of partial) {
    if (o.since >= partialCutoff) continue;
    items.push({
      kind: 'delivered_unpaid', order_id: o.id, order_ref: ref(o), amount: o.amount, since: o.since,
      owner: o.staff || o.courier || null,
      detail: `Part paid, balance still owed${o.courier ? ` (courier: ${o.courier})` : ''}`,
    });
  }

  // Money that arrived and matched no order. Not aged out: it is flagged from the moment it lands,
  // and drops off only when someone matches or ignores it on the reconciliation page.
  const unmatched = db.prepare(`
    SELECT id, source, amount, payer_name, external_reference, created_at AS since
      FROM payment_notifications
     WHERE store_id = ? AND direction = 'incoming' AND status = 'unmatched'`).all(storeId);
  for (const p of unmatched) {
    items.push({
      kind: 'unmatched_payment', order_id: null, order_ref: null, amount: p.amount, since: p.since, owner: null,
      detail: `${String(p.source).toUpperCase()} payment${p.external_reference ? ` ${p.external_reference}` : ''}${p.payer_name ? ` from ${p.payer_name}` : ''} matched no order`,
    });
  }

  // A parcel on its way back. The amount is the value of the goods in it.
  const returning = db.prepare(`
    SELECT o.id, o.product_code, o.total AS amount, COALESCE(o.returned_at, o.updated_at) AS since,
           u.name AS staff, c.name AS courier
      FROM orders o
      LEFT JOIN users u ON u.id = o.assigned_staff_id
      LEFT JOIN couriers c ON c.id = o.courier_id
     WHERE o.store_id = ? AND o.deleted_at IS NULL AND o.status = 'returned_in_transit'
       AND COALESCE(o.returned_at, o.updated_at) < ?`).all(storeId, cutoffDays(t.returningDays));
  for (const o of returning) {
    items.push({
      kind: 'returning', order_id: o.id, order_ref: ref(o), amount: o.amount, since: o.since,
      owner: o.staff || o.courier || null,
      detail: `Coming back from a failed delivery${o.courier ? ` (courier: ${o.courier})` : ''}`,
    });
  }

  // A till session nobody closed out.
  const open = db.prepare(`
    SELECT s.id, s.opened_at AS since, u.name AS cashier
      FROM cash_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.store_id = ? AND s.closed_at IS NULL AND s.opened_at < ?`).all(storeId, cutoffHours(t.sessionOpenHours));
  for (const s of open) {
    items.push({
      kind: 'till_session_left_open', order_id: null, order_ref: null, amount: 0, since: s.since, owner: s.cashier,
      detail: `Till session ${s.id} has been open since ${s.since.slice(0, 16)} UTC and has not been closed out`,
    });
  }

  // Shop cash still in someone's hands: a custody record that has stayed open. The holder is the owner.
  const held = db.prepare(`
    SELECT c.id, c.order_id, o.product_code, c.amount, c.opened_at AS since, u.name AS holder
      FROM custody_records c
      JOIN users u ON u.id = c.holder_staff_id
      JOIN orders o ON o.id = c.order_id
     WHERE c.store_id = ? AND c.status = 'open' AND c.opened_at < ?`).all(storeId, cutoffDays(t.cashHeldDays));
  for (const k of held) {
    items.push({
      kind: 'cash_not_deposited', order_id: k.order_id, order_ref: ref(k), amount: k.amount, since: k.since, owner: k.holder,
      detail: `Shop cash held by ${k.holder}, not yet deposited`,
    });
  }

  // Money we owe a rider and have not paid: one line per courier, aged by their OLDEST unpaid item. Package fees are owed
  // whether or not the customer collected, and only approved costs count (pending and rejected ones are not owed).
  const unpaidCutoff = cutoffDays(t.courierUnpaidDays);
  for (const c of db.prepare(`SELECT id, name FROM couriers WHERE store_id = ? AND kind = 'rider' ORDER BY name`).all(storeId)) {
    const owed = courierPayables.unpaidItems(c.id); // oldest first
    if (owed.length === 0 || owed[0].since >= unpaidCutoff) continue;
    items.push({
      kind: 'courier_unpaid', order_id: null, order_ref: null, amount: owed.reduce((n, i) => n + i.amount, 0), since: owed[0].since, owner: null,
      detail: `We owe ${c.name} for ${owed.length} unpaid item${owed.length === 1 ? '' : 's'}`,
    });
  }

  // A courier organization holding customer money past its overdue limit. Aged from its oldest collection; the detail says
  // when it is also paused for new collect-on-delivery parcels.
  for (const o of db.prepare(`SELECT id, name FROM couriers WHERE store_id = ? AND kind = 'organization' AND collects_payment = 1 ORDER BY name`).all(storeId)) {
    const standing = courierOrganizations.organizationStanding({ storeId, courierId: o.id, now });
    if (standing.overdue <= 0) continue;
    const oldest = db.prepare('SELECT MIN(collected_on) AS d FROM org_collections WHERE courier_id = ?').get(o.id).d;
    items.push({
      kind: 'organization_overdue', order_id: null, order_ref: null, amount: standing.overdue, since: `${oldest} 00:00:00`, owner: null,
      detail: `${o.name} holds overdue money${standing.paused ? ' and is paused for new collect-on-delivery parcels' : ''}`,
    });
  }

  // Delivery fee payments recorded but not confirmed as real money: cash not yet deposited, or a mobile/bank payment no incoming
  // notification or statement line has backed. Flagged from the day the cut-off passes, owned by whoever entered it.
  for (const r of db.prepare(`
    SELECT r.id, r.order_id, r.amount, r.method, r.reference, r.recorded_at AS since, o.product_code, u.name AS staff
      FROM delivery_fee_receipts r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = r.recorded_by
     WHERE r.store_id = ? AND r.recorded_at < ? AND NOT EXISTS (SELECT 1 FROM delivery_fee_verifications v WHERE v.receipt_id = r.id)`)
    .all(storeId, cutoffDays(t.feeUnverifiedDays))) {
    items.push({
      kind: 'delivery_fee_unverified', order_id: r.order_id, order_ref: ref({ id: r.order_id, product_code: r.product_code }), amount: r.amount, since: r.since, owner: r.staff,
      detail: r.method === 'cash' ? 'Delivery fee taken in cash, not confirmed as deposited' : `Delivery fee paid by ${r.method.replace('_', ' ')}${r.reference ? ` (${r.reference})` : ''}, no matching payment seen`,
    });
  }

  // Extra delivery costs and corrections waiting for an approver.
  const pendingSince = cutoffDays(t.costPendingDays);
  for (const c of db.prepare(`
    SELECT c.id, c.order_id, c.amount AS amount, c.created_at AS since, o.product_code, u.name AS staff, 'cost' AS what
      FROM delivery_costs c JOIN orders o ON o.id = c.order_id JOIN users u ON u.id = c.recorded_by
     WHERE c.store_id = ? AND c.status = 'pending' AND c.created_at < ?
    UNION ALL
    SELECT a.id, a.order_id, ABS(a.delta), a.created_at, o.product_code, u.name, 'correction'
      FROM delivery_adjustments a JOIN orders o ON o.id = a.order_id JOIN users u ON u.id = a.recorded_by
     WHERE a.store_id = ? AND a.status = 'pending' AND a.created_at < ?`).all(storeId, pendingSince, storeId, pendingSince)) {
    items.push({
      kind: 'delivery_cost_pending', order_id: c.order_id, order_ref: ref({ id: c.order_id, product_code: c.product_code }), amount: c.amount, since: c.since, owner: c.staff,
      detail: `Delivery ${c.what} waiting for an administrator or manager to approve`,
    });
  }

  // A delivery nobody has confirmed. Only settlements that exist and are open (dispatches before settlements existed have no
  // row until someone looks at them). The amount is the cost so far, which the shop is carrying until it is closed.
  for (const o of db.prepare(`
    SELECT o.id, o.product_code, o.dispatched_at AS since, u.name AS staff, c.name AS courier
      FROM delivery_settlements d
      JOIN orders o ON o.id = d.order_id
      LEFT JOIN users u ON u.id = o.assigned_staff_id
      LEFT JOIN couriers c ON c.id = o.courier_id
     WHERE d.store_id = ? AND d.status = 'open' AND o.deleted_at IS NULL AND o.dispatched_at IS NOT NULL AND o.dispatched_at < ?`)
    .all(storeId, cutoffDays(t.settlementOpenDays))) {
    const f = deliverySettlement.getFigures(o.id);
    items.push({
      kind: 'delivery_settlement_open', order_id: o.id, order_ref: ref(o), amount: Math.max(0, f.costs_total), since: o.since, owner: o.staff || o.courier || null,
      detail: 'Delivery not yet confirmed and its earnings and costs not closed',
    });
  }

  return items
    .map((i) => ({ ...i, age_days: Math.max(0, Math.floor((now.getTime() - fromSql(i.since).getTime()) / DAY_MS)) }))
    .sort((a, b) => b.age_days - a.age_days || b.amount - a.amount);
}

// Totals per kind, for the tiles at the top of the page.
function summarize(items) {
  const byKind = {};
  for (const k of KINDS) byKind[k] = { count: 0, amount: 0 };
  let amount = 0;
  for (const i of items) {
    byKind[i.kind].count += 1;
    byKind[i.kind].amount += i.amount;
    amount += i.amount;
  }
  return { count: items.length, amount, by_kind: byKind };
}

// NOT BUILT YET, and what it needs:
//   till_variance_unsigned  a manager sign-off on cash_sessions (a signoff_required flag and who/when signed),
//                           plus a rule for how big a closing difference must be before it needs one.
// It is one more query in moneyAtRisk and one more entry in KINDS once that exists.

module.exports = { moneyAtRisk, summarize, KINDS, DEFAULTS };
