import type { Queryable } from '../db/tx.js';
import { isValidRef } from '../ledger/orderRef.js';

// The nightly integrity job. The database already refuses to break these rules; this job proves it by looking at
// the data itself, and catches the case where the guards were switched off or bypassed (a restored backup, a hand-run
// script, a disabled trigger).
//
// Rules checked so far: 1 (entries balance), 2 (paid amount comes from receipts, never a counter), 3 (money without an
// order reference sits in suspense), 6 (payments never exceed what is owed), 7 (records immutable), 10 (order
// references unique, immutable). Later phases add the rest of the twelve.

export interface Violation {
  rule: 1 | 2 | 3 | 6 | 7 | 10 | null; // the rule number in the plan; null for supporting checks
  check: string;
  message: string;
  ref?: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: Date;
  durationMs: number;
  counts: { entries: number; lines: number; orderRefs: number; receipts: number; orders: number; payments: number };
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
];

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
    if (enabled === undefined) out.push({ rule: g.trigger.includes('balanced') ? 1 : g.trigger.startsWith('order_refs') ? 10 : 7, check: 'guard_present', message: `Protection trigger ${g.trigger} on ${g.table} is missing.` });
    else if (enabled === 'D') out.push({ rule: g.trigger.includes('balanced') ? 1 : g.trigger.startsWith('order_refs') ? 10 : 7, check: 'guard_enabled', message: `Protection trigger ${g.trigger} on ${g.table} is DISABLED.` });
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
            COALESCE((SELECT sum(r.amount_cents) FROM payment_receipts r WHERE r.order_ref = o.order_ref), 0)::bigint AS paid,
            (o.total_cents - COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                                        WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref), 0))::bigint AS expected
       FROM orders o WHERE o.status <> 'cancelled'
     ORDER BY o.id`);
  return rows.filter((r) => r.paid !== r.expected).slice(0, MAX_REPORTED_PER_CHECK).map((r) => ({
    rule: 2 as const, check: 'paid_matches_receipts', ref: r.order_ref,
    message: `Order ${r.order_ref}: receipts add up to ${r.paid} cents but the ledger says ${r.expected} has been paid.`,
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
  ];
  const c = await db.query<{ e: number; l: number; o: number; r: number; ord: number; pay: number }>(
    `SELECT (SELECT count(*) FROM journal_entries)::bigint AS e, (SELECT count(*) FROM journal_lines)::bigint AS l,
            (SELECT count(*) FROM order_refs)::bigint AS o, (SELECT count(*) FROM payment_receipts)::bigint AS r,
            (SELECT count(*) FROM orders)::bigint AS ord, (SELECT count(*) FROM paybill_payments)::bigint AS pay`);
  const counts = { entries: c.rows[0]!.e, lines: c.rows[0]!.l, orderRefs: c.rows[0]!.o, receipts: c.rows[0]!.r, orders: c.rows[0]!.ord, payments: c.rows[0]!.pay };
  return { ok: violations.length === 0, checkedAt: new Date(), durationMs: Date.now() - started, counts, violations };
}
