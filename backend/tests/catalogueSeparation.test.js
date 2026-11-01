const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const shopifyService = require('../src/services/shopify.service');

// The shop and the online store hold SEPARATE physical stock. The shop's catalogue (what the till sells, with tracked
// stock) and the online catalogue (Shopify/WooCommerce listings, stock not tracked here) must never leak into each other.

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let token;
let categoryId;
let n = 0;
let phone = 7200000;

beforeAll(async () => {
  token = await loginAsAdmin();
  categoryId = db.prepare('SELECT id FROM categories LIMIT 1').get().id;
});

const stockOf = (pid) => db.prepare('SELECT COALESCE(SUM(quantity), 0) q FROM inventory WHERE product_id = ?').get(pid).q;
const movements = (pid) => db.prepare('SELECT * FROM inventory_movements WHERE product_id = ? ORDER BY id').all(pid);

function shopProduct(stock, { barcode = null } = {}) {
  n += 1;
  const pid = db.prepare(`INSERT INTO products (sku, barcode, name, cost_price, sell_price, is_active) VALUES (?, ?, ?, 5000, 10000, 1)`)
    .run(`CAT-${n}-${Date.now()}`, barcode, `Catalogue Test ${n}`).lastInsertRowid;
  if (stock !== null) db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, ?)').run(pid, stock);
  return pid;
}

// One Shopify product as the API returns it, with the quantity Shopify says it holds.
const shopifyPayload = (id, over = {}) => ({
  id, title: `Online Tee ${id}`, image: null,
  variants: [{ id: id * 10, title: 'Default Title', sku: over.sku || `ONL-${id}`, barcode: null, price: '1500.00', inventory_quantity: over.qty ?? 40, inventory_item_id: id * 100 }],
});

function newSource() {
  n += 1;
  return db.prepare(`INSERT INTO income_sources (name, platform, shop_domain, store_id, is_active) VALUES (?, 'shopify', ?, 1, 1)`)
    .run(`Test Shopify ${n}`, `t${n}.myshopify.com`).lastInsertRowid;
}

async function placeOrder(productId, quantity) {
  phone += 1;
  const res = await request(app).post('/api/orders').set(auth(token))
    .send({ payment_type: 'prepaid', name: 'Cat Test', phone: `0${phone}`, items: [{ product_id: productId, quantity }] });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

describe('approving a Shopify product', () => {
  it('creates an online-catalogue product with no shop stock, and keeps it off the till list', () => {
    const src = newSource();
    shopifyService.ingestShopifyProducts({ id: src }, [shopifyPayload(9001, { qty: 40 })], null);
    const staged = db.prepare('SELECT * FROM shopify_staging_products WHERE income_source_id = ?').get(src);
    db.prepare('UPDATE shopify_staging_products SET category_id = ? WHERE id = ?').run(categoryId, staged.id);

    const product = shopifyService.approve(staged.id, 1, 1);

    expect(product.catalogue).toBe('online');
    expect(db.prepare('SELECT COUNT(*) c FROM inventory WHERE product_id = ?').get(product.id).c).toBe(0);
    expect(movements(product.id)).toHaveLength(0);
    // Shopify's own count is kept for reference on the staged row only.
    expect(db.prepare('SELECT inventory_qty FROM shopify_staging_products WHERE id = ?').get(staged.id).inventory_qty).toBe(40);
  });

  it('the product list shows shop products by default and online ones only when asked', async () => {
    const shopPid = shopProduct(5);
    const online = db.prepare(`SELECT id FROM products WHERE catalogue = 'online' LIMIT 1`).get();

    const shopList = await request(app).get('/api/products?pageSize=100').set(auth(token));
    const ids = shopList.body.data.map((p) => p.id);
    expect(ids).toContain(shopPid);
    expect(ids).not.toContain(online.id);

    const onlineList = await request(app).get('/api/products?catalogue=online&pageSize=100').set(auth(token));
    expect(onlineList.body.data.map((p) => p.id)).toContain(online.id);
    expect(onlineList.body.data.map((p) => p.id)).not.toContain(shopPid);
  });

  it('the barcode lookup used by the till never returns an online product', async () => {
    const code = `BC${Date.now()}`;
    const pid = shopProduct(3, { barcode: code });
    expect((await request(app).get(`/api/products/barcode/${code}`).set(auth(token))).status).toBe(200);
    db.prepare(`UPDATE products SET catalogue = 'online' WHERE id = ?`).run(pid);
    expect((await request(app).get(`/api/products/barcode/${code}`).set(auth(token))).status).toBe(404);
  });
});

describe('pulling products again from Shopify', () => {
  it('never overwrites the shop\'s own stock, even when the SKU matches a shop product', () => {
    const pid = shopProduct(7);
    const sku = db.prepare('SELECT sku FROM products WHERE id = ?').get(pid).sku;
    const src = newSource();

    // Shopify says 99 of a product that shares the shop product's SKU.
    shopifyService.ingestShopifyProducts({ id: src }, [shopifyPayload(9100, { sku, qty: 99 })], 1);
    expect(stockOf(pid)).toBe(7);
    expect(movements(pid)).toHaveLength(0);

    // And again with a different count: still untouched.
    shopifyService.ingestShopifyProducts({ id: src }, [shopifyPayload(9100, { sku, qty: 0 })], 1);
    expect(stockOf(pid)).toBe(7);
  });

  it('approving a staged row that matches a shop product links it but leaves it in the shop catalogue with its stock', () => {
    const pid = shopProduct(4);
    const sku = db.prepare('SELECT sku FROM products WHERE id = ?').get(pid).sku;
    const src = newSource();
    shopifyService.ingestShopifyProducts({ id: src }, [shopifyPayload(9200, { sku, qty: 55 })], 1);
    const staged = db.prepare('SELECT * FROM shopify_staging_products WHERE income_source_id = ?').get(src);

    const product = shopifyService.approve(staged.id, 1, 1);
    expect(product.id).toBe(pid);
    expect(product.catalogue).toBe('shop');
    expect(stockOf(pid)).toBe(4);
  });
});

describe('dispatching orders', () => {
  it('a shop order still takes shop stock, and still refuses when there is not enough', async () => {
    const pid = shopProduct(3);
    const orderId = await placeOrder(pid, 2);
    const res = await request(app).post(`/api/orders/${orderId}/dispatch`).set(auth(token));
    expect(res.status).toBe(200);
    expect(stockOf(pid)).toBe(1);

    const tooMany = await placeOrder(pid, 5);
    const refused = await request(app).post(`/api/orders/${tooMany}/dispatch`).set(auth(token));
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Insufficient stock/);
  });

  it('an order imported from Shopify dispatches without checking or taking shop stock', async () => {
    const pid = shopProduct(0); // the shop holds none of it
    db.prepare(`UPDATE products SET catalogue = 'online' WHERE id = ?`).run(pid);
    const orderId = await placeOrder(pid, 3);
    db.prepare(`UPDATE orders SET channel = 'shopify' WHERE id = ?`).run(orderId);

    const res = await request(app).post(`/api/orders/${orderId}/dispatch`).set(auth(token));
    expect(res.status).toBe(200);
    expect(stockOf(pid)).toBe(0);
    expect(movements(pid)).toHaveLength(0);
    // The line cost falls back to the product's buying price (5000 x 3), not the stock ledger.
    expect(db.prepare('SELECT cost_total FROM order_items WHERE order_id = ?').get(orderId).cost_total).toBe(15000);
  });

  it('an online order that matches a shop product by SKU still leaves the shop shelf alone', async () => {
    const pid = shopProduct(6);
    const orderId = await placeOrder(pid, 2);
    db.prepare(`UPDATE orders SET channel = 'shopify' WHERE id = ?`).run(orderId);
    expect((await request(app).post(`/api/orders/${orderId}/dispatch`).set(auth(token))).status).toBe(200);
    expect(stockOf(pid)).toBe(6);
  });
});

describe('moving a product between catalogues', () => {
  const move = (id, body) => request(app).post(`/api/products/${id}/catalogue`).set(auth(token)).send(body);

  it('refuses to move a product that still shows stock to online, and says how many units', async () => {
    const pid = shopProduct(9);
    const res = await move(pid, { catalogue: 'online' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_ON_HAND');
    expect(res.body.error.message).toMatch(/9 units/);
    expect(db.prepare('SELECT catalogue FROM products WHERE id = ?').get(pid).catalogue).toBe('shop');
    expect(stockOf(pid)).toBe(9);
  });

  it('with clear_stock it writes the units off through the ledger, then moves the product', async () => {
    const pid = shopProduct(9);
    const res = await move(pid, { catalogue: 'online', clear_stock: true });
    expect(res.status).toBe(200);
    expect(res.body.data.catalogue).toBe('online');
    expect(stockOf(pid)).toBe(0);
    const m = movements(pid);
    expect(m).toHaveLength(1);
    expect(m[0].change_qty).toBe(-9);
  });

  it('a product with no stock moves to online without clear_stock', async () => {
    const pid = shopProduct(null);
    expect((await move(pid, { catalogue: 'online' })).status).toBe(200);
  });

  it('moving to the shop sets the opening stock through the ledger', async () => {
    const pid = shopProduct(null);
    db.prepare(`UPDATE products SET catalogue = 'online' WHERE id = ?`).run(pid);
    const res = await move(pid, { catalogue: 'shop', opening_stock: 12 });
    expect(res.status).toBe(200);
    expect(res.body.data.catalogue).toBe('shop');
    expect(stockOf(pid)).toBe(12);
    expect(movements(pid)[0].change_qty).toBe(12);
  });

  it('rejects a bad catalogue, a bad opening stock, and a no-op move', async () => {
    const pid = shopProduct(0);
    expect((await move(pid, { catalogue: 'warehouse' })).status).toBe(400);
    expect((await move(pid, { catalogue: 'shop' })).status).toBe(409);
    db.prepare(`UPDATE products SET catalogue = 'online' WHERE id = ?`).run(pid);
    expect((await move(pid, { catalogue: 'shop', opening_stock: -1 })).status).toBe(400);
    expect((await move(pid, { catalogue: 'shop', opening_stock: 1.5 })).status).toBe(400);
  });

  it('is limited to people who can manage products', async () => {
    const pid = shopProduct(null);
    const res = await request(app).post(`/api/products/${pid}/catalogue`).send({ catalogue: 'online' });
    expect(res.status).toBe(401);
  });
});
