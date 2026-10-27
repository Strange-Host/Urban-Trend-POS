import { describe, it, expect, vi, afterEach } from 'vitest';
import client, { getErrorMessage } from '../client';
import { newOrdersApi, legacyStatus, adaptOrderSummary, adaptOrderDetail, describeEvent, statusFilter, PAYMENT_ELSEWHERE } from './orders';
import { newCouriersApi } from './couriers';
import list from './__fixtures__/orders-list.json';
import out from './__fixtures__/order-out-for-delivery.json';
import returned from './__fixtures__/order-returned.json';
import couriers from './__fixtures__/couriers-list.json';

// Fixtures are recorded answers of the real new server (server/tests/contractFixtures.test.ts keeps them honest).
afterEach(() => { vi.restoreAllMocks(); });

describe('the one status the legacy page shows', () => {
  const o = (status, extra = {}) => ({ status, paymentStatus: 'unpaid', ...extra });
  it('combines delivery and payment for parcels that have left the shop', () => {
    expect(legacyStatus(o('awaiting_dispatch'))).toBe('awaiting_dispatch');
    expect(legacyStatus(o('cancelled'))).toBe('cancelled');
    for (const status of ['dispatched', 'delivered']) {
      expect(legacyStatus(o(status, { paymentStatus: 'unpaid' }))).toBe('dispatched_unpaid');
      expect(legacyStatus(o(status, { paymentStatus: 'part_paid' }))).toBe('dispatched_partial');
      expect(legacyStatus(o(status, { paymentStatus: 'paid' }))).toBe('dispatched_paid');
    }
  });
  it('shows a returning parcel as in transit and a counted-in one as resellable or damaged', () => {
    expect(legacyStatus(o('returning'))).toBe('returned_in_transit');
    expect(legacyStatus(o('returned', { returnProblem: false }))).toBe('returned_resellable');
    expect(legacyStatus(o('returned', { returnProblem: true }))).toBe('returned_damaged');
    expect(legacyStatus(o('returned', { returned: { damaged: 0, missing: 2 } }))).toBe('returned_damaged'); // missing goods count as a problem too
  });
});

describe('the order list rows', () => {
  it('use the reference as the id, snake_case fields and what is still owed', () => {
    const rows = list.orders.map(adaptOrderSummary);
    const r = rows.find((x) => x.status === 'dispatched_unpaid');
    expect(r).toMatchObject({ channel: 'manual', customer_name: 'Wanjiku', total: 500_000, amount_paid: 0, outstanding: 500_000, dispute_status: null });
    expect(r.id).toBe(r.product_code);
    expect(r.id).toMatch(/^UT-/);
    expect(r.courier_name).toBe('Peter Rider');
  });
  it('owe nothing once returned or cancelled, whatever the ledger says', () => {
    const back = list.orders.map(adaptOrderSummary).find((x) => x.status.startsWith('returned'));
    expect(back.status).toBe('returned_damaged');
    expect(back.outstanding).toBe(0);
  });
});

describe('one order, in full', () => {
  it('reads like the legacy detail: customer, items, courier, totals, payment type and confirmation', () => {
    const d = adaptOrderDetail(out.order);
    expect(d).toMatchObject({ status: 'dispatched_unpaid', delivery_status: 'dispatched', total: 500_000, amount_paid: 0, outstanding: 500_000, payment_type: 'cod', delivery_fee: 0, package_fee: 30_000 });
    expect(d.customer).toMatchObject({ name: 'Wanjiku', phone: '0755000001' });
    expect(d.items[0]).toMatchObject({ quantity: 2, product_name: 'Canvas shoe', line_total: 500_000 });
    expect(d.courier.name).toBe('Peter Rider');
    expect(d.cod_confirmed_at).toBeTruthy();
    expect(d.id).toBe(out.order.orderRef);
  });
  it('describes every event in words, in order, using the page\'s own history format (same from and to means "print the note")', () => {
    const d = adaptOrderDetail(returned.order);
    expect(d.status_history.map((h) => h.notes)).toEqual([
      'Order created', 'Confirmed with the customer', 'Dispatched with Peter Rider (package fee KES 300)',
      'Refused: Customer rejected the parcel', 'Parcel is coming back', 'Returned parcel counted in: 1 restocked, 1 damaged, 0 missing',
    ]);
    for (const h of d.status_history) { expect(h.from_status).toBe(h.to_status); expect(h.changed_by_name).toBeTruthy(); }
  });
  it('carries what came back, and treats an order with money in as prepaid', () => {
    const d = adaptOrderDetail(returned.order);
    expect(d.status).toBe('returned_damaged');
    expect(d.returned).toMatchObject({ restocked: 1, damaged: 1, missing: 0, notes: 'One pair scuffed' });
    expect(adaptOrderDetail({ ...out.order, paidCents: 100_000, paymentStatus: 'part_paid', balanceCents: 400_000 })).toMatchObject({ payment_type: 'prepaid', status: 'dispatched_partial', outstanding: 400_000 });
  });
  it('words payment events with amounts', () => {
    expect(describeEvent({ type: 'shop_cash_recorded', data: { amount_cents: 150_000, reason: 'Paid at the counter' } })).toBe('Cash taken at the shop (KES 1,500): Paid at the counter');
    expect(describeEvent({ type: 'something_new', data: {} })).toBe('something new');
  });
});

describe('asking the new server for a list', () => {
  const reply = { data: { orders: list.orders, total: 3, summary: { outstandingCents: 500_000 } } };
  it('turns page and pageSize into limit and offset and answers in the legacy list shape, with the outstanding total', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue(reply);
    const res = await newOrdersApi.list({ page: 3, pageSize: 25, search: 'Wanj' });
    expect(get).toHaveBeenCalledWith('/orders', { params: expect.objectContaining({ limit: 25, offset: 50, search: 'Wanj' }) });
    expect(res.data).toMatchObject({ page: 3, pageSize: 25, total: 3, totalPages: 1, summary: { outstanding: 500_000 } });
    expect(res.data.data).toHaveLength(list.orders.length);
    expect(res.data.data[0].id).toMatch(/^UT-/);
  });
  it('maps each legacy status filter to the new server\'s filters', () => {
    expect(statusFilter('')).toEqual({});
    expect(statusFilter('dispatched_partial')).toEqual({ status: 'dispatched,delivered', paymentStatus: 'part_paid' });
    expect(statusFilter('returned_damaged')).toEqual({ status: 'returned', returnProblem: 'true' });
    expect(statusFilter('returned_resellable')).toEqual({ status: 'returned', returnProblem: 'false' });
    expect(statusFilter('returned_in_transit')).toEqual({ status: 'returning' });
    expect(statusFilter('returned_awaiting_inspection')).toBeNull();
  });
  it('answers an empty page, without asking, for a state that no longer exists and for online channels not connected yet', async () => {
    const get = vi.spyOn(client, 'get');
    for (const p of [{ status: 'returned_awaiting_inspection' }, { channel: 'shopify' }, { channel: 'wordpress' }]) {
      const res = await newOrdersApi.list({ page: 1, pageSize: 50, ...p });
      expect(res.data).toMatchObject({ data: [], total: 0, totalPages: 1, summary: { outstanding: 0 } });
    }
    expect(get).not.toHaveBeenCalled();
  });
  it('addresses one order by its reference, encoded', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: out });
    const res = await newOrdersApi.get('UT-AB CD');
    expect(get).toHaveBeenCalledWith('/orders/UT-AB%20CD');
    expect(res.data.data.status).toBe('dispatched_unpaid');
  });
});

describe('what the buttons do', () => {
  const post = () => vi.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });

  it('confirms with the customer', async () => {
    const p = post();
    await newOrdersApi.confirmCod('UT-1');
    expect(p).toHaveBeenCalledWith('/orders/UT-1/confirm', {});
  });

  it('will not dispatch without a chosen courier or without a fee, and says so in words', async () => {
    const p = post();
    let err = await newOrdersApi.dispatch('UT-2', { packageFee: { cents: 30_000 } }).catch((e) => e);
    expect(getErrorMessage(err)).toMatch(/Choose the rider or organization/);
    await newOrdersApi.assignCourier('UT-2', 7);
    err = await newOrdersApi.dispatch('UT-2', {}).catch((e) => e);
    expect(getErrorMessage(err)).toMatch(/package fee/);
    err = await newOrdersApi.dispatch('UT-2', { packageFee: { cents: -5 } }).catch((e) => e);
    expect(err.response.data.error.code).toBe('DISPATCH_NEEDS_FEE');
    expect(p).not.toHaveBeenCalled();
  });

  it('dispatches with the chosen courier and the typed fee in cents, then forgets the choice', async () => {
    const p = post();
    await newOrdersApi.assignCourier('UT-3', '9');
    await newOrdersApi.dispatch('UT-3', { packageFee: { cents: 30_000 } });
    expect(p).toHaveBeenCalledWith('/orders/UT-3/dispatch', { courierId: 9, packageFee: { amountCents: 30_000 } });
    const again = await newOrdersApi.dispatch('UT-3', { packageFee: { cents: 30_000 } }).catch((e) => e);
    expect(again.response.data.error.code).toBe('DISPATCH_NEEDS_COURIER');
  });

  it('keeps the chosen courier when the dispatch fails, so the person can fix the fee and try again', async () => {
    vi.spyOn(client, 'post').mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 422, data: { error: { code: 'VALIDATION', message: 'bad' } } } }));
    await newOrdersApi.assignCourier('UT-4', 3);
    await newOrdersApi.dispatch('UT-4', { packageFee: { cents: 100 } }).catch(() => null);
    const p = post();
    await newOrdersApi.dispatch('UT-4', { packageFee: { cents: 100 } });
    expect(p).toHaveBeenCalledWith('/orders/UT-4/dispatch', expect.objectContaining({ courierId: 3 }));
  });

  it('sends a zero fee with its reason', async () => {
    const p = post();
    await newOrdersApi.assignCourier('UT-5', 1);
    await newOrdersApi.dispatch('UT-5', { packageFee: { cents: 0, zeroReason: 'Collected by the customer' } });
    expect(p).toHaveBeenCalledWith('/orders/UT-5/dispatch', { courierId: 1, packageFee: { amountCents: 0, zeroReason: 'Collected by the customer' } });
  });

  it('cancels with the reason, records outcomes, and counts a returned parcel in', async () => {
    const p = post();
    await newOrdersApi.cancel('UT-6', 'Customer changed their mind');
    await newOrdersApi.recordOutcome('UT-6', { outcome: 'rescheduled', reason: 'Phone off', rescheduleFor: '2026-11-02' });
    await newOrdersApi.recordOutcome('UT-6', { outcome: 'delivered' });
    await newOrdersApi.receiveReturn('UT-6', { items: [{ orderItemId: 1, restockQuantity: 1, damagedQuantity: 1 }], notes: 'scuffed' });
    expect(p.mock.calls).toEqual([
      ['/orders/UT-6/cancel', { reason: 'Customer changed their mind' }],
      ['/orders/UT-6/attempts', { outcome: 'rescheduled', reason: 'Phone off', rescheduleFor: '2026-11-02' }],
      ['/orders/UT-6/attempts', { outcome: 'delivered' }],
      ['/orders/UT-6/returned', { items: [{ orderItemId: 1, restockQuantity: 1, damagedQuantity: 1 }], notes: 'scuffed' }],
    ]);
  });

  it('turns "parcel is coming back" into a refused delivery with the reason in words', async () => {
    const p = post();
    await newOrdersApi.returnedInTransit('UT-7', { reason_code: 'wrong_item' });
    await newOrdersApi.returnedInTransit('UT-7', {});
    expect(p.mock.calls[0][1]).toEqual({ outcome: 'refused', reason: 'Wrong item sent' });
    expect(p.mock.calls[1][1].outcome).toBe('refused');
  });

  it('records cash taken at the shop, and refuses to type in any other payment', async () => {
    const p = post();
    await newOrdersApi.recordPayment('UT-8', { method: 'cash', amount: 150_000, reference: 'Paid at the counter' });
    expect(p).toHaveBeenCalledWith('/orders/UT-8/shop-cash', { amountCents: 150_000, reason: 'Paid at the counter' });
    await newOrdersApi.recordPayment('UT-8', { method: 'cash', amount: 1000 });
    expect(p.mock.calls[1][1].reason).toBe('Cash paid at the shop');
    for (const method of ['mobile_money', 'bank_transfer', 'card']) {
      const err = await newOrdersApi.recordPayment('UT-8', { method, amount: 1000 }).catch((e) => e);
      expect(err.response.data.error.code).toBe('PAYMENT_ARRIVES_ELSEWHERE');
      expect(getErrorMessage(err)).toBe(PAYMENT_ELSEWHERE);
    }
    expect(p).toHaveBeenCalledTimes(2); // the refused ones never reached the server
  });

  it('adds items to an order: product details are read for the legacy { product_id, quantity } shape, and the order comes back grown', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: { product: { id: 5, sku: 'SOCK-1', name: 'Socks', priceCents: 40_000 } } });
    const p = vi.spyOn(client, 'post').mockResolvedValue({ status: 200, data: { order: out.order } });
    const res = await newOrdersApi.mergeItems('UT-10', [{ product_id: 5, quantity: 2 }, { sku: 'X-1', name: 'Typed', unit_price: 1000, quantity: 1 }]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/products/5');
    expect(p).toHaveBeenCalledWith('/orders/UT-10/items', { items: [
      { sku: 'SOCK-1', name: 'Socks', quantity: 2, unitPriceCents: 40_000 },
      { sku: 'X-1', name: 'Typed', quantity: 1, unitPriceCents: 1000 },
    ] });
    expect(res.data.data.id).toBe(out.order.orderRef);
    const none = await newOrdersApi.mergeItems('UT-10', []).catch((e) => e);
    expect(none.response.data.error.code).toBe('ORDER_NO_ITEMS');
  });

  it('rejects, clearly, what the new engine does not do (and never reaches a server)', async () => {
    const p = post();
    for (const name of ['setCourier', 'inspect', 'returnedAwaitingInspection', 'ownerDecision', 'openDispute', 'resolveDispute', 'pullOnline']) {
      const err = await newOrdersApi[name]('UT-9').catch((e) => e);
      expect(err.response.data.error.code, name).toBe('NOT_IMPLEMENTED_ON_NEW_SERVER');
    }
    expect(p).not.toHaveBeenCalled();
  });
});

describe('couriers for the picker', () => {
  it('reads like the legacy list, saying plainly whether each is a rider or an organization', async () => {
    vi.spyOn(client, 'get').mockResolvedValue({ data: couriers });
    const res = await newCouriersApi.list();
    const c = res.data.data[0];
    expect(c).toMatchObject({ name: 'Peter Rider', courier_label: 'Rider', is_active: 1 });
    expect(typeof c.id).toBe('number');
  });
  it('asks only for couriers that can take a dispatch', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: couriers });
    await newCouriersApi.list();
    expect(get).toHaveBeenCalledWith('/couriers', { params: { active: 'true' } });
  });
});
