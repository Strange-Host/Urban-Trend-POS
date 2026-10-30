'use strict';

const defaultDb = require('../config/db');
const { securedOrders } = require('../services/commission.service');
const { verifyRun } = require('../services/payrollRuns.service');
const { findOrderLineMismatches } = require('../services/reconciliation.service');

// The integrity checks. Ported from the update branch's integrity/checks.ts.
//
// The database already refuses to break these rules; this proves it by looking at the data itself, and catches the case
// where the guards were bypassed (a restored backup, a hand-run script, a dropped trigger).
//
// The update branch checks twelve rules. Those that compare a record against the double-entry ledger cannot be ported,
// because this SQLite version has no ledger, so they are reported as not applicable instead of being silently skipped:
//   1 entries balance, 3 unreferenced money sits in suspense, 4 courier payable matches the ledger, 5 organization
//   receivable matches the ledger.
// Checked here:
//   2  an order's paid amount is derived from its payments, never a free-standing counter
//   6  payments never exceed what is owed
//   7  protection triggers are in place
//   8  commission only on secure money
//   9  a locked payroll run never changes
//   10 order references are unique and well formed
//   11 every dispatch to a courier organization has a package fee line
//   12 package fees and courier costs are never combined
// plus one supporting check: an order's lines add up to its subtotal.
// All amounts are integer cents.

const MAX_REPORTED_PER_CHECK = 50; // a systemic problem should not produce a million-row alert

const NOT_APPLICABLE = [
  { rule: 1, reason: 'needs the double-entry ledger, which the SQLite version does not have' },
  { rule: 3, reason: 'needs the ledger: there is no suspense account here (unmatched money is held in payment_notifications)' },
  { rule: 4, reason: 'needs the ledger: there is no second record of what a rider is owed to compare against' },
  { rule: 5, reason: 'needs the ledger: there is no second record of what an organization holds to compare against' },
];

// Every trigger that guards a rule. SQLite cannot disable a trigger, only drop it, so "in place" means "exists".
const GUARD_TRIGGERS = [
  { table: 'org_collections', trigger: 'org_collections_no_update', rule: 7 },
  { table: 'org_collections', trigger: 'org_collections_no_delete', rule: 7 },
  { table: 'org_statements', trigger: 'org_statements_no_update', rule: 7 },
  { table: 'org_statements', trigger: 'org_statements_no_delete', rule: 7 },
  { table: 'custody_records', trigger: 'custody_closed_never_changes', rule: 7 },
  { table: 'custody_records', trigger: 'custody_fields_never_change', rule: 7 },
  { table: 'custody_records', trigger: 'custody_no_delete', rule: 7 },
  { table: 'inventory', trigger: 'trg_inventory_no_oversell', rule: 7 },
  { table: 'inventory', trigger: 'trg_inventory_no_negative_insert', rule: 7 },
  ...[
    'payroll_runs_no_delete', 'payroll_runs_paid_is_final', 'payroll_runs_approve_only', 'payroll_runs_pay_only', 'payroll_runs_locked_periods_dont_overlap',
  ].map((trigger) => ({ table: 'payroll_runs', trigger, rule: 9 })),
  ...['payroll_items_ins_locked', 'payroll_items_upd_locked', 'payroll_items_del_locked'].map((trigger) => ({ table: 'payroll_items', trigger, rule: 9 })),
  ...['payroll_item_lines_ins_locked', 'payroll_item_lines_upd_locked', 'payroll_item_lines_del_locked'].map((trigger) => ({ table: 'payroll_item_lines', trigger, rule: 9 })),
  ...['commissioned_orders_ins_locked', 'commissioned_orders_no_update', 'commissioned_orders_no_delete'].map((trigger) => ({ table: 'commissioned_orders', trigger, rule: 9 })),
];

const DISPATCHED = ['dispatched_unpaid', 'dispatched_partial', 'dispatched_paid',
  'returned_in_transit', 'returned_awaiting_inspection', 'returned_resellable', 'returned_damaged'];
const orderLabel = (o) => o.product_code || `#${o.id}`;
const limit = (rows) => rows.slice(0, MAX_REPORTED_PER_CHECK);

function guardsInPlace(db) {
  const present = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all().map((r) => r.name));
  return GUARD_TRIGGERS.filter((g) => !present.has(g.trigger)).map((g) => ({
    rule: g.rule, check: 'guard_present', message: `Protection trigger ${g.trigger} on ${g.table} is missing.`,
  }));
}

// RULE 2: what an order has been paid comes from its payments (and, for a parcel an organization collected, its collections).
function paidMatchesPayments(db) {
  const rows = db.prepare(`
    SELECT o.id, o.product_code, o.amount_paid,
           COALESCE((SELECT SUM(p.amount) FROM payment_records p WHERE p.order_id = o.id AND p.direction = 'incoming'
                        AND p.status = 'completed' AND p.deleted_at IS NULL), 0)
         + COALESCE((SELECT SUM(k.amount) FROM org_collections k WHERE k.order_id = o.id), 0) AS derived
      FROM orders o WHERE o.deleted_at IS NULL ORDER BY o.id`).all();
  return limit(rows.filter((r) => r.amount_paid !== r.derived)).map((r) => ({
    rule: 2, check: 'paid_matches_payments', ref: orderLabel(r),
    message: `Order ${orderLabel(r)} says ${r.amount_paid} cents have been paid but its payments and collections add up to ${r.derived}.`,
  }));
}

// RULE 6: an order is never paid more than it is worth, and never less than nothing.
function ordersNeverOverpaid(db) {
  const rows = db.prepare(`
    SELECT o.id, o.product_code, o.total, o.amount_paid,
           COALESCE((SELECT SUM(p.amount) FROM payment_records p WHERE p.order_id = o.id AND p.direction = 'incoming'
                        AND p.status = 'completed' AND p.deleted_at IS NULL), 0)
         + COALESCE((SELECT SUM(k.amount) FROM org_collections k WHERE k.order_id = o.id), 0) AS derived
      FROM orders o WHERE o.deleted_at IS NULL ORDER BY o.id`).all();
  return limit(rows.filter((r) => r.amount_paid > r.total || r.derived > r.total || r.amount_paid < 0)).map((r) => ({
    rule: 6, check: 'order_within_total', ref: orderLabel(r),
    message: `Order ${orderLabel(r)} has been paid ${Math.max(r.amount_paid, r.derived)} cents against a total of ${r.total}: it is overpaid or its paid amount went negative.`,
  }));
}

// RULE 10: references are unique (also ignoring case, since customers type them and payments are matched on them) and well formed.
function orderRefsValid(db) {
  const out = [];
  for (const r of limit(db.prepare(`SELECT id FROM orders WHERE product_code IS NULL OR trim(product_code) = '' ORDER BY id`).all())) {
    out.push({ rule: 10, check: 'ref_missing', ref: `#${r.id}`, message: `Order #${r.id} has no order reference.` });
  }
  for (const r of limit(db.prepare(`
      SELECT upper(trim(product_code)) AS ref, COUNT(*) AS n FROM orders WHERE product_code IS NOT NULL GROUP BY upper(trim(product_code)) HAVING COUNT(*) > 1 ORDER BY ref`).all())) {
    out.push({ rule: 10, check: 'ref_unique', ref: r.ref, message: `Order reference ${r.ref} is used by ${r.n} orders.` });
  }
  for (const r of limit(db.prepare(`SELECT id, product_code FROM orders WHERE product_code IS NOT NULL AND trim(product_code) <> '' ORDER BY id`).all()
    .filter((x) => !/^UT\d{6,}$/.test(x.product_code)))) {
    out.push({ rule: 10, check: 'ref_format', ref: r.product_code, message: `Order reference ${r.product_code} (order #${r.id}) is malformed: it should look like UT000123.` });
  }
  return limit(out);
}

// RULE 11: a parcel dispatched with a courier organization carries the package fee we owe it. (A rider's zero fee records nothing
// by design, so only organizations, whose fee is mandatory at dispatch, can be held to this.) A fee for a parcel never dispatched is also wrong.
function dispatchesHaveFees(db) {
  const marks = DISPATCHED.map(() => '?').join(',');
  const out = [];
  for (const o of db.prepare(`
      SELECT o.id, o.product_code FROM orders o JOIN couriers c ON c.id = o.courier_id
       WHERE c.kind = 'organization' AND o.deleted_at IS NULL AND o.status IN (${marks})
         AND NOT EXISTS (SELECT 1 FROM package_fees f WHERE f.order_id = o.id) ORDER BY o.id LIMIT ${MAX_REPORTED_PER_CHECK}`).all(...DISPATCHED)) {
    out.push({ rule: 11, check: 'dispatch_has_fee', ref: orderLabel(o), message: `Order ${orderLabel(o)} was dispatched with a courier organization but has no package fee line.` });
  }
  for (const o of db.prepare(`
      SELECT o.id, o.product_code, o.status FROM package_fees f JOIN orders o ON o.id = f.order_id
       WHERE o.status IN ('awaiting_dispatch', 'cancelled') ORDER BY o.id LIMIT ${MAX_REPORTED_PER_CHECK}`).all()) {
    out.push({ rule: 11, check: 'fee_without_dispatch', ref: orderLabel(o), message: `Order ${orderLabel(o)} has a package fee line but is ${o.status.replace(/_/g, ' ')}: it was never dispatched.` });
  }
  for (const o of db.prepare(`
      SELECT o.id, o.product_code FROM package_fees f JOIN orders o ON o.id = f.order_id
       WHERE o.courier_id IS NOT NULL AND o.courier_id <> f.courier_id ORDER BY o.id LIMIT ${MAX_REPORTED_PER_CHECK}`).all()) {
    out.push({ rule: 11, check: 'fee_courier_matches', ref: orderLabel(o), message: `Order ${orderLabel(o)}: its package fee is owed to a different courier from the one on the order.` });
  }
  return limit(out);
}

// RULE 12: fees and costs are never combined. Each payout line is exactly one package fee or one courier cost, matches its
// own record, and the payout's totals add up from its lines of each kind.
function feesAndCostsNeverCombined(db) {
  const out = [];
  for (const r of db.prepare(`SELECT id FROM rider_payout_items WHERE (package_fee_id IS NOT NULL) = (courier_cost_id IS NOT NULL) ORDER BY id LIMIT ${MAX_REPORTED_PER_CHECK}`).all()) {
    out.push({ rule: 12, check: 'payout_line_combined', message: `Payout line ${r.id} is not exactly one package fee or one courier cost.` });
  }
  for (const r of db.prepare(`
      SELECT i.id, i.amount, f.amount AS recorded FROM rider_payout_items i JOIN package_fees f ON f.id = i.package_fee_id WHERE i.amount <> f.amount ORDER BY i.id LIMIT ${MAX_REPORTED_PER_CHECK}`).all()) {
    out.push({ rule: 12, check: 'fee_line_matches', message: `Payout line ${r.id} paid ${r.amount} cents for a package fee recorded as ${r.recorded}.` });
  }
  for (const r of db.prepare(`
      SELECT i.id, i.amount, k.amount AS recorded FROM rider_payout_items i JOIN courier_costs k ON k.id = i.courier_cost_id WHERE i.amount <> k.amount ORDER BY i.id LIMIT ${MAX_REPORTED_PER_CHECK}`).all()) {
    out.push({ rule: 12, check: 'cost_line_matches', message: `Payout line ${r.id} paid ${r.amount} cents for a courier cost recorded as ${r.recorded}.` });
  }
  for (const r of db.prepare(`
      SELECT p.id, p.fees_total, p.costs_total, p.total,
             COALESCE((SELECT SUM(amount) FROM rider_payout_items WHERE payout_id = p.id AND package_fee_id IS NOT NULL), 0) AS fee_lines,
             COALESCE((SELECT SUM(amount) FROM rider_payout_items WHERE payout_id = p.id AND courier_cost_id IS NOT NULL), 0) AS cost_lines
        FROM rider_payouts p
       WHERE p.total <> p.fees_total + p.costs_total OR p.fees_total <> fee_lines OR p.costs_total <> cost_lines ORDER BY p.id LIMIT ${MAX_REPORTED_PER_CHECK}`).all()) {
    out.push({ rule: 12, check: 'payout_totals_match', message: `Payout ${r.id}: fees ${r.fees_total} and costs ${r.costs_total} do not add up to ${r.total}, or do not match its ${r.fee_lines} in fee lines and ${r.cost_lines} in cost lines.` });
  }
  for (const r of db.prepare(`
      SELECT i.id, i.amount, f.amount AS recorded FROM payout_items i JOIN package_fees f ON f.id = i.package_fee_id WHERE i.amount <> f.amount ORDER BY i.id LIMIT ${MAX_REPORTED_PER_CHECK}`).all()) {
    out.push({ rule: 12, check: 'netted_fee_matches', message: `Netted payout line ${r.id} settled ${r.amount} cents for a package fee recorded as ${r.recorded}.` });
  }
  return limit(out);
}

// RULE 9: a locked payroll run never changes. Its figures were fingerprinted when approved; recompute from what is stored now.
function lockedRunsUnchanged(db) {
  const out = [];
  for (const r of db.prepare(`SELECT id, store_id, period_start, period_end FROM payroll_runs WHERE status <> 'draft' ORDER BY id`).all()) {
    if (!verifyRun({ runId: r.id, storeId: r.store_id }).intact) {
      out.push({ rule: 9, check: 'locked_run_unchanged', message: `Payroll run ${r.id} (${r.period_start} to ${r.period_end}) is locked but its figures no longer match what was approved.` });
    }
  }
  return limit(out);
}

// RULE 8: commission only on secure money. Every order commissioned in a locked run must (still) be fully secure, and must
// have become secure no later than the end of that run's period.
function commissionOnSecureMoney(db) {
  const out = [];
  const rows = db.prepare(`
    SELECT c.order_id, o.product_code, c.run_id, r.period_end, r.store_id
      FROM commissioned_orders c JOIN payroll_runs r ON r.id = c.run_id JOIN orders o ON o.id = c.order_id ORDER BY c.order_id`).all();
  const secureByStore = new Map();
  for (const r of rows) {
    if (!secureByStore.has(r.store_id)) {
      secureByStore.set(r.store_id, new Map(securedOrders({ storeId: r.store_id, excludeCommissioned: false }).map((o) => [o.orderId, o])));
    }
    const s = secureByStore.get(r.store_id).get(r.order_id);
    const ref = r.product_code || `#${r.order_id}`;
    if (!s) out.push({ rule: 8, check: 'commission_secure', ref, message: `Order ${ref} earned commission in payroll run ${r.run_id} but its money is not fully secure.` });
    else if (s.securedDate > r.period_end) out.push({ rule: 8, check: 'commission_secure_in_period', ref, message: `Order ${ref} earned commission in payroll run ${r.run_id} before its money was secure.` });
  }
  // Each commission line in a locked run must match a commissioned_orders row.
  for (const u of db.prepare(`
      SELECT l.ref_text AS ref, i.run_id FROM payroll_item_lines l JOIN payroll_items i ON i.id = l.item_id JOIN payroll_runs r ON r.id = i.run_id
       WHERE l.kind = 'commission_order' AND r.status <> 'draft'
         AND NOT EXISTS (SELECT 1 FROM commissioned_orders c JOIN orders o ON o.id = c.order_id
                          WHERE c.run_id = i.run_id AND COALESCE(o.product_code, '#' || o.id) = l.ref_text)`).all()) {
    out.push({ rule: 8, check: 'commission_line_recorded', ref: u.ref, message: `Commission for order ${u.ref} in payroll run ${u.run_id} is not recorded as commissioned.` });
  }
  // A statement secures exactly what it settled (remitted + fees netted), up to what its parcels were worth.
  for (const r of db.prepare(`
      SELECT s.id, s.remitted + s.fees AS settled, COALESCE(SUM(l.secured), 0) AS secured, COALESCE(SUM(k.amount), 0) AS worth
        FROM org_statements s LEFT JOIN org_statement_lines l ON l.statement_id = s.id LEFT JOIN org_collections k ON k.id = l.collection_id
       GROUP BY s.id HAVING COALESCE(SUM(l.secured), 0) <> MIN(s.remitted + s.fees, COALESCE(SUM(k.amount), 0)) ORDER BY s.id`).all()) {
    out.push({ rule: 8, check: 'statement_secured_adds_up', message: `Organization statement ${r.id} secured ${r.secured} cents across its parcels but settled ${r.settled} against parcels worth ${r.worth}.` });
  }
  return limit(out);
}

// Supporting check: an order's lines add up to its subtotal and its total to subtotal less discount (see reconciliation.service).
function orderLinesMatchSubtotal(db) {
  return limit(findOrderLineMismatches({}).map((r) => ({
    rule: null, check: 'order_lines_match_subtotal', ref: r.product_code || `#${r.order_id}`,
    message: `Order ${r.product_code || `#${r.order_id}`}: ${r.problems.join(', ').replace(/_/g, ' ')} (lines ${r.lines_total}, subtotal ${r.subtotal}, total ${r.total}, expected ${r.expected_total}).`,
  })));
}

/** Runs every check once, reading one consistent snapshot, and returns the report. Detect-only: it never changes data. */
function runIntegrityChecks(db = defaultDb) {
  const started = Date.now();
  const snapshot = db.transaction(() => {
    const violations = [
      ...guardsInPlace(db),
      ...orderRefsValid(db),
      ...paidMatchesPayments(db),
      ...ordersNeverOverpaid(db),
      ...orderLinesMatchSubtotal(db),
      ...dispatchesHaveFees(db),
      ...feesAndCostsNeverCombined(db),
      ...lockedRunsUnchanged(db),
      ...commissionOnSecureMoney(db),
    ];
    const n = (sql) => db.prepare(sql).get().n;
    const counts = {
      orders: n('SELECT COUNT(*) AS n FROM orders'), payments: n('SELECT COUNT(*) AS n FROM payment_records'),
      couriers: n('SELECT COUNT(*) AS n FROM couriers'), packageFees: n('SELECT COUNT(*) AS n FROM package_fees'),
      payrollRuns: n(`SELECT COUNT(*) AS n FROM payroll_runs WHERE status <> 'draft'`), commissionedOrders: n('SELECT COUNT(*) AS n FROM commissioned_orders'),
    };
    return { violations, counts };
  });
  const { violations, counts } = snapshot();
  return { ok: violations.length === 0, checkedAt: new Date().toISOString(), durationMs: Date.now() - started, counts, violations, notApplicable: NOT_APPLICABLE };
}

module.exports = { runIntegrityChecks, GUARD_TRIGGERS, NOT_APPLICABLE, MAX_REPORTED_PER_CHECK };
