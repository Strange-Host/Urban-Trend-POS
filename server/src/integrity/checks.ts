import type { Queryable } from '../db/tx.js';
import { isValidRef } from '../ledger/orderRef.js';
import { securedOrders } from '../payroll/commission.js';
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
  counts: { entries: number; lines: number; orderRefs: number; receipts: number; orders: number; payments: number; couriers: number };
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
                       WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref), 0)::bigint AS balance
       FROM orders o
     WHERE COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                       WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref), 0) NOT BETWEEN 0 AND o.total_cents
     ORDER BY o.id LIMIT ${MAX_REPORTED_PER_CHECK}`);
  return rows.map((r) => ({
    rule: 6 as const, check: 'order_within_total', ref: r.order_ref,
    message: `Order ${r.order_ref} owes ${r.balance} cents against a total of ${r.total}: it has been paid more than it owes, or its receivable went negative.`,
  }));
}

async function paidMatchesReceipts(db: Queryable): Promise<Violation[]> {
  const { rows } = await db.query<{ order_ref: string; paid: number; expected: number }>(
    `SELECT o.order_ref,
            (COALESCE((SELECT sum(r.amount_cents) FROM payment_receipts r WHERE r.order_ref = o.order_ref), 0)
             + COALESCE((SELECT sum(k.amount_cents) FROM org_collections k WHERE k.order_ref = o.order_ref), 0))::bigint AS paid,
            (o.total_cents - COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                                        WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref), 0))::bigint AS expected
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
      WHERE o.status IN ('dispatched', 'delivered', 'returning') AND NOT EXISTS (SELECT 1 FROM package_fees f WHERE f.order_id = o.id)
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
  ];
  const c = await db.query<{ e: number; l: number; o: number; r: number; ord: number; pay: number; cou: number }>(
    `SELECT (SELECT count(*) FROM journal_entries)::bigint AS e, (SELECT count(*) FROM journal_lines)::bigint AS l,
            (SELECT count(*) FROM order_refs)::bigint AS o, (SELECT count(*) FROM payment_receipts)::bigint AS r,
            (SELECT count(*) FROM orders)::bigint AS ord, (SELECT count(*) FROM paybill_payments)::bigint AS pay,
            (SELECT count(*) FROM couriers)::bigint AS cou`);
  const counts = { entries: c.rows[0]!.e, lines: c.rows[0]!.l, orderRefs: c.rows[0]!.o, receipts: c.rows[0]!.r, orders: c.rows[0]!.ord, payments: c.rows[0]!.pay, couriers: c.rows[0]!.cou };
  return { ok: violations.length === 0, checkedAt: new Date(), durationMs: Date.now() - started, counts, violations };
}
