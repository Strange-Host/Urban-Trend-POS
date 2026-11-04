const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');

let admin; let manager; let noCostManager; let cashier; let catId;

beforeAll(async () => {
  await H.loginAsAdmin();
  admin = await H.makeAdmin();
  manager = await H.makeUser('manager', 'cat-mgr');
  noCostManager = await H.makeUser('manager', 'cat-nocost');
  H.revoke(noCostManager.id, 'products.view_cost');
  cashier = await H.makeUser('cashier', 'cat-cashier');
  catId = H.makeCategory('Catalog');
});
afterAll(() => cleanupTestDb());

const COST_KEYS = ['costPriceCents', 'marginCents'];
const noCostIn = (obj) => { const text = JSON.stringify(obj); return COST_KEYS.every((k) => !text.includes(`"${k}"`)); };

describe('catalog permissions', () => {
  it('a cashier cannot read or write the catalog', async () => {
    expect((await request(app).get('/api/v1/products').set(auth(cashier))).status).toBe(403);
    expect((await request(app).post('/api/v1/products').set(auth(cashier)).send({ name: 'x', sku: 'x', sellPriceCents: 1000 })).status).toBe(403);
    expect((await request(app).post('/api/v1/categories').set(auth(cashier)).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/v1/catalog/settings').set(auth(cashier))).status).toBe(403);
  });
  it('needs a sign-in', async () => {
    expect((await request(app).get('/api/v1/products')).status).toBe(401);
  });
});

describe('cost is never sent to someone without products.view_cost', () => {
  let product;
  beforeAll(() => { product = H.makeProduct({ categoryId: catId, sell: 150000, cost: 90000 }); });

  it('admin and a manager with the permission get cost and margin', async () => {
    for (const u of [admin, manager]) {
      const r = await request(app).get(`/api/v1/products/${product.id}`).set(auth(u));
      expect(r.status).toBe(200);
      expect(r.body.costPriceCents).toBe(90000);
      expect(r.body.marginCents).toBe(60000);
    }
  });
  it('a manager without it never sees the keys: list, detail, create, patch, price history', async () => {
    const list = await request(app).get(`/api/v1/products?categoryId=${catId}`).set(auth(noCostManager));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(noCostIn(list.body)).toBe(true);

    const detail = await request(app).get(`/api/v1/products/${product.id}`).set(auth(noCostManager));
    expect(noCostIn(detail.body)).toBe(true);
    expect(detail.body.sellPriceCents).toBe(150000);

    const created = await request(app).post('/api/v1/products').set(auth(noCostManager))
      .send({ name: 'No cost made', sku: `NC-${Date.now()}`, sellPriceCents: 50000 });
    expect(created.status).toBe(201);
    expect(noCostIn(created.body)).toBe(true);
    expect(db.prepare('SELECT cost_price FROM products WHERE id = ?').get(created.body.id).cost_price).toBe(0);

    const patched = await request(app).patch(`/api/v1/products/${product.id}`).set(auth(noCostManager))
      .send({ sellPriceCents: 160000, reason: 'Supplier raised prices' });
    expect(patched.status).toBe(200);
    expect(noCostIn(patched.body)).toBe(true);

    const hist = await request(app).get(`/api/v1/products/${product.id}/price-history`).set(auth(noCostManager));
    expect(hist.status).toBe(200);
    expect(noCostIn(hist.body)).toBe(true);
    // the buying price in the database is untouched
    expect(db.prepare('SELECT cost_price FROM products WHERE id = ?').get(product.id).cost_price).toBe(90000);
  });
  it('sending a cost without the permission is FORBIDDEN and changes nothing', async () => {
    const r = await request(app).patch(`/api/v1/products/${product.id}`).set(auth(noCostManager)).send({ costPriceCents: 1 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    const c = await request(app).post('/api/v1/products').set(auth(noCostManager)).send({ name: 'x', sku: `NC2-${Date.now()}`, sellPriceCents: 1000, costPriceCents: 5 });
    expect(c.status).toBe(403);
    expect(db.prepare('SELECT cost_price FROM products WHERE id = ?').get(product.id).cost_price).toBe(90000);
  });
  it('admin can set the cost', async () => {
    const r = await request(app).patch(`/api/v1/products/${product.id}`).set(auth(admin)).send({ costPriceCents: 95000 });
    expect(r.status).toBe(200);
    expect(r.body.costPriceCents).toBe(95000);
  });
});

describe('product create and edit', () => {
  it('rejects a duplicate SKU or barcode with its own code, on create and on edit', async () => {
    const a = H.makeProduct({ categoryId: catId });
    const b = H.makeProduct({ categoryId: catId });
    const barcodeA = db.prepare('SELECT barcode FROM products WHERE id = ?').get(a.id).barcode;
    const dupSku = await request(app).post('/api/v1/products').set(auth(manager)).send({ name: 'Dup', sku: a.sku, sellPriceCents: 1000 });
    expect(dupSku.status).toBe(409); expect(dupSku.body.error.code).toBe('DUPLICATE_SKU');
    const dupBar = await request(app).post('/api/v1/products').set(auth(manager)).send({ name: 'Dup', sku: `D-${Date.now()}`, barcode: barcodeA, sellPriceCents: 1000 });
    expect(dupBar.status).toBe(409); expect(dupBar.body.error.code).toBe('DUPLICATE_BARCODE');
    const editSku = await request(app).patch(`/api/v1/products/${b.id}`).set(auth(manager)).send({ sku: a.sku });
    expect(editSku.status).toBe(409); expect(editSku.body.error.code).toBe('DUPLICATE_SKU');
    const editBar = await request(app).patch(`/api/v1/products/${b.id}`).set(auth(manager)).send({ barcode: barcodeA });
    expect(editBar.status).toBe(409); expect(editBar.body.error.code).toBe('DUPLICATE_BARCODE');
    // keeping your own sku is not a duplicate
    const same = await request(app).patch(`/api/v1/products/${b.id}`).set(auth(manager)).send({ sku: b.sku, name: 'Renamed' });
    expect(same.status).toBe(200); expect(same.body.name).toBe('Renamed');
  });

  it('a price change needs a reason, a positive price, and writes history plus an audit row with reason and device', async () => {
    const p = H.makeProduct({ categoryId: catId, sell: 100000 });
    const noReason = await request(app).patch(`/api/v1/products/${p.id}`).set(auth(manager)).send({ sellPriceCents: 120000 });
    expect(noReason.status).toBe(400); expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    const shortReason = await request(app).patch(`/api/v1/products/${p.id}`).set(auth(manager)).send({ sellPriceCents: 120000, reason: 'ab' });
    expect(shortReason.body.error.code).toBe('REASON_REQUIRED');
    for (const bad of [0, -1]) {
      const r = await request(app).patch(`/api/v1/products/${p.id}`).set(auth(manager)).send({ sellPriceCents: bad, reason: 'Testing bad price' });
      expect(r.status).toBe(400); expect(r.body.error.code).toBe('INVALID_PRICE');
    }
    expect(H.priceOf(p.id)).toBe(100000);

    const ok = await request(app).patch(`/api/v1/products/${p.id}`).set(auth(manager)).send({ sellPriceCents: 120000, reason: 'Supplier increase' });
    expect(ok.status).toBe(200);
    expect(ok.body.sellPriceCents).toBe(120000);

    const hist = await request(app).get(`/api/v1/products/${p.id}/price-history`).set(auth(manager));
    expect(hist.body.items).toHaveLength(1);
    expect(hist.body.items[0]).toMatchObject({ oldPriceCents: 100000, newPriceCents: 120000, reason: 'Supplier increase', source: 'edit', changedBy: { id: manager.id } });

    const log = H.lastLog('product', p.id);
    expect(log.staff_id).toBe(manager.id);
    expect(log.changes.reason.to).toBe('Supplier increase');
    expect(log.changes.deviceId.to).toBe(manager.sessionId);

    // an edit that leaves the price alone needs no reason and adds no history
    const rename = await request(app).patch(`/api/v1/products/${p.id}`).set(auth(manager)).send({ name: 'Renamed only' });
    expect(rename.status).toBe(200);
    expect((await request(app).get(`/api/v1/products/${p.id}/price-history`).set(auth(manager))).body.items).toHaveLength(1);
  });

  it('products are switched off, never deleted, and drop out of the default list', async () => {
    const p = H.makeProduct({ categoryId: catId });
    const off = await request(app).patch(`/api/v1/products/${p.id}`).set(auth(manager)).send({ isActive: false });
    expect(off.status).toBe(200); expect(off.body.isActive).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM products WHERE id = ?').get(p.id).c).toBe(1);
    const active = await request(app).get(`/api/v1/products?categoryId=${catId}&limit=100`).set(auth(manager));
    expect(active.body.items.find((i) => i.id === p.id)).toBeUndefined();
    const inactive = await request(app).get(`/api/v1/products?categoryId=${catId}&active=0&limit=100`).set(auth(manager));
    expect(inactive.body.items.find((i) => i.id === p.id)).toBeTruthy();
  });

  it('pages with an opaque cursor without repeating or skipping a product', async () => {
    const c = H.makeCategory('Paging');
    const made = Array.from({ length: 7 }, () => H.makeProduct({ categoryId: c }).id);
    const seen = []; let cursor = null; let pages = 0;
    do {
      const r = await request(app).get(`/api/v1/products?categoryId=${c}&limit=3${cursor ? `&cursor=${cursor}` : ''}`).set(auth(manager));
      seen.push(...r.body.items.map((i) => i.id));
      cursor = r.body.nextCursor; pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...made].sort());
    // a garbage cursor means "from the top", never an error
    expect((await request(app).get(`/api/v1/products?categoryId=${c}&cursor=garbage`).set(auth(manager))).status).toBe(200);
  });

  it('searches by name, sku and barcode', async () => {
    const p = H.makeProduct({ categoryId: catId });
    const row = db.prepare('SELECT sku, barcode FROM products WHERE id = ?').get(p.id);
    for (const q of [row.sku, row.barcode]) {
      const r = await request(app).get(`/api/v1/products?q=${encodeURIComponent(q)}`).set(auth(manager));
      expect(r.body.items.map((i) => i.id)).toContain(p.id);
    }
  });
});

describe('the web product screen also writes price history', () => {
  it('PUT /api/products/:id records the change with source web, and its reason when sent', async () => {
    const p = H.makeProduct({ categoryId: catId, sell: 100000 });
    const web = await request(app).post('/api/auth/login').send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    expect(web.status).toBe(200);
    const r = await request(app).put(`/api/products/${p.id}`).set({ Authorization: `Bearer ${web.body.token}` }).send({ sell_price: 110000, reason: 'Stock cost went up' });
    expect(r.status).toBe(200);
    const h = db.prepare('SELECT * FROM price_history WHERE product_id = ?').all(p.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ old_price: 100000, new_price: 110000, source: 'web', reason: 'Stock cost went up', device_id: null });
    expect(H.lastLog('product', p.id).changes.reason.to).toBe('Stock cost went up');
    // no price change, no history
    await request(app).put(`/api/products/${p.id}`).set({ Authorization: `Bearer ${web.body.token}` }).send({ name: 'Just a rename' });
    expect(db.prepare('SELECT COUNT(*) c FROM price_history WHERE product_id = ?').get(p.id).c).toBe(1);
  });
});

describe('categories', () => {
  it('creates, rejects a duplicate name (any case), renames, deactivates and restores', async () => {
    const name = `Shoes ${Date.now()}`;
    const c = await request(app).post('/api/v1/categories').set(auth(manager)).send({ name });
    expect(c.status).toBe(201);
    const dup = await request(app).post('/api/v1/categories').set(auth(manager)).send({ name: name.toUpperCase() });
    expect(dup.status).toBe(409); expect(dup.body.error.code).toBe('DUPLICATE_NAME');

    const renamed = await request(app).patch(`/api/v1/categories/${c.body.id}`).set(auth(manager)).send({ name: `${name} v2` });
    expect(renamed.body.name).toBe(`${name} v2`);

    const p = H.makeProduct({ categoryId: c.body.id });
    const off = await request(app).patch(`/api/v1/categories/${c.body.id}`).set(auth(manager)).send({ isActive: false });
    expect(off.body.isActive).toBe(false);
    // deactivating never touches the products filed under it
    expect(db.prepare('SELECT is_active, category_id FROM products WHERE id = ?').get(p.id)).toMatchObject({ is_active: 1, category_id: c.body.id });
    const hidden = await request(app).get('/api/v1/categories').set(auth(manager));
    expect(hidden.body.items.find((i) => i.id === c.body.id)).toBeUndefined();
    const all = await request(app).get('/api/v1/categories?includeInactive=1').set(auth(manager));
    expect(all.body.items.find((i) => i.id === c.body.id)).toMatchObject({ isActive: false });
    const back = await request(app).patch(`/api/v1/categories/${c.body.id}`).set(auth(manager)).send({ isActive: true });
    expect(back.body.isActive).toBe(true);
    expect(H.lastLog('category', c.body.id).staff_id).toBe(manager.id);
  });

  it('reorders in one step and rejects unknown or repeated ids', async () => {
    const a = H.makeCategory('Ord'); const b = H.makeCategory('Ord'); const c = H.makeCategory('Ord');
    const r = await request(app).post('/api/v1/categories/reorder').set(auth(manager)).send({ ids: [c, a, b] });
    expect(r.status).toBe(200);
    const order = r.body.items.map((i) => i.id).filter((id) => [a, b, c].includes(id));
    expect(order).toEqual([c, a, b]);
    expect((await request(app).post('/api/v1/categories/reorder').set(auth(manager)).send({ ids: [a, a] })).status).toBe(400);
    expect((await request(app).post('/api/v1/categories/reorder').set(auth(manager)).send({ ids: [a, 999999] })).status).toBe(400);
    const list = await request(app).get('/api/v1/categories').set(auth(manager));
    expect(list.body.items.map((i) => i.id).filter((id) => [a, b, c].includes(id))).toEqual([c, a, b]);
  });
});

describe('catalog settings', () => {
  it('says the POS is the price master and that nothing is pushed online yet', async () => {
    const r = await request(app).get('/api/v1/catalog/settings').set(auth(manager));
    expect(r.body).toEqual({ priceMaster: 'pos', pricePushOnline: false, pushImplemented: false });
  });
});
