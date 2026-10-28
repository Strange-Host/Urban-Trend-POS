import { describe, it, expect, vi, afterEach } from 'vitest';
import client, { getErrorMessage } from '../client';
import { newPaymentsApi, newPaymentReconciliationApi, newCustodyApi, adaptReceipt, adaptSuspense } from './payments';
import receipts from './__fixtures__/payments-list.json';
import suspense from './__fixtures__/payments-suspense.json';
import suggestions from './__fixtures__/payments-suggestions.json';
import custody from './__fixtures__/custody-list.json';

// Fixtures are recorded answers of the real new server (server/tests/contractFixtures.test.ts keeps them honest).
afterEach(() => { vi.restoreAllMocks(); });
const ok = (data) => Promise.resolve({ status: 200, data });

describe('the Payments tab', () => {
  it('shows receipts as incoming, completed payments with the legacy method names and the order they belong to', async () => {
    const get = vi.spyOn(client, 'get').mockReturnValue(ok(receipts));
    const res = await newPaymentsApi.list({ page: 2, pageSize: 25 });
    expect(get).toHaveBeenCalledWith('/payments', { params: expect.objectContaining({ limit: 25, offset: 25 }) });
    expect(res.data.total).toBe(receipts.total);
    expect(res.data.page).toBe(2);
    const first = res.data.data[0];
    expect(first).toMatchObject({ direction: 'incoming', status: 'completed', sale_id: null, supplier_name: null });
    expect(first.order_ref).toBe(receipts.receipts[0].orderRef);
    expect(first.amount).toBe(receipts.receipts[0].amountCents);
    expect(['cash', 'mobile_money', 'bank_transfer']).toContain(first.method);
  });

  it('maps every receipt method onto a method the page knows', () => {
    const m = (method) => adaptReceipt({ ...receipts.receipts[0], method }).method;
    expect([m('mpesa_paybill'), m('cash'), m('bank'), m('organization_remittance')]).toEqual(['mobile_money', 'cash', 'bank_transfer', 'bank_transfer']);
  });

  it('has nothing outgoing (supplier payments are expenses) and does not ask the server for it', async () => {
    const get = vi.spyOn(client, 'get');
    const res = await newPaymentsApi.list({ direction: 'outgoing' });
    expect(res.data.data).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('summarises receipts by method, all incoming', async () => {
    vi.spyOn(client, 'get').mockReturnValue(ok(receipts));
    const res = await newPaymentsApi.summary();
    expect(res.data.data.by_method.every((r) => r.direction === 'incoming')).toBe(true);
    expect(res.data.data.by_method.reduce((s, r) => s + r.total, 0)).toBe(receipts.summary.byMethod.reduce((s, r) => s + r.totalCents, 0));
  });

  it('refuses to record or refund a payment from this list, saying where that is done', async () => {
    for (const call of [() => newPaymentsApi.create({}), () => newPaymentsApi.refund(1)]) {
      const e = await call().catch((x) => x);
      expect(e.response.data.error.code).toBe('PAYMENT_ELSEWHERE');
      expect(getErrorMessage(e, 'x')).toMatch(/Payment reconciliation/);
    }
  });
});

describe('Payment reconciliation', () => {
  it('lists what is waiting in the shape the page reads, with the total still unallocated', async () => {
    vi.spyOn(client, 'get').mockReturnValue(ok(suspense));
    const res = await newPaymentReconciliationApi.unmatched({ page: 1, pageSize: 25 });
    const row = res.data.data[0];
    expect(row).toMatchObject({ id: suspense.items[0].exceptionId, source: 'mpesa', payer_name: 'A friend', external_reference: 'FIX0000002', amount: 500_000, matched_code: null });
    expect(res.data.total).toBe(suspense.items.length);
    expect(res.data.summary.unallocated).toBe(500_000);
  });

  it('pages the waiting list itself, because the server hands over all of it', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ ...suspense.items[0], exceptionId: i + 1, remainingCents: 100 }));
    vi.spyOn(client, 'get').mockReturnValue(ok({ items }));
    const p2 = await newPaymentReconciliationApi.unmatched({ page: 2, pageSize: 25 });
    expect(p2.data.data.map((r) => r.id)).toEqual([26, 27, 28, 29, 30]);
    expect(p2.data.total).toBe(30);
    expect(p2.data.totalPages).toBe(2);
    expect(p2.data.summary.unallocated).toBe(3000);
  });

  it('shows what is still owed on a part-resolved item, and the order whose code was quoted but could not take it', () => {
    const row = adaptSuspense({ ...suspense.items[0], kind: 'excess', amountCents: 500_000, remainingCents: 120_000, intendedOrderRef: 'UT-7K49M2XQ' });
    expect(row).toMatchObject({ amount: 120_000, original_amount: 500_000, kind: 'excess', matched_code: 'UT-7K49M2XQ' });
  });

  it('matches by posting the order reference to the suspense item', async () => {
    const post = vi.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });
    await newPaymentReconciliationApi.match(7, 'UT-7K49M2XQ');
    expect(post).toHaveBeenCalledWith('/payments/suspense/7/apply', { orderRef: 'UT-7K49M2XQ' });
  });

  it('turns Ignore into a refund and insists on a reason, before anything is sent', async () => {
    const post = vi.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });
    for (const notes of [undefined, '', '   ']) {
      const e = await newPaymentReconciliationApi.ignore(7, notes).catch((x) => x);
      expect(e.response.data.error.code).toBe('REFUND_REASON_REQUIRED');
    }
    expect(post).not.toHaveBeenCalled();
    await newPaymentReconciliationApi.ignore(7, '  Paid by mistake ');
    expect(post).toHaveBeenCalledWith('/payments/suspense/7/refund', { reason: 'Paid by mistake' });
  });

  it('suggests orders by phone number and exact amount', async () => {
    const get = vi.spyOn(client, 'get').mockReturnValue(ok(suggestions));
    const res = await newPaymentReconciliationApi.suggestions(3);
    expect(get).toHaveBeenCalledWith('/payments/suspense/3/suggestions');
    expect(res.data.data[0]).toMatchObject({ id: suggestions.suggestions[0].orderRef, outstanding: suggestions.suggestions[0].balanceCents });
    expect(res.data.data[0].exact_amount).toBe(suggestions.suggestions[0].reasons.includes('exact_amount'));
  });
});

describe('cash held by staff', () => {
  it('lists the open records and deposits one', async () => {
    vi.spyOn(client, 'get').mockReturnValue(ok(custody));
    const post = vi.spyOn(client, 'post').mockResolvedValue({ status: 200, data: { amountCents: 100_000 } });
    const res = await newCustodyApi.list();
    expect(res.data.data[0]).toMatchObject({ id: custody.records[0].id, holder: custody.records[0].holder, order_id: custody.records[0].orderRef, amount: 100_000 });
    await newCustodyApi.deposit(custody.records[0].id);
    expect(post).toHaveBeenCalledWith(`/custody/${custody.records[0].id}/deposit`, {});
  });
});
