import client from '../client';
import { AdapterError, mapResponse, toLegacyPage, toLimitOffset } from './common';

// Finance, Payments tab and the Reconciliation page, on the new server.
//
// What the legacy screens call a "payment" is, on the new engine, a receipt: money booked against an order. Receipts are read-only
// here. A payment arrives by itself (paybill, KCB, an organization's remittance, cash taken at the shop) and is matched to an order;
// one that cannot be matched waits in suspense, and a wrong one is corrected by refunding it, never by editing it. So:
//   - the Payments tab lists receipts (incoming only: supplier payments are expenses, which come with the Expenses tab);
//   - Reconciliation lists suspense, matches an item to an order, and "Ignore" becomes a refund with a required reason;
//   - cash taken at the shop is held by the staff member until it is deposited (custody).

/** The legacy page knows four payment methods; the new engine has four of its own. */
const METHOD = { mpesa_paybill: 'mobile_money', organization_remittance: 'bank_transfer', bank: 'bank_transfer', cash: 'cash' };

export function adaptReceipt(r) {
  return {
    id: r.id,
    created_at: r.issuedAt,
    direction: 'incoming',
    sale_id: null,
    order_id: r.orderRef,
    order_ref: r.orderRef,
    supplier_name: null,
    method: METHOD[r.method] || 'bank_transfer',
    amount: r.amountCents,
    status: 'completed',
    reference: r.externalRef,
    receipt_no: r.receiptNo,
    recorded_by: r.actor,
  };
}

const REFUND_NOT_HERE = 'A payment cannot be recorded or refunded from this list. Payments are matched to orders as they arrive; a wrong one is refunded from Payment reconciliation.';

export const newPaymentsApi = {
  list: (params = {}) => {
    const { page, pageSize, limit, direction, method, search } = params;
    const size = pageSize ?? limit;
    // Money paid out to suppliers is an expense, not a receipt, so the outgoing view is empty on the new server.
    if (direction === 'outgoing') return Promise.resolve({ status: 200, data: toLegacyPage([], 0, { page, pageSize: size }) });
    const legacyMethod = { mobile_money: 'mpesa_paybill', cash: 'cash' }[method];
    const q = { ...toLimitOffset({ page, pageSize: size }), method: legacyMethod, search: search || undefined };
    return mapResponse(client.get('/payments', { params: q }), (d) => toLegacyPage(d.receipts.map(adaptReceipt), d.total, { page, pageSize: q.limit }));
  },
  summary: () => mapResponse(client.get('/payments', { params: { limit: 1 } }), (d) => ({
    data: { by_method: d.summary.byMethod.map((m) => ({ direction: 'incoming', method: METHOD[m.method] || 'bank_transfer', total: m.totalCents, count: m.count })) },
  })),
  create: () => Promise.reject(new AdapterError('PAYMENT_ELSEWHERE', REFUND_NOT_HERE)),
  refund: () => Promise.reject(new AdapterError('PAYMENT_ELSEWHERE', REFUND_NOT_HERE)),
};

/** One suspense item as the Reconciliation page reads an unmatched payment. `id` is the suspense item's id, which is what match and refund take. */
export function adaptSuspense(i) {
  return {
    id: i.exceptionId,
    created_at: i.createdAt,
    source: 'mpesa',
    payer_name: i.payerName,
    payer_phone: i.msisdn,
    external_reference: i.transCode,
    amount: i.remainingCents,
    original_amount: i.amountCents,
    kind: i.kind, // 'unmatched' (no usable code) or 'excess' (more than the order needed)
    // A code was quoted and found, but that order could not take the money (already paid, cancelled): the page says so under the reference.
    matched_code: i.intendedOrderRef || null,
  };
}

export const newPaymentReconciliationApi = {
  // The server hands over the whole waiting list (it is short by nature: every item needs a decision), so paging is done here.
  unmatched: (params = {}) => {
    const size = params.pageSize ?? params.limit ?? 25;
    const page = params.page ?? 1;
    return mapResponse(client.get('/payments/suspense'), (d) => {
      const all = d.items.map(adaptSuspense);
      return { ...toLegacyPage(all.slice((page - 1) * size, page * size), all.length, { page, pageSize: size }), summary: { unallocated: all.reduce((s, r) => s + r.amount, 0) } };
    });
  },
  match: (id, orderId) => client.post(`/payments/suspense/${encodeURIComponent(String(id))}/apply`, { orderRef: String(orderId) }),
  // Legacy "ignore" dropped a payment from the list. The new engine never drops money: it sends it back, and says why.
  ignore: (id, notes) => {
    if (!notes || !String(notes).trim()) return Promise.reject(new AdapterError('REFUND_REASON_REQUIRED', 'Say why this payment is being refunded.'));
    return client.post(`/payments/suspense/${encodeURIComponent(String(id))}/refund`, { reason: String(notes).trim() });
  },
  /** Orders this money probably belongs to: the same phone number, or owing exactly this amount. Never applied automatically. */
  suggestions: (id) => mapResponse(client.get(`/payments/suspense/${encodeURIComponent(String(id))}/suggestions`), (d) => ({
    data: d.suggestions.map((s) => ({ id: s.orderRef, customer_name: s.customerName, outstanding: s.balanceCents, same_phone: s.reasons.includes('same_phone'), exact_amount: s.reasons.includes('exact_amount') })),
  })),
};

/** Cash taken at the shop, held by whoever took it until it is deposited or handed to the till. */
export const newCustodyApi = {
  list: () => mapResponse(client.get('/custody'), (d) => ({
    data: d.records.map((r) => ({ id: r.id, holder: r.holder, order_id: r.orderRef, amount: r.amountCents, receipt_no: r.receiptNo, opened_at: r.openedAt })),
  })),
  deposit: (id) => client.post(`/custody/${encodeURIComponent(String(id))}/deposit`, {}),
};
