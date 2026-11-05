const { request, app, db, auth, admin, newProduct, cached, mark, movementsSince, expectLedgerBalanced } = require('./helpers');
const { cleanupTestDb } = require('../setup');

afterAll(() => cleanupTestDb());

let A; // { token, userId, mainId }
let outletId;
beforeAll(async () => {
  A = await admin();
  outletId = (await request(app).post('/api/stores').set(auth(A.token)).send({ name: 'Characterization Outlet', address: 'Karen' })).body.data.id;
});

describe('R0 characterization: sales (till)', () => {
  it('cash sale: totals, payment rows, ledger row and cache all agree', async () => {
    const pid = newProduct({ cost: 300, sell: 500, stock: 10 });
    const m = mark();
    const res = await request(app).post('/api/sales').set(auth(A.token))
      .send({ items: [{ product_id: pid, quantity: 3 }], payments: [{ method: 'cash', amount: 1500 }] });
    expect(res.status).toBe(201);
    const sale = db.prepare('SELECT subtotal, tax_total, discount_total, total, payment_method, status FROM sales WHERE id = ?').get(res.body.data.id);
    expect(sale).toEqual({ subtotal: 1500, tax_total: 0, discount_total: 0, total: 1500, payment_method: 'cash', status: 'completed' });
    expect(db.prepare('SELECT method, amount FROM payments WHERE sale_id = ?').all(res.body.data.id)).toEqual([{ method: 'cash', amount: 1500 }]);
    expect(db.prepare('SELECT quantity, unit_price, line_total, cost_total FROM sale_items WHERE sale_id = ?').get(res.body.data.id))
      .toEqual({ quantity: 3, unit_price: 500, line_total: 1500, cost_total: expect.any(Number) });
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: -3, reason: 'sale', ref: null }]);
    expect(cached(pid)).toBe(7);
    expectLedgerBalanced(pid);
  });

  it('split payment: two payment rows that add up exactly to the total', async () => {
    const pid = newProduct({ sell: 700, stock: 5 });
    const res = await request(app).post('/api/sales').set(auth(A.token))
      .send({ items: [{ product_id: pid, quantity: 2 }], payments: [{ method: 'cash', amount: 1000 }, { method: 'mobile_money', amount: 400, reference: 'QWE123' }] });
    expect(res.status).toBe(201);
    const sale = db.prepare('SELECT total, payment_method FROM sales WHERE id = ?').get(res.body.data.id);
    expect(sale).toEqual({ total: 1400, payment_method: 'split' });
    const sum = db.prepare('SELECT SUM(amount) AS s FROM payments WHERE sale_id = ?').get(res.body.data.id).s;
    expect(sum).toBe(1400);
  });

  it('void: restores stock with a "void" ledger row, marks the sale voided, and cannot repeat', async () => {
    const pid = newProduct({ sell: 500, stock: 10 });
    const sale = (await request(app).post('/api/sales').set(auth(A.token))
      .send({ items: [{ product_id: pid, quantity: 4 }], payments: [{ method: 'cash', amount: 2000 }] })).body.data;
    const m = mark();
    const v = await request(app).post(`/api/sales/${sale.id}/void`).set(auth(A.token));
    expect(v.status).toBe(200);
    expect(db.prepare('SELECT status, total FROM sales WHERE id = ?').get(sale.id)).toEqual({ status: 'voided', total: 2000 });
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: 4, reason: 'void', ref: null }]);
    expect(cached(pid)).toBe(10);
    expect((await request(app).post(`/api/sales/${sale.id}/void`).set(auth(A.token))).status).toBe(409);
    expect(cached(pid)).toBe(10);
    expectLedgerBalanced(pid);
  });

  it('refused sale changes nothing: insufficient stock leaves cache, ledger and sales untouched', async () => {
    const pid = newProduct({ stock: 2 });
    const m = mark();
    const salesBefore = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
    const res = await request(app).post('/api/sales').set(auth(A.token))
      .send({ items: [{ product_id: pid, quantity: 3 }], payments: [{ method: 'cash', amount: 1500 }] });
    expect(res.status).toBe(409);
    expect(movementsSince(m, pid)).toEqual([]);
    expect(cached(pid)).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS c FROM sales').get().c).toBe(salesBefore);
  });

  it('offline retry: the same client_sale_id returns the same sale and deducts stock once', async () => {
    const pid = newProduct({ sell: 500, stock: 6 });
    const body = { clientSaleId: `char-${Date.now()}`, items: [{ product_id: pid, quantity: 2 }], payments: [{ method: 'cash', amount: 1000 }] };
    const first = await request(app).post('/api/sales').set(auth(A.token)).send(body);
    const again = await request(app).post('/api/sales').set(auth(A.token)).send(body);
    expect([first.status, again.status].every((s) => s === 200 || s === 201)).toBe(true);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(cached(pid)).toBe(4);
    expectLedgerBalanced(pid);
  });
});

describe('R0 characterization: manual adjustment, issue, receipt', () => {
  it('adjust: applies the signed change and records it as an "adjustment" row', async () => {
    const pid = newProduct({ stock: 10 });
    const m = mark();
    const res = await request(app).post('/api/inventory/adjust').set(auth(A.token))
      .send({ product_id: pid, change_qty: -3, reason: 'adjustment' });
    expect([200, 201]).toContain(res.status);
    expect(cached(pid)).toBe(7);
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: -3, reason: 'adjustment', ref: null }]);
    expectLedgerBalanced(pid);
  });

  it('receipt: adds stock with a "receipt" row and keeps the buying price on the batch', async () => {
    const pid = newProduct({ stock: 0 });
    const m = mark();
    const res = await request(app).post('/api/stock/receipts').set(auth(A.token))
      .send({ items: [{ product_id: pid, quantity: 20, unit_cost: 250 }] });
    expect(res.status).toBe(201);
    expect(cached(pid)).toBe(20);
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: 20, reason: 'receipt', ref: 'receipt' }]);
    expect(db.prepare('SELECT quantity, unit_cost FROM stock_receipt_items WHERE product_id = ?').get(pid)).toEqual({ quantity: 20, unit_cost: 250 });
    expectLedgerBalanced(pid);
  });

  it('issue: removes stock with an "issue" row; cannot issue more than is held', async () => {
    const pid = newProduct({ stock: 5 });
    await request(app).post('/api/stock/receipts').set(auth(A.token)).send({ items: [{ product_id: pid, quantity: 5, unit_cost: 100 }] });
    const m = mark();
    const ok = await request(app).post('/api/stock/issues').set(auth(A.token)).send({ product_id: pid, quantity: 4, reason: 'damaged', note: 'water' });
    expect(ok.status).toBe(201);
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: -4, reason: 'issue', ref: 'issue' }]);
    expect(cached(pid)).toBe(6);
    const tooMany = await request(app).post('/api/stock/issues').set(auth(A.token)).send({ product_id: pid, quantity: 99, reason: 'lost' });
    expect(tooMany.status).toBe(409);
    expect(cached(pid)).toBe(6);
    expectLedgerBalanced(pid);
  });
});

describe('R0 characterization: transfers, counts, requisitions', () => {
  it('transfer: nothing moves on request; approval writes one out row and one in row', async () => {
    const pid = newProduct({ stock: 12 });
    const req = await request(app).post('/api/stock/transfers').set(auth(A.token)).send({ to_store_id: outletId, items: [{ product_id: pid, quantity: 5 }] });
    expect(req.status).toBe(201);
    const m = mark();
    expect(cached(pid)).toBe(12);
    const ap = await request(app).post(`/api/stock/transfers/${req.body.data.id}/approve`).set(auth(A.token));
    expect(ap.status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([
      { store_id: A.mainId, change: -5, reason: 'transfer_out', ref: 'transfer' },
      { store_id: outletId, change: 5, reason: 'transfer_in', ref: 'transfer' },
    ]);
    expect(cached(pid)).toBe(7);
    expect(cached(pid, outletId)).toBe(5);
    expectLedgerBalanced(pid, [A.mainId, outletId]);
  });

  it('transfer rejected: no stock moves', async () => {
    const pid = newProduct({ stock: 8 });
    const req = await request(app).post('/api/stock/transfers').set(auth(A.token)).send({ to_store_id: outletId, items: [{ product_id: pid, quantity: 3 }] });
    const m = mark();
    expect((await request(app).post(`/api/stock/transfers/${req.body.data.id}/reject`).set(auth(A.token)).send({ note: 'no' })).status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([]);
    expect(cached(pid)).toBe(8);
  });

  it('count: variance is fixed at submission; approving with adjustments posts a "stocktake" row', async () => {
    const pid = newProduct({ stock: 10 });
    const sub = await request(app).post('/api/stock/counts').set(auth(A.token)).send({ kind: 'closing', items: [{ product_id: pid, counted_qty: 7 }] });
    expect(sub.status).toBe(201);
    expect(db.prepare('SELECT expected_qty, counted_qty, variance FROM stock_count_items WHERE product_id = ?').get(pid)).toEqual({ expected_qty: 10, counted_qty: 7, variance: -3 });
    expect(cached(pid)).toBe(10);
    const m = mark();
    const ap = await request(app).post(`/api/stock/counts/${sub.body.data.id}/approve`).set(auth(A.token)).send({ apply_adjustments: true });
    expect(ap.status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: -3, reason: 'stocktake', ref: 'stocktake' }]);
    expect(cached(pid)).toBe(7);
    expectLedgerBalanced(pid);
  });

  it('count approved without adjustments: stock is left as it was', async () => {
    const pid = newProduct({ stock: 10 });
    const sub = await request(app).post('/api/stock/counts').set(auth(A.token)).send({ kind: 'opening', items: [{ product_id: pid, counted_qty: 9 }] });
    const m = mark();
    await request(app).post(`/api/stock/counts/${sub.body.data.id}/approve`).set(auth(A.token)).send({ apply_adjustments: false });
    expect(movementsSince(m, pid)).toEqual([]);
    expect(cached(pid)).toBe(10);
  });

  it('requisition: approving adds only the approved quantity as a "requisition" row', async () => {
    const pid = newProduct({ stock: 0 });
    const r = await request(app).post('/api/requisitions').set(auth(A.token)).send({ signed_name: 'Store Admin', items: [{ product_id: pid, quantity_requested: 10 }] });
    expect(r.status).toBe(201);
    const m = mark();
    const ap = await request(app).patch(`/api/requisitions/${r.body.data.id}/approve`).set(auth(A.token)).send({ items: [{ product_id: pid, quantity_approved: 6 }] });
    expect(ap.status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: 6, reason: 'requisition', ref: null }]);
    expect(cached(pid)).toBe(6);
    expectLedgerBalanced(pid);
  });
});
