import type pg from 'pg';
import { withTransaction } from '../db/tx.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { queuePaymentReceived } from '../sms/sms.js';

export type ReceiptMethod = 'mpesa_paybill' | 'organization_remittance' | 'cash' | 'bank';

export interface Receipt {
  id: number;
  receiptNo: string;
  orderRef: string;
  journalEntryId: number;
  amountCents: number;
  method: ReceiptMethod;
  externalRef: string | null;
  issuedAt: Date;
  actor: string;
}

// The shop works in East Africa Time (UTC+3, no daylight saving), so a receipt issued at 01:00 on 1 November
// belongs to November's numbering even though it is still 31 October in UTC.
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** "2610" for October 2026, in shop time. */
export function receiptPeriod(at: Date): string {
  const local = new Date(at.getTime() + EAT_OFFSET_MS);
  const yy = String(local.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

interface Row {
  id: number; receipt_no: string; order_ref: string; journal_entry_id: number; amount_cents: number;
  method: ReceiptMethod; external_ref: string | null; issued_at: Date; actor: string;
}

/**
 * Issues the next receipt number (RC-YYMM-NNNNNN) for a payment already posted to the ledger. Numbers are gapless:
 * the month's counter row is locked and rolls back with the receipt, so a failed attempt never burns a number.
 * Call inside the transaction that posts the payment.
 */
export async function issueReceiptTx(client: pg.PoolClient, input: {
  orderRef: string; journalEntryId: number; amountCents: number; method: ReceiptMethod;
  externalRef?: string; actor: string; at?: Date;
}): Promise<Receipt> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new HttpError(422, 'RECEIPT_BAD_AMOUNT', 'A receipt amount must be a positive whole number of cents.');
  }
  const at = input.at ?? new Date();
  const period = receiptPeriod(at);
  const counter = await client.query<{ last_no: number }>(
    `INSERT INTO receipt_counters (period, last_no) VALUES ($1, 1)
     ON CONFLICT (period) DO UPDATE SET last_no = receipt_counters.last_no + 1
     RETURNING last_no`, [period]);
  const n = counter.rows[0]!.last_no;
  if (n > 999_999) throw new HttpError(500, 'RECEIPT_COUNTER_FULL', `Receipt numbers for ${period} are exhausted.`);
  const receiptNo = `RC-${period}-${String(n).padStart(6, '0')}`;

  try {
    const { rows } = await client.query<Row>(
      `INSERT INTO payment_receipts (receipt_no, order_ref, journal_entry_id, amount_cents, method, external_ref, issued_at, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, receipt_no, order_ref, journal_entry_id, amount_cents, method, external_ref, issued_at, actor`,
      [receiptNo, input.orderRef, input.journalEntryId, input.amountCents, input.method, input.externalRef ?? null, at, input.actor]);
    const r = rows[0]!;
    // The customer's "we received your payment" text: queued in this transaction (so a rolled-back payment sends nothing), sent later.
    await queuePaymentReceived(client, { receiptId: r.id, orderRef: r.order_ref, amountCents: r.amount_cents });
    return { id: r.id, receiptNo: r.receipt_no, orderRef: r.order_ref, journalEntryId: r.journal_entry_id,
      amountCents: r.amount_cents, method: r.method, externalRef: r.external_ref, issuedAt: r.issued_at, actor: r.actor };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === '23514') throw new HttpError(422, 'RECEIPT_ORDER_MISMATCH', e.message ?? 'Receipt does not match the ledger entry.');
    if (e.code === '23505') throw new HttpError(409, 'RECEIPT_ALREADY_ISSUED', 'A receipt has already been issued for that ledger entry.');
    throw err;
  }
}

export function issueReceipt(pool: Pool, input: Parameters<typeof issueReceiptTx>[1]): Promise<Receipt> {
  return withTransaction(pool, (c) => issueReceiptTx(c, input));
}
