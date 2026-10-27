import type { Queryable } from '../db/tx.js';
import { isValidRef } from '../ledger/orderRef.js';
import { securedOrders } from '../payroll/commission.js';
import { expectedByMethod, METHOD_ACCOUNT, METHODS } from '../pos/sessions.js';
import { runFingerprint } from '../payroll/runs.js';
import { shopDayEnd } from '../payroll/time.js';

// The nightly integrity job. The database already refuses to break these rules; this job proves it by looking at
// the data itself, and catches the case where the guards were switched off or bypassed (a restored backup, a hand-run
// script, a disabled trigger).
//
// Rules checked so far: 1 (entries balance), 2 (paid amount comes from payments, never a counter), 3 (money without an
// order reference sits in suspense), 4 (a courier's payable is what is earned and unpaid), 5 (an organization's
// receivable is what it collected and has not remitted), 6 (payments never exceed what is owed), 7 (records immutable),
// 10 (order references unique, immutable), 11 (every dispatch has a package fee line), 12 (fees and costs never
// combined), 8 (commission only on secure money) and 9 (a locked payroll run never changes). That is all twelve.

export interface Violation {
  rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | null; // the rule number in the plan; null for supporting checks
  check: string;
  message: string;
  ref?: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: Date;
  durationMs: number;
  counts: { entries: number; lines: number; orderRefs: number; receipts: number; orders: number; payments: number; couriers: number; sales: number };
  violations: Violation[];
}

const GUARD_TRIGGERS: { table: string; trigger: string }[] = [
  { table: 'journal_entries', trigger: 'journal_entries_immutable' },
  { table: 'journal_entries', trigger: 'journal_entries_no_truncate' },
  { table: 'journal_entries', trigger: 'journal_entries_balanced' },
  { table: 'journal_lines', trigger: 'journal_lines_immutable' },
  { table: 'journal_lines', trigger: 'journal_lines_no_truncate' },
  { table: 'journal_lines', trigger: 'journal_lines_balanced' },
  { table: 'journal_lines', trigger: 'journal_lines_same_tx' },
  { table: 'order_refs', trigger: 'order_refs_immutable' },
  { table: 'order_refs', trigger: 'order_refs_no_truncate' },
  { table: 'payment_receipts', trigger: 'payment_receipts_immutable' },
  { table: 'payment_receipts', trigger: 'payment_receipts_no_truncate' },
  { table: 'payment_receipts', trigger: 'receipts_match_entry' },
  { table: 'orders', trigger: 'orders_guard' },
  { table: 'orders', trigger: 'orders_no_truncate' },
  { table: 'order_items', trigger: 'order_items_immutable' },
  { table: 'order_events', trigger: 'order_events_immutable' },
  { table: 'delivery_attempts', trigger: 'delivery_attempts_immutable' },
  { table: 'paybill_payments', trigger: 'paybill_payments_immutable' },
  { table: 'payment_exceptions', trigger: 'payment_exceptions_immutable' },
  { table: 'exception_resolutions', trigger: 'exception_resolutions_immutable' },
  { table: 'couriers', trigger: 'couriers_guard' },
  { table: 'orders', trigger: 'orders_dispatch_needs_fee' },
  { table: 'package_fees', trigger: 'package_fees_immutable' },
  { table: 'courier_costs', trigger: 'courier_costs_guard' },
  { table: 'courier_payouts', trigger: 'courier_payouts_immutable' },
  { table: 'payout_items', trigger: 'payout_items_immutable' },
  { table: 'org_collections', trigger: 'org_collections_immutable' },
  { table: 'org_statements', trigger: 'org_statements_immutable' },
  { table: 'org_statement_lines', trigger: 'org_statement_lines_immutable' },
  { table: 'custody_records', trigger: 'custody_guard' },
  { table: 'commission_plans', trigger: 'commission_plans_immutable' },
  { table: 'pay_profiles', trigger: 'pay_profiles_immutable' },
  { table: 'attendance_records', trigger: 'attendance_guard' },
  { table: 'payroll_adjustments', trigger: 'payroll_adjustments_immutable' },
  { table: 'payroll_runs', trigger: 'payroll_runs_guard' },
  { table: 'payroll_items', trigger: 'payroll_items_locked' },
  { table: 'payroll_item_lines', trigger: 'payroll_item_lines_locked' },
  { table: 'commissioned_orders', trigger: 'commissioned_orders_locked' },
  { table: 'commissioned_orders', trigger: 'commissioned_orders_immutable' },
  { table: 'audit_log', trigger: 'audit_log_immutable' },
  { table: 'discount_policies', trigger: 'discount_policies_immutable' },
  { table: 'cash_sessions', trigger: 'cash_sessions_guard' },
  { table: 'cash_session_counts', trigger: 'cash_session_counts_immutable' },
  { table: 'cash_movements', trigger: 'cash_movements_immutable' },
  { table: 'sales', trigger: 'sales_guard' },
  { table: 'sales', trigger: 'sale_payments_match_total' },
  { table: 'sale_items', trigger: 'sale_items_immutable' },
  { table: 'sale_payments', trigger: 'sale_payments_immutable' },
  { table: 'discount_approvals', trigger: 'discount_approvals_immutable' },
  { table: 'sale_refunds', trigger: 'sale_refunds_immutable' },
  { table: 'sale_refund_items', trigger: 'sale_refund_items_immutable' },
  { table: 'sale_refund_items', trigger: 'sale_refund_items_within_sold' },
  { table: 'products', trigger: 'products_protect_update' },
  { table: 'stock_movements', trigger: 'stock_movements_immutable' },
  { table: 'stock_movements', trigger: 'stock_movements_not_negative' },
  { table: 'customers', trigger: 'customers_protect_update' },
  { table: 'lead_messages', trigger: 'lead_messages_immutable' },
  { table: 'order_returns', trigger: 'order_returns_immutable' },
  { table: 'order_return_items', trigger: 'order_return_items_immutable' },
  { table: 'alerts', trigger: 'alerts_guard' },
];

const guardRule = (trigger: string): 1 | 7 | 9 | 10 | 11 =>
  trigger.includes('balanced') ? 1 : trigger.startsWith('order_refs') ? 10 : trigger === 'orders_dispatch_needs_fee' ? 11
  : trigger.startsWith('payroll_runs') || trigger.startsWith('payroll_items') || trigger.startsWith('payroll_item_lines') || trigger.startsWith('commissioned_orders') ? 9 : 7;

const MAX_REPORTED_PER_CHECK = 50; // a systemic problem should not produce a million-row alert

async function entriesBalance(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number; total: number; n: number }>(
    `SELECT e.id, COALESCE(sum(l.amount_cents), 0)::bigint AS total, count(l.id)::bigint AS n
       FROM journal_entries e LEFT JOIN journal_lines l ON l.entry_id = e.id
      GROUP BY e.id
     HAVING COALESCE(sum(l.amount_cents), 0) <> 0 OR count(l.id) < 2
      ORDER BY e.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({
    rule: 1 as const, check: 'entry_balances',
    message: r.n < 2 ? `Journal entry ${r.id} has ${r.n} line(s); every entry needs at least two.`
                     : `Journal entry ${r.id} does not balance: its lines sum to ${r.total} cents.`,
  }));
}

async function ledgerTotalsZero(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ t: number }>(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS t FROM journal_lines`);
  return rows[0]!.t === 0 ? [] : [{ rule: 1, check: 'trial_balance', message: `The ledger as a whole sums to ${rows[0]!.t} cents instead of 0.` }];
}

async function reversalsAreExact(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number; orig: number }>(
    `SELECT r.id, r.reverses_entry_id AS orig
       FROM journal_entries r
      WHERE r.reverses_entry_id IS NOT NULL
        AND ( (SELECT COALESCE(jsonb_agg(jsonb_build_array(account_id, amount_cents) ORDER BY account_id, amount_cents), '[]')
                 FROM journal_lines WHERE entry_id = r.id)
              <> (SELECT COALESCE(jsonb_agg(jsonb_build_array(account_id, -amount_cents) ORDER BY account_id, -amount_cents), '[]')
                 FROM journal_lines WHERE entry_id = r.reverses_entry_id)
           OR r.order_ref IS DISTINCT FROM (SELECT order_ref FROM journal_entries WHERE id = r.reverses_entry_id) )
      ORDER BY r.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({
    rule: 7 as const, check: 'reversal_exact',
    message: `Entry ${r.id} claims to reverse entry ${r.orig} but does not exactly negate it.`,
  }));
}

async function guardsInPlace(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ table: string; trigger: string; enabled: string }>(
    `SELECT c.relname AS "table", t.tgname AS trigger, t.tgenabled AS enabled
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname = ANY($1)`, [[...new Set(GUARD_TRIGGERS.map((g) => g.table))]]);
  const state = new Map(rows.map((r) => [`${r.table}.${r.trigger}`, r.enabled]));
  const out: Violation[] = [];
  for (const g of GUARD_TRIGGERS) {
    const enabled = state.get(`${g.table}.${g.trigger}`);
    if (enabled === undefined) out.push({ rule: guardRule(g.trigger), check: 'guard_present', message: `Protection trigger ${g.trigger} on ${g.table} is missing.` });
    else if (enabled === 'D') out.push({ rule: guardRule(g.trigger), check: 'guard_enabled', message: `Protection trigger ${g.trigger} on ${g.table} is DISABLED.` });
  }
  return out;
}

async function orderRefsValid(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  let after = '';
  for (;;) {
    const { rows } = await db.query<{ ref: string; legacy_ref: string | null }>(
      `SELECT ref, legacy_ref FROM order_refs WHERE ref > $1 ORDER BY ref LIMIT 5000`, [after]);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (!isValidRef(r.ref)) out.push({ rule: 10, check: 'ref_format', ref: r.ref, message: `Order reference ${r.ref} is malformed or fails its check character.` });
      if (r.legacy_ref !== null && !/^UT[0-9]{6,}$/.test(r.legacy_ref)) out.push({ rule: 10, check: 'legacy_format', ref: r.ref, message: `Legacy alias ${r.legacy_ref} on ${r.ref} is malformed.` });
    }
    after = rows[rows.length - 1]!.ref;
    if (out.length >= MAX_REPORTED_PER_CHECK) break;
  }
  return out.slice(0, MAX_REPORTED_PER_CHECK);
}

async function entryRefsExist(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number; order_ref: string }>(
    `SELECT e.id, e.order_ref FROM journal_entries e LEFT JOIN order_refs o ON o.ref = e.order_ref
      WHERE e.order_ref IS NOT NULL AND o.ref IS NULL ORDER BY e.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({ rule: 10 as const, check: 'entry_ref_exists', ref: r.order_ref, message: `Journal entry ${r.id} points at order reference ${r.order_ref}, which does not exist.` }));
}

async function receiptsConsistent(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const gaps = await db.query<{ period: string; c: number; m: number }>(
    `SELECT substring(receipt_no from 4 for 4) AS period, count(*)::bigint AS c, max(substring(receipt_no from 9)::int)::bigint AS m
       FROM payment_receipts GROUP BY 1 HAVING count(*) <> max(substring(receipt_no from 9)::int) ORDER BY 1`);
  for (const g of gaps.rows) out.push({ rule: null, check: 'receipt_numbering', message: `Receipt numbers for ${g.period} are not gapless: ${g.c} receipts but the highest number is ${g.m}.` });
  const mism = await db.query<{ receipt_no: string; order_ref: string }>(
    `SELECT r.receipt_no, r.order_ref FROM payment_receipts r JOIN journal_entries e ON e.id = r.journal_entry_id
      WHERE e.order_ref IS DISTINCT FROM r.order_ref ORDER BY r.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const m of mism.rows) out.push({ rule: 10, check: 'receipt_ref_matches_entry', ref: m.order_ref, message: `Receipt ${m.receipt_no} does not match the order reference of its ledger entry.` });
  return out;
}

async function ordersNeverOverpaid(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ order_ref: string; total: number; balance: number }>(
    `SELECT o.order_ref, o.total_cents AS total,
            COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                       WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref AND NOT EXISTS (SELECT 1 FROM order_returns rt WHERE rt.entry_id = e.id)), 0)::bigint AS balance
       FROM orders o
     WHERE COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                       WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref AND NOT EXISTS (SELECT 1 FROM order_returns rt WHERE rt.entry_id = e.id)), 0) NOT BETWEEN 0 AND o.total_cents
     ORDER BY o.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({
    rule: 6 as const, check: 'order_within_total', ref: r.order_ref,
    message: `Order ${r.order_ref} owes ${r.balance} cents against a total of ${r.total}: it has been paid more than it owes, or its receivable went negative.`,
  }));
}

/** An order's lines add up to its subtotal (the guard lets a merge grow the order, so this proves the lines and the amount agree). */
async function orderLinesMatchSubtotal(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ order_ref: string; subtotal: number; lines: number }>(
    `SELECT o.order_ref, o.subtotal_cents AS subtotal, COALESCE(sum(i.line_total_cents), 0)::bigint AS lines
       FROM orders o LEFT JOIN order_items i ON i.order_id = o.id GROUP BY o.id HAVING o.subtotal_cents <> COALESCE(sum(i.line_total_cents), 0)
      ORDER BY o.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({ rule: null, check: 'order_lines_match_subtotal', ref: r.order_ref, message: `Order ${r.order_ref}: its lines add up to ${r.lines} cents but its subtotal is ${r.subtotal}.` }));
}

async function paidMatchesReceipts(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ order_ref: string; paid: number; expected: number }>(
    `SELECT o.order_ref,
            (COALESCE((SELECT sum(r.amount_cents) FROM payment_receipts r WHERE r.order_ref = o.order_ref), 0)
             + COALESCE((SELECT sum(k.amount_cents) FROM org_collections k WHERE k.order_ref = o.order_ref), 0))::bigint AS paid,
            (o.total_cents - COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                                        WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref AND NOT EXISTS (SELECT 1 FROM order_returns rt WHERE rt.entry_id = e.id)), 0))::bigint AS expected
       FROM orders o WHERE o.status <> 'cancelled'
     ORDER BY o.id`);
  return rows.filter((r) => r.paid !== r.expected).slice(0, MAX_REPORTED_PER_CHECK).map((r) => ({
    rule: 2 as const, check: 'paid_matches_receipts', ref: r.order_ref,
    message: `Order ${r.order_ref}: receipts and organization collections add up to ${r.paid} cents but the ledger says ${r.expected} has been paid.`,
  }));
}

async function moneyHasReference(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT DISTINCT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
      WHERE e.order_ref IS NULL AND a.code = 'CUSTOMER_RECEIVABLE' ORDER BY e.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({
    rule: 3 as const, check: 'money_has_reference',
    message: `Journal entry ${r.id} moves customer money but carries no order reference. Money with no reference must sit in suspense.`,
  }));
}

async function suspenseReconciles(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ ledger: number; open: number }>(
    `SELECT COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = 'SUSPENSE'), 0)::bigint AS ledger,
            COALESCE((SELECT sum(x.amount_cents) FROM payment_exceptions x), 0)::bigint
          - COALESCE((SELECT sum(r.amount_cents) FROM exception_resolutions r), 0)::bigint AS open`);
  const r = rows[0]!;
  // Suspense is a liability: money held for someone else is a credit (negative).
  return r.ledger === -r.open ? [] : [{
    rule: 3, check: 'suspense_reconciles',
    message: `The ledger holds ${-r.ledger} cents in suspense but the unresolved suspense items add up to ${r.open} cents.`,
  }];
}

async function dispatchesHaveFees(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ order_ref: string }>(
    `SELECT o.order_ref FROM orders o
      WHERE o.status IN ('dispatched', 'delivered', 'returning', 'returned') AND NOT EXISTS (SELECT 1 FROM package_fees f WHERE f.order_id = o.id)
      ORDER BY o.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({ rule: 11 as const, check: 'dispatch_has_fee', ref: r.order_ref, message: `Order ${r.order_ref} was dispatched but has no package fee line.` }));
}

async function feesAndCostsNeverCombined(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const mixed = await db.query<{ id: number }>(
    `SELECT e.id FROM journal_entries e
      WHERE EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code = 'COURIER_PACKAGE_FEES')
        AND EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code = 'COURIER_COSTS')
      ORDER BY e.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of mixed.rows) out.push({ rule: 12, check: 'fees_costs_combined', message: `Journal entry ${r.id} mixes package fees and courier costs in one entry.` });
  const items = await db.query<{ id: number }>(
    `SELECT id FROM payout_items WHERE (package_fee_id IS NOT NULL) = (courier_cost_id IS NOT NULL) ORDER BY id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of items.rows) out.push({ rule: 12, check: 'payout_line_combined', message: `Payout line ${r.id} is not exactly one package fee or one courier cost.` });
  // The expense a fee or cost posted must match its own record, and be of its own kind.
  const feeMismatch = await db.query<{ id: number }>(
    `SELECT f.id FROM package_fees f JOIN journal_entries e ON e.id = f.entry_id
      WHERE f.amount_cents <> COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code = 'COURIER_PACKAGE_FEES'), 0)
      ORDER BY f.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of feeMismatch.rows) out.push({ rule: 12, check: 'fee_entry_matches', message: `Package fee ${r.id} does not match the package fees posted for it in the ledger.` });
  const costMismatch = await db.query<{ id: number }>(
    `SELECT c.id FROM courier_costs c JOIN journal_entries e ON e.id = c.entry_id
      WHERE c.amount_cents <> COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code = 'COURIER_COSTS'), 0)
      ORDER BY c.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of costMismatch.rows) out.push({ rule: 12, check: 'cost_entry_matches', message: `Courier cost ${r.id} does not match the courier costs posted for it in the ledger.` });
  return out;
}

async function courierPayableMatchesUnpaid(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const noCourier = await db.query<{ id: number }>(
    `SELECT DISTINCT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
      WHERE a.code IN ('COURIER_PAYABLE', 'ORG_RECEIVABLE') AND e.courier_id IS NULL ORDER BY e.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of noCourier.rows) out.push({ rule: 4, check: 'courier_entry_has_courier', message: `Journal entry ${r.id} touches a courier balance but names no courier.` });

  const { rows } = await db.query<{ id: number; name: string; ledger: number; unpaid: number }>(
    `SELECT c.id, c.name,
            COALESCE(-(SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                        WHERE a.code = 'COURIER_PAYABLE' AND e.courier_id = c.id), 0)::bigint AS ledger,
            (COALESCE((SELECT sum(f.amount_cents) FROM package_fees f WHERE f.courier_id = c.id AND f.amount_cents > 0
                        AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id)), 0)
           + COALESCE((SELECT sum(k.amount_cents) FROM courier_costs k WHERE k.courier_id = c.id AND k.status = 'approved'
                        AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.courier_cost_id = k.id)), 0))::bigint AS unpaid
       FROM couriers c ORDER BY c.id`);
  for (const r of rows.filter((x) => x.ledger !== x.unpaid).slice(0, MAX_REPORTED_PER_CHECK)) {
    out.push({ rule: 4, check: 'courier_payable_matches', message: `Courier ${r.name} (#${r.id}): the ledger says we owe ${r.ledger} cents but unpaid fees and approved costs add up to ${r.unpaid}.` });
  }
  return out;
}

async function organizationReceivableMatches(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number; name: string; ledger: number; expected: number }>(
    `SELECT c.id, c.name,
            COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                       WHERE a.code = 'ORG_RECEIVABLE' AND e.courier_id = c.id), 0)::bigint AS ledger,
            (COALESCE((SELECT sum(k.amount_cents) FROM org_collections k WHERE k.courier_id = c.id), 0)
           - COALESCE((SELECT sum(s.remitted_cents + s.fees_cents) FROM org_statements s WHERE s.courier_id = c.id), 0))::bigint AS expected
       FROM couriers c WHERE c.kind = 'organization' ORDER BY c.id`);
  return rows.filter((r) => r.ledger !== r.expected).slice(0, MAX_REPORTED_PER_CHECK).map((r) => ({
    rule: 5 as const, check: 'org_receivable_matches',
    message: `Organization ${r.name} (#${r.id}): the ledger says it holds ${r.ledger} cents but collections minus settlements is ${r.expected}.`,
  }));
}

async function custodyReconciles(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ ledger: number; open: number }>(
    `SELECT COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = 'STAFF_CASH_IN_HAND'), 0)::bigint AS ledger,
            COALESCE((SELECT sum(amount_cents) FROM custody_records WHERE status = 'open'), 0)::bigint AS open`);
  const r = rows[0]!;
  return r.ledger === r.open ? [] : [{
    rule: null, check: 'custody_reconciles',
    message: `The ledger shows ${r.ledger} cents of staff cash in hand but open custody records add up to ${r.open} cents.`,
  }];
}

// RULE 9: a locked payroll run never changes. Its figures were fingerprinted when it was approved; recompute the
// fingerprint from what is stored now. A difference means someone altered a locked run, with the guards off or around them.
async function lockedRunsUnchanged(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number; checksum: string; period_start: string; period_end: string }>(
    `SELECT id, checksum, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end
       FROM payroll_runs WHERE status <> 'draft' ORDER BY id`);
  const out: Violation[] = [];
  for (const r of rows) {
    if ((await runFingerprint(db, r.id)) !== r.checksum) {
      out.push({ rule: 9, check: 'locked_run_unchanged', message: `Payroll run ${r.id} (${r.period_start} to ${r.period_end}) is locked but its figures no longer match what was approved.` });
    }
  }
  return out.slice(0, MAX_REPORTED_PER_CHECK);
}

// RULE 8: commission only on secure money. Every order commissioned in a locked run must (still) be fully secure, and must
// have become secure no later than the end of that run's period.
async function commissionOnSecureMoney(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const { rows } = await db.query<{ order_ref: string; run_id: number; period_end: string }>(
    `SELECT c.order_ref, c.run_id, to_char(r.period_end, 'YYYY-MM-DD') AS period_end FROM commissioned_orders c JOIN payroll_runs r ON r.id = c.run_id ORDER BY c.order_ref`);
  if (rows.length === 0) return out;
  const secure = new Map((await securedOrders(db, { orderRefs: rows.map((r) => r.order_ref) })).map((o) => [o.orderRef, o]));
  for (const r of rows) {
    const o = secure.get(r.order_ref);
    if (!o) out.push({ rule: 8, check: 'commission_secure', ref: r.order_ref, message: `Order ${r.order_ref} earned commission in payroll run ${r.run_id} but its money is not fully secure.` });
    else if (o.securedAt >= shopDayEnd(r.period_end)) out.push({ rule: 8, check: 'commission_secure_in_period', ref: r.order_ref, message: `Order ${r.order_ref} earned commission in payroll run ${r.run_id} before its money was secure.` });
  }
  // Each commission line in a locked run must match a commissioned_orders row, and vice versa.
  const unmatched = await db.query<{ order_ref: string; run_id: number }>(
    `SELECT l.ref_text AS order_ref, i.run_id FROM payroll_item_lines l JOIN payroll_items i ON i.id = l.item_id JOIN payroll_runs r ON r.id = i.run_id
      WHERE l.kind = 'commission_order' AND r.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM commissioned_orders c WHERE c.order_ref = l.ref_text AND c.run_id = i.run_id)`);
  for (const u of unmatched.rows) out.push({ rule: 8, check: 'commission_line_recorded', ref: u.order_ref, message: `Commission for order ${u.order_ref} in payroll run ${u.run_id} is not recorded as commissioned.` });
  return out.slice(0, MAX_REPORTED_PER_CHECK);
}

async function statementSecuredAddsUp(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number; secured: number; settled: number }>(
    `SELECT s.id, COALESCE(sum(l.secured_cents), 0)::bigint AS secured, (s.remitted_cents + s.fees_cents)::bigint AS settled
       FROM org_statements s LEFT JOIN org_statement_lines l ON l.statement_id = s.id GROUP BY s.id
     HAVING COALESCE(sum(l.secured_cents), 0) <> s.remitted_cents + s.fees_cents ORDER BY s.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({ rule: 8 as const, check: 'statement_secured_adds_up', message: `Organization statement ${r.id} secured ${r.secured} cents across its parcels but settled ${r.settled} cents.` }));
}

// Phase 6: the shop floor. Every sale's ledger entry must say what the sale says; nothing is refunded more than it was sold or
// paid; every closed till session must still reconcile; a discount above the cashier's limit must have a manager's approval.
async function salesMatchLedger(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ id: number; sale_no: string; sales_cr: number; disc_dr: number; paid: number; pay_dr: number }>(
    `SELECT s.id, s.sale_no,
            COALESCE(-(SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = s.entry_id AND a.code = 'SALES'), 0)::bigint AS sales_cr,
            COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = s.entry_id AND a.code = 'SALES_DISCOUNTS'), 0)::bigint AS disc_dr,
            (SELECT COALESCE(sum(amount_cents), 0) FROM sale_payments WHERE sale_id = s.id)::bigint AS paid,
            COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
                       WHERE l.entry_id = s.entry_id AND a.code IN ('TILL', 'CARD_CLEARING', 'MOBILE_MONEY_TILL')), 0)::bigint AS pay_dr
       FROM sales s ORDER BY s.id`);
  const out: Violation[] = [];
  for (const r of rows) {
    const s = await db.query<{ gross: number; disc: number; total: number }>(`SELECT gross_cents AS gross, line_discount_cents + sale_discount_cents AS disc, total_cents AS total FROM sales WHERE id = $1`, [r.id]);
    const x = s.rows[0]!;
    if (r.sales_cr !== x.gross || r.disc_dr !== x.disc || r.pay_dr !== x.total || r.paid !== x.total) {
      out.push({ rule: null, check: 'sale_matches_ledger', ref: r.sale_no, message: `Sale ${r.sale_no} says gross ${x.gross}, discount ${x.disc}, total ${x.total}, but its ledger entry shows sales ${r.sales_cr}, discounts ${r.disc_dr}, payments ${r.pay_dr} and its payment rows add up to ${r.paid}.` });
    }
    if (out.length >= MAX_REPORTED_PER_CHECK) break;
  }
  return out;
}

async function refundsWithinSold(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const items = await db.query<{ id: number; sale_no: string; sold: number; refunded: number }>(
    `SELECT i.id, s.sale_no, i.quantity AS sold, COALESCE(sum(ri.quantity), 0)::int AS refunded FROM sale_items i JOIN sales s ON s.id = i.sale_id
       LEFT JOIN sale_refund_items ri ON ri.sale_item_id = i.id GROUP BY i.id, s.sale_no HAVING COALESCE(sum(ri.quantity), 0) > i.quantity ORDER BY i.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of items.rows) out.push({ rule: null, check: 'refund_within_sold', ref: r.sale_no, message: `Sale ${r.sale_no} item ${r.id}: ${r.refunded} refunded but only ${r.sold} sold.` });
  const money = await db.query<{ sale_no: string; method: string; paid: number; refunded: number }>(
    `SELECT s.sale_no, p.method, p.amount_cents AS paid, COALESCE(sum(r.amount_cents), 0)::bigint AS refunded FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       LEFT JOIN sale_refunds r ON r.sale_id = p.sale_id AND r.method = p.method GROUP BY s.sale_no, p.method, p.amount_cents HAVING COALESCE(sum(r.amount_cents), 0) > p.amount_cents`);
  for (const r of money.rows) out.push({ rule: null, check: 'refund_within_paid', ref: r.sale_no, message: `Sale ${r.sale_no}: ${r.refunded} cents refunded by ${r.method} but only ${r.paid} was paid that way.` });
  const entries = await db.query<{ id: number; sale_no: string; amount: number; posted: number }>(
    `SELECT r.id, s.sale_no, r.amount_cents AS amount,
            COALESCE(-(SELECT sum(l.amount_cents) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
                        WHERE l.entry_id = r.entry_id AND a.code = CASE r.method WHEN 'cash' THEN 'TILL' WHEN 'card' THEN 'CARD_CLEARING' ELSE 'MOBILE_MONEY_TILL' END), 0)::bigint AS posted
       FROM sale_refunds r JOIN sales s ON s.id = r.sale_id ORDER BY r.id`);
  for (const r of entries.rows.filter((x) => x.amount !== x.posted)) out.push({ rule: null, check: 'refund_matches_ledger', ref: r.sale_no, message: `Refund ${r.id} on sale ${r.sale_no} says ${r.amount} cents but the ledger paid out ${r.posted}.` });
  return out.slice(0, MAX_REPORTED_PER_CHECK);
}

async function closedSessionsReconcile(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const sessions = await db.query<{ id: number; cashier: string }>(`SELECT id, cashier FROM cash_sessions WHERE status <> 'open' ORDER BY id`);
  for (const s of sessions.rows) {
    const counts = await db.query<{ method: string; expected: number; counted: number; variance: number; entry_id: number | null }>(
      `SELECT method, expected_cents AS expected, counted_cents AS counted, variance_cents AS variance, entry_id FROM cash_session_counts WHERE session_id = $1`, [s.id]);
    if (counts.rows.length !== METHODS.length) { out.push({ rule: null, check: 'session_counts_complete', message: `Till session ${s.id} is closed but has ${counts.rows.length} of ${METHODS.length} method counts.` }); continue; }
    // closed-session figures are recomputed from the sales, refunds and movements; the float, sales and movements cannot have changed since
    const expected = await expectedByMethod(db, s.id);
    for (const c of counts.rows) {
      const m = c.method as (typeof METHODS)[number];
      if (c.expected !== expected[m]) out.push({ rule: null, check: 'session_expected_matches', message: `Till session ${s.id} (${s.cashier}), ${m}: closed expecting ${c.expected} cents but the sales, refunds and movements now say ${expected[m]}.` });
      if (c.variance !== 0) {
        const posted = c.entry_id === null ? 0 : (await db.query<{ v: number }>(
          `SELECT COALESCE(sum(l.amount_cents), 0)::bigint AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 AND a.code = $2`, [c.entry_id, METHOD_ACCOUNT[m]])).rows[0]!.v;
        if (posted !== c.variance) out.push({ rule: null, check: 'session_variance_posted', message: `Till session ${s.id}, ${m}: the count was ${c.variance} cents out but the ledger recorded ${posted}.` });
      }
    }
  }
  return out.slice(0, MAX_REPORTED_PER_CHECK);
}

// Stock is a sum of movements, so these checks prove the movements agree with the sales and dispatches that caused them.
async function stockIsConsistent(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const neg = await db.query<{ sku: string; n: number }>(
    `SELECT p.sku, sum(m.quantity)::bigint AS n FROM stock_movements m JOIN products p ON p.id = m.product_id GROUP BY p.sku HAVING sum(m.quantity) < 0 ORDER BY p.sku LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of neg.rows) out.push({ rule: null, check: 'stock_not_negative', message: `Product ${r.sku} shows ${r.n} in stock: stock can never be below zero.` });

  // Every dispatched order took its tracked goods out of stock, exactly once.
  const disp = await db.query<{ order_ref: string; sku: string; want: number; got: number }>(
    `SELECT o.order_ref, p.sku, sum(i.quantity)::bigint AS want,
            COALESCE((SELECT -sum(m.quantity) FROM stock_movements m WHERE m.type = 'dispatch' AND m.ref_type = 'order' AND m.ref_id = o.id AND m.product_id = p.id), 0)::bigint AS got
       FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
      WHERE o.status IN ('dispatched', 'delivered', 'returning', 'returned') AND p.track_stock GROUP BY o.id, o.order_ref, p.id, p.sku
     HAVING sum(i.quantity) <> COALESCE((SELECT -sum(m.quantity) FROM stock_movements m WHERE m.type = 'dispatch' AND m.ref_type = 'order' AND m.ref_id = o.id AND m.product_id = p.id), 0)
      ORDER BY o.order_ref LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of disp.rows) out.push({ rule: null, check: 'dispatch_took_stock', ref: r.order_ref, message: `Order ${r.order_ref} was dispatched with ${r.want} of ${r.sku} but stock was reduced by ${r.got}.` });

  // A dispatch movement for an order that was never dispatched.
  const ghost = await db.query<{ order_ref: string }>(
    `SELECT DISTINCT o.order_ref FROM stock_movements m JOIN orders o ON o.id = m.ref_id WHERE m.type = 'dispatch' AND m.ref_type = 'order' AND o.status IN ('awaiting_dispatch', 'cancelled') LIMIT ${MAX_REPORTED_PER_CHECK}`);
  for (const r of ghost.rows) out.push({ rule: null, check: 'dispatch_movement_without_dispatch', ref: r.order_ref, message: `Stock was taken out for order ${r.order_ref}, which has not been dispatched.` });

  // Every sale took its tracked goods out; a voided sale put them all back.
  const sales = await db.query<{ sale_no: string; sku: string; want: number; sold: number; back: number; status: string }>(
    `SELECT s.sale_no, s.status, p.sku, sum(i.quantity)::bigint AS want,
            COALESCE((SELECT -sum(m.quantity) FROM stock_movements m WHERE m.type = 'sale' AND m.ref_type = 'sale' AND m.ref_id = s.id AND m.product_id = p.id), 0)::bigint AS sold,
            COALESCE((SELECT sum(m.quantity) FROM stock_movements m WHERE m.type = 'void_reversal' AND m.ref_type = 'sale' AND m.ref_id = s.id AND m.product_id = p.id), 0)::bigint AS back
       FROM sales s JOIN sale_items i ON i.sale_id = s.id JOIN products p ON p.id = i.product_id WHERE p.track_stock GROUP BY s.id, s.sale_no, s.status, p.id, p.sku ORDER BY s.id`);
  for (const r of sales.rows) {
    if (r.sold !== r.want) out.push({ rule: null, check: 'sale_took_stock', ref: r.sale_no, message: `Sale ${r.sale_no} sold ${r.want} of ${r.sku} but stock was reduced by ${r.sold}.` });
    const expectedBack = r.status === 'voided' ? r.want : 0;
    if (r.back !== expectedBack) out.push({ rule: null, check: 'void_returned_stock', ref: r.sale_no, message: `Sale ${r.sale_no} (${r.status}): ${r.back} of ${r.sku} went back in stock, expected ${expectedBack}.` });
  }
  // Nothing restocked from a refund beyond what was refunded.
  const rf = await db.query<{ sale_no: string; sku: string; refunded: number; restocked: number }>(
    `SELECT s.sale_no, p.sku, sum(ri.quantity)::bigint AS refunded,
            COALESCE((SELECT sum(m.quantity) FROM stock_movements m JOIN sale_refunds r2 ON r2.id = m.ref_id WHERE m.type = 'refund_restock' AND r2.sale_id = s.id AND m.product_id = p.id), 0)::bigint AS restocked
       FROM sale_refund_items ri JOIN sale_refunds r ON r.id = ri.refund_id JOIN sales s ON s.id = r.sale_id JOIN sale_items i ON i.id = ri.sale_item_id JOIN products p ON p.id = i.product_id
      GROUP BY s.id, s.sale_no, p.id, p.sku ORDER BY s.id`);
  for (const r of rf.rows) if (r.restocked > r.refunded) out.push({ rule: null, check: 'refund_restock_within_refunded', ref: r.sale_no, message: `Sale ${r.sale_no}: ${r.restocked} of ${r.sku} restocked but only ${r.refunded} refunded.` });
  return out.slice(0, MAX_REPORTED_PER_CHECK);
}

// A returned parcel: what went back on the shelf matches the count, and the unpaid part of the order is no longer owed.
async function returnsAreConsistent(db: Queryable): Promise<Violation[]> {
  const out: Violation[] = [];
  const stock = await db.query<{ order_ref: string; sku: string; counted: number; moved: number }>(
    `SELECT o.order_ref, p.sku, sum(ri.restocked)::bigint AS counted,
            COALESCE((SELECT sum(m.quantity) FROM stock_movements m WHERE m.type = 'return_restock' AND m.ref_type = 'order' AND m.ref_id = o.id AND m.product_id = p.id), 0)::bigint AS moved
       FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN order_return_items ri ON ri.return_id = r.id JOIN order_items i ON i.id = ri.order_item_id JOIN products p ON p.id = i.product_id
      WHERE p.track_stock GROUP BY o.id, o.order_ref, p.id, p.sku ORDER BY o.order_ref`);
  for (const r of stock.rows) if (r.counted !== r.moved) out.push({ rule: null, check: 'return_restock_matches', ref: r.order_ref, message: `Order ${r.order_ref}: ${r.counted} of ${r.sku} were counted back onto the shelf but stock went up by ${r.moved}.` });
  const owed = await db.query<{ order_ref: string; bal: number }>(
    `SELECT o.order_ref, COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref), 0)::bigint AS bal
       FROM orders o WHERE o.status = 'returned' ORDER BY o.order_ref`);
  for (const r of owed.rows) if (r.bal > 0) out.push({ rule: null, check: 'returned_order_still_owed', ref: r.order_ref, message: `Order ${r.order_ref} was returned but the customer still owes ${r.bal} cents on it.` });
  const noRecord = await db.query<{ order_ref: string }>(`SELECT o.order_ref FROM orders o WHERE o.status = 'returned' AND NOT EXISTS (SELECT 1 FROM order_returns r WHERE r.order_id = o.id)`);
  for (const r of noRecord.rows) out.push({ rule: null, check: 'returned_without_record', ref: r.order_ref, message: `Order ${r.order_ref} is marked returned but no return was recorded for it.` });
  return out.slice(0, MAX_REPORTED_PER_CHECK);
}

async function discountsHaveApproval(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ sale_no: string; role: string; disc: number; gross: number; free: number | null }>(
    `SELECT s.sale_no, s.cashier_role AS role, (s.line_discount_cents + s.sale_discount_cents) AS disc, s.gross_cents AS gross,
            (SELECT p.free_limit_bp FROM discount_policies p WHERE p.role = s.cashier_role AND p.effective_from <= (s.created_at AT TIME ZONE 'Africa/Nairobi')::date
              ORDER BY p.effective_from DESC LIMIT 1) AS free
       FROM sales s WHERE s.line_discount_cents + s.sale_discount_cents > 0 AND NOT EXISTS (SELECT 1 FROM discount_approvals a WHERE a.sale_id = s.id) ORDER BY s.id`);
  return rows
    .filter((r) => r.free === null || BigInt(r.disc) * 10_000n > BigInt(r.free) * BigInt(r.gross))
    .slice(0, MAX_REPORTED_PER_CHECK)
    .map((r) => ({ rule: null, check: 'discount_has_approval', ref: r.sale_no, message: `Sale ${r.sale_no} gave a discount above a ${r.role}'s limit with no manager approval on record.` }));
}

export async function runIntegrityChecks(db: Queryable): Promise<IntegrityReport> {
  const started = Date.now();
  const violations = [
    ...(await guardsInPlace(db)),
    ...(await entriesBalance(db)),
    ...(await ledgerTotalsZero(db)),
    ...(await reversalsAreExact(db)),
    ...(await orderRefsValid(db)),
    ...(await entryRefsExist(db)),
    ...(await receiptsConsistent(db)),
    ...(await ordersNeverOverpaid(db)),
    ...(await paidMatchesReceipts(db)),
    ...(await orderLinesMatchSubtotal(db)),
    ...(await moneyHasReference(db)),
    ...(await suspenseReconciles(db)),
    ...(await dispatchesHaveFees(db)),
    ...(await feesAndCostsNeverCombined(db)),
    ...(await courierPayableMatchesUnpaid(db)),
    ...(await organizationReceivableMatches(db)),
    ...(await custodyReconciles(db)),
    ...(await lockedRunsUnchanged(db)),
    ...(await commissionOnSecureMoney(db)),
    ...(await statementSecuredAddsUp(db)),
    ...(await salesMatchLedger(db)),
    ...(await refundsWithinSold(db)),
    ...(await closedSessionsReconcile(db)),
    ...(await discountsHaveApproval(db)),
    ...(await stockIsConsistent(db)),
    ...(await returnsAreConsistent(db)),
  ];
  const c = await db.query<{ e: number; l: number; o: number; r: number; ord: number; pay: number; cou: number; sal: number }>(
    `SELECT (SELECT count(*) FROM journal_entries)::bigint AS e, (SELECT count(*) FROM journal_lines)::bigint AS l,
            (SELECT count(*) FROM order_refs)::bigint AS o, (SELECT count(*) FROM payment_receipts)::bigint AS r,
            (SELECT count(*) FROM orders)::bigint AS ord, (SELECT count(*) FROM paybill_payments)::bigint AS pay,
            (SELECT count(*) FROM couriers)::bigint AS cou, (SELECT count(*) FROM sales)::bigint AS sal`);
  const counts = { entries: c.rows[0]!.e, lines: c.rows[0]!.l, orderRefs: c.rows[0]!.o, receipts: c.rows[0]!.r, orders: c.rows[0]!.ord, payments: c.rows[0]!.pay, couriers: c.rows[0]!.cou, sales: c.rows[0]!.sal };
  return { ok: violations.length === 0, checkedAt: new Date(), durationMs: Date.now() - started, counts, violations };
}
