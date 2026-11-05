const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');

let admin; let manager; let manager2; let cashier; let cashier2;
beforeAll(async () => {
  await H.loginAsAdmin();
  admin = await H.makeAdmin();
  manager = await H.makeUser('manager', 'st-mgr');
  manager2 = await H.makeUser('manager', 'st-mgr2');
  cashier = await H.makeUser('cashier', 'st-cashier');
  cashier2 = await H.makeUser('cashier', 'st-cashier2');
});
afterAll(() => cleanupTestDb());

const store = () => H.storeId();
const setQty = (productId, qty) => db.prepare(`INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?) ON CONFLICT(product_id, store_id) DO UPDATE SET quantity = excluded.quantity`).run(productId, store(), qty);
const qty = (productId) => db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, store()).quantity;
const movements = (takeId) => db.prepare(`SELECT * FROM inventory_movements WHERE reference_type = 'stocktake' AND reference_id = ? ORDER BY id`).all(takeId);
const start = (u, scope, note) => request(app).post('/api/v1/stock-takes').set(auth(u)).send({ scope, note });
const lines = (u, id, l) => request(app).post(`/api/v1/stock-takes/${id}/lines`).set(auth(u)).send({ lines: l });
const submit = (u, id) => request(app).post(`/api/v1/stock-takes/${id}/submit`).set(auth(u)).send({});

describe('draft', () => {
  it('needs stock.count (a user without it is refused) and is created per area, resuming the same sheet', async () => {
    const noCount = await H.makeUser('cashier', 'st-nocount'); H.revoke(noCount.id, 'stock.count');
    expect((await start(noCount, { type: 'all' })).status).toBe(403);

    const cat = H.makeCategory('ST');
    const a = await start(cashier, { type: 'category', categoryId: cat }, 'Shelf A');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: 'draft', scope: { type: 'category', categoryId: cat }, lineCount: 0 });
    const again = await start(cashier, { type: 'category', categoryId: cat });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(a.body.id);
    // another person gets their own sheet for the same area
    const other = await start(cashier2, { type: 'category', categoryId: cat });
    expect(other.status).toBe(201); expect(other.body.id).not.toBe(a.body.id);
    expect((await start(cashier, { type: 'category', categoryId: 999999 })).body.error.code).toBe('INVALID_CATEGORY');
    expect((await start(cashier, { type: 'category' })).status).toBe(400);
  });

  it('saves lines idempotently, shows live system stock, and 100 lines survive two calls and a fresh fetch', async () => {
    const cat = H.makeCategory('ST100');
    const ids = Array.from({ length: 100 }, (_, i) => { const p = H.makeProduct({ categoryId: cat }); setQty(p.id, 5); return p.id; });
    const t = await start(cashier, { type: 'category', categoryId: cat });
    const first = await lines(cashier, t.body.id, ids.slice(0, 60).map((id) => ({ productId: id, countedQty: 5 })));
    expect(first.status).toBe(200);
    // resend the same lines with a changed count: replaced, not duplicated
    const second = await lines(cashier, t.body.id, [...ids.slice(40).map((id) => ({ productId: id, countedQty: 5 })), { productId: ids[0], countedQty: 7 }]);
    expect(second.status).toBe(200);
    expect(second.body.lineCount).toBe(100);

    // "closing the app": fetch the sheet from scratch
    const fetched = await request(app).get(`/api/v1/stock-takes/${t.body.id}`).set(auth(cashier));
    expect(fetched.body.lines).toHaveLength(100);
    expect(fetched.body.lines.find((l) => l.productId === ids[0])).toMatchObject({ countedQty: 7, systemQty: 5, variance: 2 });
    // live while a draft: stock moving changes systemQty
    setQty(ids[1], 9);
    const live = await request(app).get(`/api/v1/stock-takes/${t.body.id}`).set(auth(cashier));
    expect(live.body.lines.find((l) => l.productId === ids[1])).toMatchObject({ systemQty: 9, variance: -4 });
  });

  it('rejects a line outside the area, an invalid count, and is all-or-nothing', async () => {
    const cat = H.makeCategory('STscope'); const other = H.makeCategory('STother');
    const mine = H.makeProduct({ categoryId: cat }); const foreign = H.makeProduct({ categoryId: other });
    const off = H.makeProduct({ categoryId: cat, active: 0 }); const online = H.makeProduct({ categoryId: cat, catalogue: 'online' });
    const t = await start(cashier, { type: 'category', categoryId: cat });
    const bad = await lines(cashier, t.body.id, [{ productId: mine.id, countedQty: 3 }, { productId: foreign.id, countedQty: 1 }]);
    expect(bad.status).toBe(422); expect(bad.body.error.code).toBe('NOT_IN_SCOPE');
    expect(db.prepare('SELECT COUNT(*) c FROM stock_take_lines WHERE take_id = ?').get(t.body.id).c).toBe(0);
    for (const p of [off, online]) expect((await lines(cashier, t.body.id, [{ productId: p.id, countedQty: 1 }])).status).toBe(422);
    expect((await lines(cashier, t.body.id, [{ productId: mine.id, countedQty: -1 }])).status).toBe(400);
    expect((await lines(cashier, t.body.id, [{ productId: mine.id, countedQty: 1.5 }])).status).toBe(400);
    expect((await lines(cashier, t.body.id, [])).status).toBe(400);
  });

  it('only the creator can change a draft, and others cannot even see it without stock.review', async () => {
    const cat = H.makeCategory('STowner'); const p = H.makeProduct({ categoryId: cat });
    const t = await start(cashier, { type: 'category', categoryId: cat });
    expect((await lines(cashier2, t.body.id, [{ productId: p.id, countedQty: 1 }])).status).toBe(403);
    expect((await request(app).get(`/api/v1/stock-takes/${t.body.id}`).set(auth(cashier2))).status).toBe(404);
    expect((await request(app).get(`/api/v1/stock-takes/${t.body.id}`).set(auth(manager))).status).toBe(200);   // a reviewer can look
    const mineOnly = await request(app).get('/api/v1/stock-takes').set(auth(cashier2));
    expect(mineOnly.body.items.find((i) => i.id === t.body.id)).toBeUndefined();
    const all = await request(app).get('/api/v1/stock-takes').set(auth(manager));
    expect(all.body.items.find((i) => i.id === t.body.id)).toBeTruthy();
  });
});

describe('finding products while counting', () => {
  it('resolves a scan or a name inside the sheet\'s area for a counter who cannot browse the catalog, never with cost', async () => {
    const cat = H.makeCategory('STscan'); const other = H.makeCategory('STscanOther');
    const mine = H.makeProduct({ categoryId: cat }); const foreign = H.makeProduct({ categoryId: other }); setQty(mine.id, 12);
    const bar = (id) => db.prepare('SELECT barcode, name FROM products WHERE id = ?').get(id);
    const t = await start(cashier, { type: 'category', categoryId: cat });
    const noCatalog = await request(app).get('/api/v1/products').set(auth(cashier));
    expect(noCatalog.status).toBe(403);                                  // the cashier really has no catalog access
    const hit = await request(app).get(`/api/v1/stock-takes/${t.body.id}/products?barcode=${bar(mine.id).barcode}`).set(auth(cashier));
    expect(hit.status).toBe(200);
    expect(hit.body.items).toEqual([{ productId: mine.id, name: bar(mine.id).name, sku: mine.sku, barcode: bar(mine.id).barcode, systemQty: 12 }]);
    expect(JSON.stringify(hit.body)).not.toMatch(/cost|margin/i);
    expect((await request(app).get(`/api/v1/stock-takes/${t.body.id}/products?barcode=${bar(foreign.id).barcode}`).set(auth(cashier))).body.items).toEqual([]);
    expect((await request(app).get(`/api/v1/stock-takes/${t.body.id}/products?q=${encodeURIComponent(bar(mine.id).name)}`).set(auth(cashier))).body.items).toHaveLength(1);
    expect((await request(app).get(`/api/v1/stock-takes/${t.body.id}/products`).set(auth(cashier))).body.items).toEqual([]);
    expect((await request(app).get(`/api/v1/stock-takes/${t.body.id}/products?q=a`).set(auth(cashier2))).status).toBe(404);   // someone else's sheet
  });
});

describe('submit', () => {
  it('applies small differences through the ledger (reason stocktake), leaves matches and uncounted products alone', async () => {
    const cat = H.makeCategory('STapply');
    const [short, over, same, untouched] = [1, 2, 3, 4].map(() => H.makeProduct({ categoryId: cat }).id);
    setQty(short, 10); setQty(over, 4); setQty(same, 6); setQty(untouched, 8);
    const t = await start(cashier, { type: 'category', categoryId: cat });
    await lines(cashier, t.body.id, [{ productId: short, countedQty: 7 }, { productId: over, countedQty: 9 }, { productId: same, countedQty: 6 }]);
    const r = await submit(cashier, t.body.id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('applied');
    expect(r.body.applied).toEqual(expect.arrayContaining([{ productId: short, variance: -3 }, { productId: over, variance: 5 }]));
    expect(r.body.pendingApproval).toEqual([]);
    expect(r.body.notCountedCount).toBe(1);
    expect(qty(short)).toBe(7); expect(qty(over)).toBe(9); expect(qty(same)).toBe(6);
    expect(qty(untouched)).toBe(8);                               // not counted is NOT zero
    const mv = movements(t.body.id);
    expect(mv).toHaveLength(2);
    expect(mv.every((m) => m.reason === 'stocktake' && m.created_by === cashier.id && m.store_id === store())).toBe(true);
    expect(mv.find((m) => m.product_id === short).change_qty).toBe(-3);

    // frozen at submit: later stock movement does not change what the sheet recorded
    setQty(short, 50);
    const detail = await request(app).get(`/api/v1/stock-takes/${t.body.id}`).set(auth(cashier));
    expect(detail.body.lines.find((l) => l.productId === short)).toMatchObject({ systemQty: 10, variance: -3, applied: true, needsApproval: false });
    expect(H.lastLog('stock_take', t.body.id).staff_id).toBe(cashier.id);
  });

  it('cannot be submitted empty or twice, and a submitted sheet cannot take more lines', async () => {
    const cat = H.makeCategory('STtwice'); const p = H.makeProduct({ categoryId: cat }); setQty(p.id, 3);
    const t = await start(cashier, { type: 'category', categoryId: cat });
    const empty = await submit(cashier, t.body.id);
    expect(empty.status).toBe(422); expect(empty.body.error.code).toBe('NO_LINES');
    await lines(cashier, t.body.id, [{ productId: p.id, countedQty: 2 }]);
    expect((await submit(cashier, t.body.id)).status).toBe(200);
    const again = await submit(cashier, t.body.id);
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('NOT_DRAFT');
    expect((await lines(cashier, t.body.id, [{ productId: p.id, countedQty: 9 }])).body.error.code).toBe('NOT_DRAFT');
    expect(qty(p.id)).toBe(2);                                   // applied exactly once
    expect(movements(t.body.id)).toHaveLength(1);
  });

  describe('big differences', () => {
    let big; let small; let t; let cat;
    beforeAll(async () => {
      cat = H.makeCategory('STbig');
      big = H.makeProduct({ categoryId: cat }).id; small = H.makeProduct({ categoryId: cat }).id;
      setQty(big, 40); setQty(small, 10);
      t = await start(cashier, { type: 'category', categoryId: cat });
      await lines(cashier, t.body.id, [{ productId: big, countedQty: 10 }, { productId: small, countedQty: 8 }]);   // -30 (needs approval), -2 (applies)
    });

    it('applies the small line now, holds the big one, and tells the reviewers', async () => {
      const r = await submit(cashier, t.body.id);
      expect(r.body.status).toBe('pending_approval');
      expect(r.body.applied).toEqual([{ productId: small, variance: -2 }]);
      expect(r.body.pendingApproval).toEqual([{ productId: big, variance: -30 }]);
      expect(qty(small)).toBe(8); expect(qty(big)).toBe(40);
      const note = db.prepare(`SELECT * FROM notifications WHERE type = 'stock_take_pending' AND entity_id = ? AND user_id = ?`).get(t.body.id, manager.id);
      expect(note).toBeTruthy();
      const detail = await request(app).get(`/api/v1/stock-takes/${t.body.id}`).set(auth(manager));
      expect(detail.body.needsApprovalCount).toBe(1);
      expect(detail.body.lines.find((l) => l.productId === big)).toMatchObject({ needsApproval: true, applied: false });
    });

    it('the person who counted cannot decide it, a cashier cannot, another manager can', async () => {
      const own = await request(app).post(`/api/v1/stock-takes/${t.body.id}/approve`).set(auth(cashier)).send({});
      expect(own.status).toBe(403);                              // no stock.review at all
      H.grant(cashier.id, 'stock.review');
      const self = await request(app).post(`/api/v1/stock-takes/${t.body.id}/approve`).set(auth(cashier)).send({});
      expect(self.status).toBe(403); expect(self.body.error.code).toBe('SELF_APPROVAL');
      expect(qty(big)).toBe(40);
      const ok = await request(app).post(`/api/v1/stock-takes/${t.body.id}/approve`).set(auth(manager2)).send({ note: 'Recounted, agreed' });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('applied');
      expect(qty(big)).toBe(10);
      expect(movements(t.body.id).filter((m) => m.product_id === big)).toHaveLength(1);
      expect(H.lastLog('stock_take', t.body.id).changes.reason.to).toBe('Recounted, agreed');
      const again = await request(app).post(`/api/v1/stock-takes/${t.body.id}/approve`).set(auth(manager2)).send({});
      expect(again.status).toBe(409); expect(again.body.error.code).toBe('NOT_PENDING');
    });

    it('a rejection needs a reason and applies nothing more', async () => {
      const c2 = H.makeCategory('STrej'); const p = H.makeProduct({ categoryId: c2 }).id; setQty(p, 50);
      const t2 = await start(cashier2, { type: 'category', categoryId: c2 });
      await lines(cashier2, t2.body.id, [{ productId: p, countedQty: 5 }]);
      expect((await submit(cashier2, t2.body.id)).body.status).toBe('pending_approval');
      expect((await request(app).post(`/api/v1/stock-takes/${t2.body.id}/reject`).set(auth(manager)).send({})).status).toBe(400);
      const rej = await request(app).post(`/api/v1/stock-takes/${t2.body.id}/reject`).set(auth(manager)).send({ reason: 'Count looks wrong, redo it' });
      expect(rej.status).toBe(200); expect(rej.body.status).toBe('rejected');
      expect(qty(p)).toBe(50);
      expect(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'stock_take_rejected' AND user_id = ? AND entity_id = ?`).get(cashier2.id, t2.body.id).c).toBe(1);
    });

    it('an admin may decide their own count', async () => {
      const c3 = H.makeCategory('STadmin'); const p = H.makeProduct({ categoryId: c3 }).id; setQty(p, 30);
      const t3 = await start(admin, { type: 'category', categoryId: c3 });
      await lines(admin, t3.body.id, [{ productId: p, countedQty: 5 }]);
      await submit(admin, t3.body.id);
      expect((await request(app).post(`/api/v1/stock-takes/${t3.body.id}/approve`).set(auth(admin)).send({})).status).toBe(200);
      expect(qty(p)).toBe(5);
    });
  });
});

describe('the approval limit is a setting', () => {
  it('a lower stocktake_approval_units sends smaller differences to approval', async () => {
    const settings = require('../src/services/settings.service');
    settings.setMany({ stocktake_approval_units: '1' }, admin.id);
    try {
      const cat = H.makeCategory('STlimit'); const p = H.makeProduct({ categoryId: cat }).id; setQty(p, 10);
      const t = await start(cashier, { type: 'category', categoryId: cat });
      await lines(cashier, t.body.id, [{ productId: p, countedQty: 8 }]);
      expect((await submit(cashier, t.body.id)).body.status).toBe('pending_approval');
      expect(qty(p)).toBe(10);
    } finally { settings.setMany({ stocktake_approval_units: '10' }, admin.id); }
  });
});
