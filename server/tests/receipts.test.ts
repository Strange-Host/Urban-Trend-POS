import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { withTransaction } from '../src/db/tx.js';
import { cr, dr, postEntryTx } from '../src/ledger/ledger.js';
import { receiptPeriod, issueReceiptTx } from '../src/ledger/receipts.js';
import { allocateOrderRef } from '../src/ledger/refs.js';
import { makeTestDb, type TestDb } from './helpers.js';

const KEY = 'test-key-for-order-refs-0123456789abcdef';
let db: TestDb;

beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

// One payment: allocate a reference, post the ledger entry and issue the receipt in a single transaction.
function pay(opts: { at?: Date; amount?: number; fail?: boolean } = {}) {
  const amount = opts.amount ?? 50_000;
  return withTransaction(db.pool, async (c) => {
    const { ref } = await allocateOrderRef(c, { key: KEY });
    const { entry } = await postEntryTx(c, {
      description: 'Paybill payment', actor: 'mpesa', orderRef: ref,
      lines: [dr('PAYBILL_CLEARING', amount), cr('CUSTOMER_RECEIVABLE', amount)],
    });
    const receipt = await issueReceiptTx(c, { orderRef: ref, journalEntryId: entry.id, amountCents: amount, method: 'mpesa_paybill', externalRef: 'QWE123RTY4', actor: 'mpesa', at: opts.at });
    if (opts.fail) throw new Error('payment failed after the receipt number was taken');
    return { ref, entry, receipt };
  });
}

describe('receipt numbers', () => {
  it('uses shop time (East Africa Time) for the month', () => {
    expect(receiptPeriod(new Date('2026-10-15T09:00:00Z'))).toBe('2610');
    expect(receiptPeriod(new Date('2026-10-31T21:30:00Z'))).toBe('2611'); // 00:30 on 1 November in Nairobi
    expect(receiptPeriod(new Date('2026-10-31T20:59:00Z'))).toBe('2610');
    expect(receiptPeriod(new Date('2026-12-31T21:00:00Z'))).toBe('2701');
  });

  it('numbers receipts RC-YYMM-NNNNNN, in order, starting at 1 each month', async () => {
    const oct = new Date('2026-10-15T09:00:00Z');
    const a = await pay({ at: oct });
    const b = await pay({ at: oct });
    expect(a.receipt.receiptNo).toBe('RC-2610-000001');
    expect(b.receipt.receiptNo).toBe('RC-2610-000002');
    const nov = await pay({ at: new Date('2026-11-02T09:00:00Z') });
    expect(nov.receipt.receiptNo).toBe('RC-2611-000001');
  });

  it('is gapless: a payment that fails after taking a number does not burn it', async () => {
    const at = new Date('2026-12-10T09:00:00Z');
    expect((await pay({ at })).receipt.receiptNo).toBe('RC-2612-000001');
    await expect(pay({ at, fail: true })).rejects.toThrow(/payment failed/);
    expect((await pay({ at })).receipt.receiptNo).toBe('RC-2612-000002');
  });

  it('is gapless and unique under concurrent payments', async () => {
    const at = new Date('2027-01-10T09:00:00Z');
    const results = await Promise.all(Array.from({ length: 25 }, () => pay({ at })));
    const nos = results.map((r) => r.receipt.receiptNo).sort();
    expect(nos).toEqual(Array.from({ length: 25 }, (_, i) => `RC-2701-${String(i + 1).padStart(6, '0')}`));
  });
});

describe('receipts are tied to the order reference and the ledger entry', () => {
  it('links the receipt, the order reference and the ledger entry', async () => {
    const { ref, entry, receipt } = await pay();
    expect(receipt.orderRef).toBe(ref);
    expect(receipt.journalEntryId).toBe(entry.id);
    expect(receipt.amountCents).toBe(50_000);
    expect(receipt.externalRef).toBe('QWE123RTY4');
  });

  it('refuses a receipt whose order reference differs from its ledger entry', async () => {
    await expect(withTransaction(db.pool, async (c) => {
      const a = await allocateOrderRef(c, { key: KEY });
      const b = await allocateOrderRef(c, { key: KEY });
      const { entry } = await postEntryTx(c, { description: 'p', actor: 't', orderRef: a.ref, lines: [dr('BANK', 10), cr('SALES', 10)] });
      return issueReceiptTx(c, { orderRef: b.ref, journalEntryId: entry.id, amountCents: 10, method: 'bank', actor: 't' });
    })).rejects.toMatchObject({ code: 'RECEIPT_ORDER_MISMATCH' });
  });

  it('allows only one receipt per ledger entry, and only positive amounts', async () => {
    const { ref, entry } = await pay();
    await expect(withTransaction(db.pool, (c) => issueReceiptTx(c, { orderRef: ref, journalEntryId: entry.id, amountCents: 1, method: 'cash', actor: 't' })))
      .rejects.toMatchObject({ code: 'RECEIPT_ALREADY_ISSUED' });
    await expect(withTransaction(db.pool, (c) => issueReceiptTx(c, { orderRef: ref, journalEntryId: entry.id, amountCents: 0, method: 'cash', actor: 't' })))
      .rejects.toMatchObject({ code: 'RECEIPT_BAD_AMOUNT' });
  });

  it('receipts cannot be edited or deleted', async () => {
    await pay();
    await expect(db.pool.query(`UPDATE payment_receipts SET amount_cents = amount_cents + 1`)).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`DELETE FROM payment_receipts`)).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`TRUNCATE payment_receipts`)).rejects.toThrow(/immutable/);
  });
});
