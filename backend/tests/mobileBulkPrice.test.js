const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');
const bulk = require('../src/services/bulkPricing.service');

let admin; let manager; let cashier; let catId;
beforeAll(async () => {
  await H.loginAsAdmin();
  admin = await H.makeAdmin();
  manager = await H.makeUser('manager', 'bulk-mgr');
  cashier = await H.makeUser('cashier', 'bulk-cashier');
  catId = H.makeCategory('Bulk');
});
afterAll(() => cleanupTestDb());

const preview = (u, body) => request(app).post('/api/v1/prices/bulk/preview').set(auth(u)).send({ categoryId: catId, ...body });
const apply = (u, body) => request(app).post('/api/v1/prices/bulk/apply').set(auth(u)).send({ categoryId: catId, reason: 'Season change', ...body });

describe('rounding', () => {
  it('rounds to the nearest whole shilling, halves up', () => {
    expect(bulk.newPrice(100000, 'percent', 5)).toBe(105000);
    expect(bulk.newPrice(99900, 'percent', 10)).toBe(109900);   // 109890 -> 1099 shillings
    expect(bulk.newPrice(25000, 'percent', 5)).toBe(26300);     // 26250 is exactly half a shilling above 262 -> 263
    expect(bulk.newPrice(10050, 'fixed', 0)).toBe(10100);       // 100.50 -> 101
    expect(bulk.newPrice(100000, 'fixed', -2500)).toBe(97500);
    expect(bulk.newPrice(100000, 'percent', -7.5)).toBe(92500);
  });
});

describe('permission', () => {
  it('a manager is refused until prices.bulk is granted; a cashier never gets in', async () => {
    expect((await preview(manager, { mode: 'percent', value: 5 })).status).toBe(403);
    expect((await request(app).get('/api/v1/prices/bulk/batches').set(auth(manager))).status).toBe(403);
    expect((await preview(cashier, { mode: 'percent', value: 5 })).status).toBe(403);
    H.grant(manager.id, 'prices.bulk');
    expect((await preview(manager, { mode: 'percent', value: 5 })).status).toBe(200);
    expect((await preview(cashier, { mode: 'percent', value: 5 })).status).toBe(403);
  });
});

describe('preview, apply and revert', () => {
  let p1; let p2; let p3; let off;
  beforeAll(() => {
    H.grant(manager.id, 'prices.bulk');
    p1 = H.makeProduct({ categoryId: catId, sell: 100000, cost: 70000 });
    p2 = H.makeProduct({ categoryId: catId, sell: 250000, cost: 150000 });
    p3 = H.makeProduct({ categoryId: catId, sell: 5000, cost: 1000 });
    off = H.makeProduct({ categoryId: catId, sell: 40000, active: 0 });
  });

  it('shows the exact old and new price for every product, writes nothing, and never shows cost', async () => {
    const r = await preview(manager, { mode: 'percent', value: 10 });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    const by = Object.fromEntries(r.body.items.map((i) => [i.productId, i]));
    expect(by[p1.id]).toMatchObject({ oldPriceCents: 100000, newPriceCents: 110000, deltaCents: 10000 });
    expect(by[p2.id]).toMatchObject({ oldPriceCents: 250000, newPriceCents: 275000 });
    expect(by[off.id]).toBeUndefined();                       // inactive left alone by default
    expect(H.priceOf(p1.id)).toBe(100000);                    // preview changed nothing
    expect(JSON.stringify(r.body)).not.toMatch(/cost|margin/i);
  });

  it('skips products that would reach zero or not change, and says why', async () => {
    const r = await preview(manager, { mode: 'fixed', value: -5000 });   // p3 is 5000 -> 0
    expect(r.body.skipped.find((s) => s.productId === p3.id)).toMatchObject({ reason: 'PRICE_NOT_POSITIVE' });
    const same = await preview(manager, { mode: 'percent', value: 0 });
    expect(same.body.count).toBe(0);
    expect(same.body.skipped.every((s) => s.reason === 'UNCHANGED')).toBe(true);
  });

  it('applies exactly the preview, as one batch, with history and one audit entry carrying the reason', async () => {
    const pv = await preview(manager, { mode: 'percent', value: 10 });
    const ap = await apply(manager, { mode: 'percent', value: 10, fingerprint: pv.body.fingerprint, reason: 'Annual review' });
    expect(ap.status).toBe(201);
    expect(ap.body.count).toBe(3);
    expect(H.priceOf(p1.id)).toBe(110000);
    expect(H.priceOf(p2.id)).toBe(275000);
    expect(H.priceOf(off.id)).toBe(40000);
    const hist = db.prepare('SELECT * FROM price_history WHERE batch_id = ?').all(ap.body.batchId);
    expect(hist).toHaveLength(3);
    expect(hist.every((h) => h.source === 'bulk' && h.reason === 'Annual review' && h.changed_by === manager.id && h.device_id === manager.sessionId)).toBe(true);
    const log = H.lastLog('price_batch', ap.body.batchId);
    expect(log.staff_id).toBe(manager.id);
    expect(log.changes.reason.to).toBe('Annual review');
    expect(db.prepare(`SELECT COUNT(*) c FROM staff_logs WHERE entity_type = 'price_batch' AND entity_id = ?`).get(ap.body.batchId).c).toBe(1);
  });

  it('refuses a stale preview and changes nothing at all', async () => {
    const q = H.makeProduct({ categoryId: catId, sell: 80000 });
    const pv = await preview(manager, { mode: 'fixed', value: 10000 });
    db.prepare('UPDATE products SET sell_price = 81000 WHERE id = ?').run(q.id);   // someone edits between preview and apply
    const before = db.prepare('SELECT id, sell_price FROM products WHERE category_id = ? ORDER BY id').all(catId);
    const ap = await apply(manager, { mode: 'fixed', value: 10000, fingerprint: pv.body.fingerprint });
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('PREVIEW_STALE');
    expect(db.prepare('SELECT id, sell_price FROM products WHERE category_id = ? ORDER BY id').all(catId)).toEqual(before);
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(q.id);     // keep later tests' category simple
  });

  it('needs a reason and a valid fingerprint shape', async () => {
    const pv = await preview(manager, { mode: 'percent', value: 1 });
    expect((await apply(manager, { mode: 'percent', value: 1, fingerprint: pv.body.fingerprint, reason: 'x' })).status).toBe(400);
    expect((await apply(manager, { mode: 'percent', value: 1, fingerprint: 'abc', reason: 'Valid reason' })).status).toBe(400);
  });

  it('lists batches and reverts through a NEW batch, only once', async () => {
    const before1 = H.priceOf(p1.id); const before2 = H.priceOf(p2.id);
    const pv = await preview(manager, { mode: 'percent', value: -10 });
    const ap = await apply(manager, { mode: 'percent', value: -10, fingerprint: pv.body.fingerprint, reason: 'Clearance' });
    expect(H.priceOf(p1.id)).toBeLessThan(before1);

    const rv = await request(app).post(`/api/v1/prices/bulk/${ap.body.batchId}/revert`).set(auth(manager)).send({});
    expect(rv.status).toBe(201);
    expect(rv.body.batchId).not.toBe(ap.body.batchId);
    expect(rv.body.count).toBe(3);
    expect(H.priceOf(p1.id)).toBe(before1);
    expect(H.priceOf(p2.id)).toBe(before2);
    expect(db.prepare(`SELECT COUNT(*) c FROM price_history WHERE batch_id = ? AND source = 'bulk_revert'`).get(rv.body.batchId).c).toBe(3);

    const list = await request(app).get('/api/v1/prices/bulk/batches').set(auth(manager));
    const original = list.body.items.find((b) => b.id === ap.body.batchId);
    const revert = list.body.items.find((b) => b.id === rv.body.batchId);
    expect(original.revertedAt).toBeTruthy();
    expect(revert).toMatchObject({ kind: 'bulk_revert', revertsBatchId: ap.body.batchId });

    const again = await request(app).post(`/api/v1/prices/bulk/${ap.body.batchId}/revert`).set(auth(manager)).send({});
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('ALREADY_REVERTED');
    const revertOfRevert = await request(app).post(`/api/v1/prices/bulk/${rv.body.batchId}/revert`).set(auth(manager)).send({});
    expect(revertOfRevert.status).toBe(409); expect(revertOfRevert.body.error.code).toBe('NOT_REVERTIBLE');
    expect((await request(app).post('/api/v1/prices/bulk/999999/revert').set(auth(manager)).send({})).status).toBe(404);
  });

  it('a revert leaves alone any product repriced since, and says so', async () => {
    const c2 = H.makeCategory('Bulk2');
    const a = H.makeProduct({ categoryId: c2, sell: 100000 }); const b = H.makeProduct({ categoryId: c2, sell: 200000 });
    const body = { categoryId: c2, mode: 'percent', value: 20 };
    const pv = await request(app).post('/api/v1/prices/bulk/preview').set(auth(manager)).send(body);
    const ap = await request(app).post('/api/v1/prices/bulk/apply').set(auth(manager)).send({ ...body, reason: 'Season', fingerprint: pv.body.fingerprint });
    await request(app).patch(`/api/v1/products/${a.id}`).set(auth(manager)).send({ sellPriceCents: 130000, reason: 'Manual correction' });
    const rv = await request(app).post(`/api/v1/prices/bulk/${ap.body.batchId}/revert`).set(auth(manager)).send({ reason: 'Wrong season' });
    expect(rv.status).toBe(201);
    expect(rv.body.count).toBe(1);
    expect(rv.body.skipped).toEqual([{ productId: a.id, name: expect.any(String), reason: 'PRICE_CHANGED_SINCE' }]);
    expect(H.priceOf(a.id)).toBe(130000);      // the later, deliberate edit survives
    expect(H.priceOf(b.id)).toBe(200000);
  });

  it('refuses a category that does not exist and one with too many products', async () => {
    expect((await request(app).post('/api/v1/prices/bulk/preview').set(auth(manager)).send({ categoryId: 999999, mode: 'percent', value: 5 })).body.error.code).toBe('INVALID_CATEGORY');
    const big = H.makeCategory('Big');
    const ins = db.prepare(`INSERT INTO products (sku, name, category_id, cost_price, sell_price, is_active) VALUES (?, ?, ?, 0, 10000, 1)`);
    db.transaction(() => { for (let i = 0; i < 1001; i += 1) ins.run(`BIG-${big}-${i}`, `Big ${i}`, big); })();
    const r = await request(app).post('/api/v1/prices/bulk/preview').set(auth(admin)).send({ categoryId: big, mode: 'percent', value: 10 });
    expect(r.status).toBe(422); expect(r.body.error.code).toBe('TOO_MANY');
  });
});
