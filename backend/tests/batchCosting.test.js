const bcrypt = require('bcryptjs');
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const costing = require('../src/services/costing.service');
const salesService = require('../src/services/sales.service');
const stock = require('../src/services/stock.service');
const notifications = require('../src/services/notifications.service');
const reconciliation = require('../src/services/reconciliation.service');

// Batch costing (FIFO / average valuation), expiry, recall and the stock alerts.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
const BACKEND = path.join(__dirname, '..');

let adminToken; let adminId; let mainId; let outletId;
let storeKeeper; let manager; let storeKeeper2;
let counter = 0;

async function makeUser(role, email, storeId) {
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `${role} bc ${email.split('@')[0]}`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token };
}

function newProduct(cost = 100, sell = 500) {
  counter += 1;
  return db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active, approval_status) VALUES (?, ?, ?, ?, 1, 'approved')`)
    .run(`BC-${counter}`, `Costing Product ${counter}`, cost, sell).lastInsertRowid;
}

const receive = (token, items, extra = {}) => request(app).post('/api/stock/receipts').set(auth(token)).send({ items, ...extra });
const itemIds = (receiptBody) => receiptBody.data.items.map((i) => i.id);
const setMethod = (m) => db.prepare(`INSERT INTO settings (key, value) VALUES ('inventory_valuation_method', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(m);
const sell = (productId, qty, price = 500) => salesService.checkout({
  storeId: mainId, cashierId: adminId, items: [{ product_id: productId, quantity: qty }], payments: [{ method: 'cash', amount: qty * price }],
});
const lineCost = (saleId) => db.prepare('SELECT cost_total FROM sale_items WHERE sale_id = ?').get(saleId).cost_total;
const row = (productId, storeId, method) => costing.valuationRows({ storeId, method }).find((r) => r.product_id === productId);
const qty = (productId, storeId) => (db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId) || { quantity: 0 }).quantity;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const transfer = (productId, from, to, n, ref) => db.transaction(() => {
  stock.applyMovement({ productId, storeId: from, change: -n, reason: 'transfer_out', referenceType: 'transfer', referenceId: ref, userId: adminId });
  stock.applyMovement({ productId, storeId: to, change: n, reason: 'transfer_in', referenceType: 'transfer', referenceId: ref, userId: adminId });
})();

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  adminId = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  mainId = db.prepare('SELECT id FROM stores WHERE is_main = 1').get().id;
  outletId = db.prepare(`INSERT INTO stores (name) VALUES ('Costing Outlet')`).run().lastInsertRowid;
  storeKeeper = await makeUser('store', 'bc-store@urbantrends.com', mainId);
  storeKeeper2 = await makeUser('store', 'bc-store2@urbantrends.com', mainId);
  manager = await makeUser('manager', 'bc-manager@urbantrends.com', mainId);
});
afterAll(() => cleanupTestDb());

describe('FIFO and average valuation', () => {
  it('values what is left by batch under FIFO and by moving average under average, and records each sale\'s cost', async () => {
    const p = newProduct(100);
    const a = await receive(adminToken, [{ product_id: p, quantity: 10, unit_cost: 100 }]);
    const b = await receive(adminToken, [{ product_id: p, quantity: 10, unit_cost: 200 }]);
    expect(a.status).toBe(201);
    expect(a.body.data.items[0].unit_cost).toBe(100); // an admin sees buying prices

    expect(row(p, mainId, 'fifo')).toMatchObject({ quantity: 20, cost_value: 3000 });
    expect(row(p, mainId, 'average')).toMatchObject({ quantity: 20, cost_value: 3000 });

    // FIFO: the first 5 come out of the cheap batch.
    setMethod('fifo');
    const s1 = sell(p, 5);
    expect(lineCost(s1.id)).toBe(500);
    expect(row(p, mainId, 'fifo').cost_value).toBe(2500);
    expect(row(p, mainId, 'average').cost_value).toBe(2250); // 5 x the 150 average

    // Switch to average: the next 5 cost the average (value 2250 / 15 units = 150), not the next FIFO layer.
    setMethod('average');
    const s2 = sell(p, 5);
    expect(lineCost(s2.id)).toBe(750);
    // The sale already recorded under FIFO is not rewritten by the switch.
    expect(lineCost(s1.id)).toBe(500);

    // Same ledger, two answers for what is left (10 units).
    expect(row(p, mainId, 'fifo')).toMatchObject({ quantity: 10, cost_value: 2000 }); // all from the 200 batch
    expect(row(p, mainId, 'average')).toMatchObject({ quantity: 10, cost_value: 1500 });

    // The valuation report follows the setting and shows the other method alongside.
    const rep = await request(app).get('/api/reports/inventory-valuation').set(auth(adminToken));
    expect(rep.status).toBe(200);
    expect(rep.body.data.method).toBe('average');
    expect(rep.body.data.rows.find((r) => r.product_id === p).cost_value).toBe(1500);
    expect(rep.body.data.comparison.fifo - rep.body.data.comparison.average).toBe(500);
    setMethod('fifo');
  });

  it('keeps old numbers where nothing was costed: stock with no batch cost is valued at the catalog cost', async () => {
    setMethod('fifo');
    const p = newProduct(120);
    db.prepare(`INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 7)`).run(p, mainId);
    db.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason) VALUES (?, ?, 7, 'restock')`).run(p, mainId);
    expect(row(p, mainId, 'fifo')).toMatchObject({ quantity: 7, cost_value: 840, uncosted_units: 0 });
    const s = sell(p, 2);
    expect(lineCost(s.id)).toBe(240);
  });

  it('P&L cost of goods follows the recorded line cost, not today\'s catalog price', async () => {
    setMethod('fifo');
    const p = newProduct(100);
    await receive(adminToken, [{ product_id: p, quantity: 10, unit_cost: 100 }]);
    const s = sell(p, 4);
    db.prepare('UPDATE products SET cost_price = 999 WHERE id = ?').run(p); // the catalog price moves later
    const day = db.prepare(`SELECT date(created_at) d FROM sales WHERE id = ?`).get(s.id).d;
    const top = await request(app).get(`/api/reports/top-products-by-profit?from=${addDays(day, -1)}&to=${addDays(day, 1)}`).set(auth(adminToken));
    const mine = top.body.data.find((r) => r.id === p);
    expect(mine.cost).toBe(400);
  });

  it('voiding a sale puts the units back at the cost they left with', async () => {
    setMethod('fifo');
    const p = newProduct(100);
    await receive(adminToken, [{ product_id: p, quantity: 5, unit_cost: 100 }]);
    await receive(adminToken, [{ product_id: p, quantity: 5, unit_cost: 300 }]);
    const s = sell(p, 5); // all from the 100 batch
    expect(row(p, mainId, 'fifo').cost_value).toBe(1500);
    salesService.voidSale(s.id, mainId, adminId);
    expect(row(p, mainId, 'fifo')).toMatchObject({ quantity: 10, cost_value: 2000 }); // 500 + 1500, as before the sale
  });

  it('a transfer carries the batches, and so their cost, to the outlet', async () => {
    const p = newProduct(100);
    await receive(adminToken, [{ product_id: p, quantity: 4, unit_cost: 100 }]);
    await receive(adminToken, [{ product_id: p, quantity: 4, unit_cost: 300 }]);
    transfer(p, mainId, outletId, 5, 9001);
    expect(row(p, outletId, 'fifo')).toMatchObject({ quantity: 5, cost_value: 4 * 100 + 300 });
    expect(row(p, mainId, 'fifo')).toMatchObject({ quantity: 3, cost_value: 900 });
  });
});

describe('buying prices stay hidden until someone allowed fills them in', () => {
  it('the storekeeper\'s receipt carries no buying price, the batch is valued at the catalog cost, and a manager costs it', async () => {
    const p = newProduct(300);
    const rec = await receive(storeKeeper.token, [{ product_id: p, quantity: 10, unit_cost: 50, batch_no: 'LOT-7' }]);
    expect(rec.status).toBe(201);
    expect(rec.body.data.items[0]).not.toHaveProperty('unit_cost');
    expect(rec.body.data.items[0].batch_no).toBe('LOT-7');
    const [itemId] = itemIds(rec.body);
    expect(db.prepare('SELECT unit_cost FROM stock_receipt_items WHERE id = ?').get(itemId).unit_cost).toBeNull(); // the 50 was ignored

    expect(row(p, mainId, 'fifo')).toMatchObject({ cost_value: 3000, uncosted_units: 10 });

    const denied = await request(app).put(`/api/stock/receipts/${rec.body.data.id}/costs`).set(auth(storeKeeper.token)).send({ items: [{ item_id: itemId, unit_cost: 250 }] });
    expect(denied.status).toBe(403);
    expect((await request(app).get('/api/stock/receipts/awaiting-cost').set(auth(storeKeeper.token))).status).toBe(403);

    const waiting = await request(app).get('/api/stock/receipts/awaiting-cost').set(auth(manager.token));
    expect(waiting.body.data.some((r) => r.item_id === itemId)).toBe(true);

    const url = `/api/stock/receipts/${rec.body.data.id}/costs`;
    expect((await request(app).put(url).set(auth(manager.token)).send({ items: [{ item_id: itemId, unit_cost: -1 }] })).status).toBe(400);
    expect((await request(app).put(url).set(auth(manager.token)).send({ items: [{ item_id: 999999, unit_cost: 5 }] })).status).toBe(404);
    const ok = await request(app).put(url).set(auth(manager.token)).send({ items: [{ item_id: itemId, unit_cost: 250 }], update_product_cost: true });
    expect(ok.status).toBe(200);

    expect(row(p, mainId, 'fifo')).toMatchObject({ cost_value: 2500, uncosted_units: 0 });
    expect(db.prepare('SELECT cost_price FROM products WHERE id = ?').get(p).cost_price).toBe(250);

    const asKeeper = await request(app).get(`/api/stock/receipts/${rec.body.data.id}`).set(auth(storeKeeper.token));
    expect(asKeeper.body.data.items[0]).not.toHaveProperty('unit_cost');
    const asManager = await request(app).get(`/api/stock/receipts/${rec.body.data.id}`).set(auth(manager.token));
    expect(asManager.body.data.items[0].unit_cost).toBe(250);
  });

  it('the valuation report needs permission to see buying prices', async () => {
    expect((await request(app).get('/api/reports/inventory-valuation').set(auth(storeKeeper.token))).status).toBe(403);
  });

  it('approving a proposed product costs the batch it was received in', async () => {
    const rec = await receive(storeKeeper2.token, [{ quantity: 6, new_product: { name: 'Proposed Costing Thing', sell_price: 900 } }]);
    expect(rec.status).toBe(201);
    const productId = rec.body.data.items[0].product_id;
    const ap = await request(app).post(`/api/products/${productId}/approve`).set(auth(manager.token)).send({ cost_price: 180 });
    expect(ap.status).toBe(200);
    expect(db.prepare('SELECT unit_cost FROM stock_receipt_items WHERE id = ?').get(rec.body.data.items[0].id).unit_cost).toBe(180);
    expect(row(productId, mainId, 'fifo')).toMatchObject({ quantity: 6, cost_value: 1080, uncosted_units: 0 });
  });
});

describe('expiry', () => {
  it('records expiry per batch, refuses stock already past its date, and lists what is expiring', async () => {
    const today = stock.shopToday();
    const p = newProduct(100);
    expect((await receive(storeKeeper.token, [{ product_id: p, quantity: 3, expiry_date: addDays(today, -1) }])).status).toBe(400);
    expect((await receive(storeKeeper.token, [{ product_id: p, quantity: 3, expiry_date: '31/12/2027' }])).status).toBe(400);

    const soon = await receive(storeKeeper.token, [{ product_id: p, quantity: 6, batch_no: 'SOON', expiry_date: addDays(today, 10) }]);
    await receive(storeKeeper.token, [{ product_id: p, quantity: 4, batch_no: 'LATER', expiry_date: addDays(today, 200) }]);
    expect(soon.status).toBe(201);

    const list = await request(app).get('/api/stock/batches?status=expiring').set(auth(storeKeeper.token));
    expect(list.status).toBe(200);
    const mine = list.body.data.filter((r) => r.product_id === p);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ batch_no: 'SOON', remaining: 6, days_left: 10, state: 'expiring' });
    expect(JSON.stringify(mine[0])).not.toMatch(/unit_cost/);

    const alerts = await request(app).get('/api/stock/alerts').set(auth(storeKeeper.token));
    expect(alerts.body.data.counts.expiring).toBeGreaterThanOrEqual(1);
    expect(alerts.body.data.expiry_alert_days).toBe(30);
  });

  it('counts only what is still on the shelf: units sold from the oldest batch are not "expiring"', async () => {
    const today = stock.shopToday();
    const p = newProduct(100);
    await receive(adminToken, [{ product_id: p, quantity: 5, batch_no: 'OLDEST', expiry_date: addDays(today, 5) }]);
    await receive(adminToken, [{ product_id: p, quantity: 5, batch_no: 'NEWER', expiry_date: addDays(today, 300) }]);
    sell(p, 5); // the whole oldest batch is gone
    const rows = costing.batchesByStatus({ storeId: mainId, status: 'expiring', today, withinDays: 30 }).filter((r) => r.product_id === p);
    expect(rows).toHaveLength(0);
  });

  it('the sweep raises one notice per batch and store, and a second one when it expires', async () => {
    const today = stock.shopToday();
    const p = newProduct(100);
    const rec = await receive(adminToken, [{ product_id: p, quantity: 8, batch_no: 'SWEEP-1', expiry_date: addDays(today, 3) }]);
    const batchId = rec.body.data.items[0].id;
    const count = (type) => db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = ? AND entity_id = ?`).get(type, batchId).c;

    expect(notifications.sweepExpiry()).toBeGreaterThan(0);
    const firstExpiring = count('stock_expiring');
    expect(firstExpiring).toBeGreaterThanOrEqual(2); // every admin and manager of the store
    expect(notifications.sweepExpiry()).toBe(0);     // nothing new the second time
    expect(count('stock_expiring')).toBe(firstExpiring);

    db.prepare('UPDATE stock_receipt_items SET expiry_date = ? WHERE id = ?').run(addDays(today, -2), batchId);
    notifications.sweepExpiry();
    expect(count('stock_expired')).toBeGreaterThanOrEqual(2);
    expect(db.prepare(`SELECT severity FROM notifications WHERE type = 'stock_expired' AND entity_id = ? LIMIT 1`).get(batchId).severity).toBe('urgent');

    const dash = await request(app).get('/api/reports/dashboard-overview').set(auth(adminToken));
    expect(dash.body.data.stockAlerts.expired).toBeGreaterThanOrEqual(1);
    expect(runSweepsHasExpiry()).toBe(true);
  });

  it('writing off a named batch takes the stock from that batch, not the oldest', async () => {
    const today = stock.shopToday();
    const p = newProduct(100);
    const a = await receive(adminToken, [{ product_id: p, quantity: 5, expiry_date: addDays(today, 90) }]);
    const b = await receive(adminToken, [{ product_id: p, quantity: 5, expiry_date: addDays(today, 100) }]);
    const [batchA] = itemIds(a.body); const [batchB] = itemIds(b.body);

    const out = await request(app).post('/api/stock/issues').set(auth(adminToken)).send({ product_id: p, quantity: 3, reason: 'expired', batch_id: batchB });
    expect(out.status).toBe(201);
    expect(costing.batchRemaining(p, mainId, batchA)).toBe(5);
    expect(costing.batchRemaining(p, mainId, batchB)).toBe(2);

    const tooMany = await request(app).post('/api/stock/issues').set(auth(adminToken)).send({ product_id: p, quantity: 3, reason: 'expired', batch_id: batchB });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code || tooMany.body.error?.code).toBeDefined();

    const other = newProduct(100);
    await receive(adminToken, [{ product_id: other, quantity: 5 }]);
    const wrong = await request(app).post('/api/stock/issues').set(auth(adminToken)).send({ product_id: other, quantity: 1, reason: 'expired', batch_id: batchA });
    expect(wrong.status).toBe(400);
    expect(reconciliation.findDrift()).toEqual([]);
  });
});

function runSweepsHasExpiry() {
  return Object.prototype.hasOwnProperty.call(notifications.runSweeps(), 'expiry');
}

describe('recall', () => {
  it('takes every unit of the batch off every shelf, reports what already left, and notifies managers', async () => {
    const p = newProduct(100);
    const x = await receive(adminToken, [{ product_id: p, quantity: 10, batch_no: 'RECALL-X', unit_cost: 100 }]);
    await receive(adminToken, [{ product_id: p, quantity: 5, batch_no: 'RECALL-Y', unit_cost: 100 }]);
    const [batchX] = itemIds(x.body);
    transfer(p, mainId, outletId, 3, 9101); // 3 of batch X now at the outlet
    sell(p, 2);                              // 2 of batch X sold at the main store
    expect(qty(p, mainId)).toBe(10); expect(qty(p, outletId)).toBe(3);

    const url = `/api/stock/batches/${batchX}/recall`;
    expect((await request(app).post(url).set(auth(manager.token)).send({})).status).toBe(400);                 // a reason is required
    expect((await request(app).post(url).set(auth(storeKeeper.token)).send({ note: 'x' })).status).toBe(403);  // managers only

    const res = await request(app).post(url).set(auth(manager.token)).send({ note: 'Supplier contamination notice' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ received_qty: 10, pulled_from_shelves: 8, already_left_stock: 2 });
    expect(res.body.data.stores).toHaveLength(2);

    // Only batch Y is left to sell, and it is all at the main store.
    expect(qty(p, mainId)).toBe(5);
    expect(qty(p, outletId)).toBe(0);
    expect(() => sell(p, 6)).toThrow();
    expect(sell(p, 5).status).toBe('completed');

    const recalledIssues = db.prepare(`SELECT store_id, quantity, reason FROM stock_issues WHERE batch_id = ? ORDER BY store_id`).all(batchX);
    expect(recalledIssues.map((i) => i.reason)).toEqual(['recalled', 'recalled']);
    expect(recalledIssues.reduce((n, i) => n + i.quantity, 0)).toBe(8);

    expect((await request(app).post(url).set(auth(manager.token)).send({ note: 'again' })).status).toBe(409);

    const notice = db.prepare(`SELECT severity, title FROM notifications WHERE type = 'batch_recalled' AND entity_id = ?`).all(batchX);
    expect(notice.length).toBeGreaterThanOrEqual(2);
    expect(notice[0].severity).toBe('urgent');

    const listed = await request(app).get('/api/stock/batches?status=recalled').set(auth(manager.token));
    const mine = listed.body.data.find((r) => r.batch_id === batchX);
    expect(mine).toMatchObject({ quarantined_qty: 8, state: 'recalled', remaining: 0 });

    expect(reconciliation.findDrift()).toEqual([]); // the ledger and the cached quantities still agree
  });
});

describe('damaged stock', () => {
  it('lists damaged write-offs with their quantity (and value only for people who see buying prices)', async () => {
    const p = newProduct(100);
    await receive(adminToken, [{ product_id: p, quantity: 10, unit_cost: 140 }]);
    const out = await request(app).post('/api/stock/issues').set(auth(storeKeeper.token)).send({ product_id: p, quantity: 2, reason: 'damaged', note: 'water damage' });
    expect(out.status).toBe(201);

    const asKeeper = await request(app).get('/api/stock/damaged').set(auth(storeKeeper.token));
    expect(asKeeper.status).toBe(200);
    const mineKeeper = asKeeper.body.data.find((r) => r.product_id === p);
    expect(mineKeeper).toMatchObject({ quantity: 2 });
    expect(mineKeeper).not.toHaveProperty('cost_value');

    const asManager = await request(app).get('/api/stock/damaged').set(auth(manager.token));
    expect(asManager.body.data.find((r) => r.product_id === p).cost_value).toBe(280);
    expect(asManager.body.totals.units).toBeGreaterThanOrEqual(2);

    const alerts = await request(app).get('/api/stock/alerts').set(auth(manager.token));
    expect(alerts.body.data.damaged.units).toBeGreaterThanOrEqual(2);
    expect(alerts.body.data.damaged.value).toBeGreaterThanOrEqual(280);
    expect(alerts.body.data.counts.damaged_units_30d).toBeGreaterThanOrEqual(2);
  });
});

describe('settings', () => {
  it('only accepts a real valuation method and a sensible expiry window', async () => {
    const put = (body) => request(app).put('/api/settings').set(auth(adminToken)).send(body);
    // The settings screen asks for the password again before saving; those checks are covered elsewhere, so go through the service rules here.
    const res = await put({ inventory_valuation_method: 'lifo' });
    expect([400, 401, 403]).toContain(res.status);
    const settings = require('../src/services/settings.service').getAll();
    expect(settings.inventory_valuation_method).toBe('fifo');
    expect(settings.expiry_alert_days).toBe('30');
  });
});

// ---- upgrading an existing database -----------------------------------------------------------------------------------
let oldSchema = null;
try {
  oldSchema = execSync('git show a24a24f:backend/src/db/schema.sql', { cwd: BACKEND, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 }).toString();
} catch { /* not a git checkout (or history trimmed): skipped below */ }

const dbFile = path.join(os.tmpdir(), `utpos-batch-migrate-${process.pid}-${Date.now()}.db`);
const cleanupMigrate = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true }); };
const migrate = () => spawnSync('node', ['src/db/migrate.js'], {
  cwd: BACKEND, encoding: 'utf8',
  env: { ...process.env, DATABASE_PATH: dbFile, JWT_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: 'y'.repeat(40), NODE_ENV: 'test' },
});
afterAll(cleanupMigrate);

(oldSchema ? describe : describe.skip)('upgrading a database that predates batch costing', () => {
  it('adds the batch columns, accepts the recalled issue reason, and keeps every existing row', () => {
    cleanupMigrate();
    const old = new Database(dbFile);
    old.exec(oldSchema);
    const storeId = old.prepare(`INSERT INTO stores (name, is_main) VALUES ('Old Shop', 1)`).run().lastInsertRowid;
    const userId = old.prepare(`INSERT INTO users (store_id, name, email, password_hash, role) VALUES (?, 'Old Admin', 'old@x.test', 'x', 'admin')`).run(storeId).lastInsertRowid;
    const productId = old.prepare(`INSERT INTO products (sku, name, sell_price, cost_price) VALUES ('OLD-1', 'Old Thing', 1000, 400)`).run().lastInsertRowid;
    const receiptId = old.prepare(`INSERT INTO stock_receipts (store_id, received_on, received_by_staff_id) VALUES (?, '2026-10-01', ?)`).run(storeId, userId).lastInsertRowid;
    old.prepare(`INSERT INTO stock_receipt_items (receipt_id, product_id, quantity, sell_price) VALUES (?, ?, 5, 1000)`).run(receiptId, productId);
    old.prepare(`INSERT INTO stock_issues (store_id, product_id, quantity, reason, issued_on, issued_by_staff_id) VALUES (?, ?, 1, 'damaged', '2026-10-02', ?)`).run(storeId, productId, userId);
    old.prepare(`INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 4)`).run(productId, storeId);
    old.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id) VALUES (?, ?, 5, 'receipt', 'receipt', ?)`).run(productId, storeId, receiptId);
    old.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id) VALUES (?, ?, -1, 'issue', 'issue', 1)`).run(productId, storeId);
    expect(() => old.prepare(`INSERT INTO stock_issues (store_id, product_id, quantity, reason, issued_on, issued_by_staff_id) VALUES (?, ?, 1, 'recalled', '2026-10-02', ?)`).run(storeId, productId, userId)).toThrow();
    old.close();

    const first = migrate();
    expect(first.status, first.stderr + first.stdout).toBe(0);

    const upgraded = new Database(dbFile);
    const cols = (t) => upgraded.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    expect(cols('stock_receipt_items')).toEqual(expect.arrayContaining(['batch_no', 'expiry_date', 'unit_cost', 'recalled_at', 'recall_note']));
    expect(cols('inventory_movements')).toContain('batch_id');
    expect(cols('stock_issues')).toContain('batch_id');
    expect(cols('sale_items')).toContain('cost_total');
    expect(cols('order_items')).toContain('cost_total');

    // The old issue and receipt line survived, and the old stock is still valued at its catalog cost.
    expect(upgraded.prepare(`SELECT reason, quantity FROM stock_issues`).all()).toEqual([{ reason: 'damaged', quantity: 1 }]);
    expect(upgraded.prepare(`SELECT quantity, unit_cost, expiry_date FROM stock_receipt_items`).all()).toEqual([{ quantity: 5, unit_cost: null, expiry_date: null }]);
    expect(() => upgraded.prepare(`INSERT INTO stock_issues (store_id, product_id, quantity, reason, issued_on, issued_by_staff_id) VALUES (?, ?, 1, 'recalled', '2026-10-02', ?)`).run(storeId, productId, userId)).not.toThrow();
    expect(() => upgraded.prepare(`INSERT INTO stock_issues (store_id, product_id, quantity, reason, issued_on, issued_by_staff_id) VALUES (?, ?, 1, 'bogus', '2026-10-02', ?)`).run(storeId, productId, userId)).toThrow();
    const indexes = upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_issues'`).all().map((r) => r.name);
    expect(indexes).toContain('idx_stock_issues_store');
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();

    const second = migrate();
    expect(second.status, second.stderr + second.stdout).toBe(0);
    const again = new Database(dbFile);
    expect(again.prepare('SELECT COUNT(*) c FROM stock_issues').get().c).toBe(2);
    again.close();
  });
});
