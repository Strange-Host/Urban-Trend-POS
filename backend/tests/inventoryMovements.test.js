const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

// GET /api/inventory/:productId/movements (paged, branch-aware) and the reconcile pair behind the Stock control
// "Reconcile" tab: GET reports drift between inventory.quantity and the ledger, POST (admin) resets it.

const PASSWORD = 'Passw0rd!Passw0rd';
let adminToken; let manager; let cashier; let mainId; let outletId; let product;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (url, t = adminToken) => request(app).get(url).set(auth(t));

async function makeUser(role, email, storeId) {
  db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `Test ${role}`, email, bcrypt.hashSync(PASSWORD, 4), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { token: login.body.token };
}

// Writes ledger rows and the cached quantity together, the way the real code paths do, so the ledger still adds up.
function seedMovements(productId, storeId, n, reason = 'restock') {
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      db.prepare('INSERT INTO inventory_movements (product_id, store_id, change_qty, reason) VALUES (?, ?, 1, ?)').run(productId, storeId, reason);
    }
    const row = db.prepare('SELECT id FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
    if (row) db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE id = ?').run(n, row.id);
    else db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)').run(productId, storeId, n);
  })();
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  mainId = db.prepare('SELECT id FROM stores WHERE is_main = 1').get().id;
  outletId = (await request(app).post('/api/stores').set(auth(adminToken)).send({ name: 'Movements Outlet', address: 'Westlands' })).body.data.id;
  manager = await makeUser('manager', 'mv-manager@urbantrends.com', mainId);
  cashier = await makeUser('cashier', 'mv-cashier@urbantrends.com', mainId);
  product = (await get('/api/products?pageSize=1')).body.data[0];
});
afterAll(() => cleanupTestDb());

describe('GET /api/inventory/:productId/movements', () => {
  it('pages through every movement, newest first, none repeated or skipped', async () => {
    const before = db.prepare('SELECT COUNT(*) AS c FROM inventory_movements WHERE product_id = ? AND store_id = ?').get(product.id, mainId).c;
    seedMovements(product.id, mainId, 30);
    const total = before + 30;

    const first = (await get(`/api/inventory/${product.id}/movements?page=1&limit=25`)).body;
    expect(first).toMatchObject({ total, page: 1, limit: 25, totalPages: Math.ceil(total / 25) });
    expect(first.data).toHaveLength(25);
    const second = (await get(`/api/inventory/${product.id}/movements?page=2&limit=25`)).body;
    expect(second.data).toHaveLength(total - 25);

    const ids = [...first.data, ...second.data].map((m) => m.id);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));      // newest (highest id) first, even within the same second
    expect((await get(`/api/inventory/${product.id}/movements?page=99&limit=25`)).body.data).toHaveLength(0);   // past the end: empty, not an error
  });

  it('defaults to 25 a page and never returns more than 100', async () => {
    expect((await get(`/api/inventory/${product.id}/movements`)).body).toMatchObject({ limit: 25 });
    const big = (await get(`/api/inventory/${product.id}/movements?limit=5000`)).body;
    expect(big.limit).toBe(100);
    expect(big.data.length).toBeLessThanOrEqual(100);
  });

  it('shows who made each change and what it referred to', async () => {
    const adjust = await request(app).post('/api/inventory/adjust').set(auth(adminToken)).send({ product_id: product.id, change_qty: 3, reason: 'restock' });
    expect(adjust.status).toBe(200);
    const top = (await get(`/api/inventory/${product.id}/movements?limit=1`)).body.data[0];
    const adminName = db.prepare(`SELECT name FROM users WHERE email = 'admin@urbantrends.com'`).get().name;
    expect(top).toMatchObject({ change_qty: 3, reason: 'restock', user_name: adminName });
    expect(top).toHaveProperty('reference_type');
    expect(top).toHaveProperty('reference_id');
  });

  it('rejects a product id that is not a whole number', async () => {
    expect((await get('/api/inventory/abc/movements')).status).toBe(400);
    expect((await get('/api/inventory/0/movements')).status).toBe(400);
  });

  it('only returns the branch asked for', async () => {
    seedMovements(product.id, outletId, 4, 'receipt');
    const outlet = (await get(`/api/inventory/${product.id}/movements?store_id=${outletId}`)).body;
    expect(outlet.total).toBe(4);
    expect(outlet.data.every((m) => m.store_id === outletId)).toBe(true);
    const main = (await get(`/api/inventory/${product.id}/movements`)).body;
    expect(main.data.every((m) => m.store_id === mainId)).toBe(true);
  });

  it('lets a stock reviewer look at another branch, and nobody else', async () => {
    expect((await get(`/api/inventory/${product.id}/movements?store_id=${outletId}`, manager.token)).status).toBe(200);
    const denied = await get(`/api/inventory/${product.id}/movements?store_id=${outletId}`, cashier.token);
    expect(denied.status).toBe(403);
    expect((await get(`/api/inventory/${product.id}/movements?store_id=${mainId}`, cashier.token)).status).toBe(200);   // their own branch
    expect((await get(`/api/inventory/${product.id}/movements?store_id=999999`)).status).toBe(404);
  });

  it('needs a signed-in user', async () => {
    expect((await request(app).get(`/api/inventory/${product.id}/movements`)).status).toBe(401);
  });
});

describe('inventory reconcile', () => {
  const drift = async () => (await get('/api/inventory/reconcile')).body.data;
  const cached = (storeId = mainId) => db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(product.id, storeId).quantity;

  it('reports nothing while the ledger and the stored quantities agree', async () => {
    expect(await drift()).toEqual([]);
  });

  it('is for people who may adjust stock', async () => {
    expect((await get('/api/inventory/reconcile', manager.token)).status).toBe(200);
    expect((await get('/api/inventory/reconcile', cashier.token)).status).toBe(403);
  });

  it('reports a stored quantity that changed without a ledger entry, and does not change it', async () => {
    db.prepare('UPDATE inventory SET quantity = quantity + 5 WHERE product_id = ? AND store_id = ?').run(product.id, mainId);
    const found = await drift();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ product_id: product.id, store_id: mainId, drift: 5, product_name: product.name });
    expect(found[0].cached_quantity - found[0].ledger_quantity).toBe(5);
    const stillDrifted = cached();
    await drift();
    expect(cached()).toBe(stillDrifted);            // checking is read-only
  });

  it('is only reset by an admin', async () => {
    const asManager = await request(app).post('/api/inventory/reconcile').set(auth(manager.token));
    expect(asManager.status).toBe(403);
    expect(await drift()).toHaveLength(1);          // nothing changed
  });

  it('resets the stored quantity to the ledger, writes no movement, and then finds no drift', async () => {
    const movementsBefore = db.prepare('SELECT COUNT(*) AS c FROM inventory_movements').get().c;
    const res = await request(app).post('/api/inventory/reconcile').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ product_id: product.id, drift: 5 });
    expect(await drift()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM inventory_movements').get().c).toBe(movementsBefore);
  });

  it('leaves a row listed when its ledger total is below zero (stock cannot go negative)', async () => {
    // A ledger that sums below zero: a reset can only take the stored quantity to 0, so the row stays reported.
    db.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason) VALUES (?, ?, ?, 'adjustment')`).run(product.id, mainId, -(cached() + 3));
    const res = await request(app).post('/api/inventory/reconcile').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(cached()).toBe(0);
    const left = await drift();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ product_id: product.id, cached_quantity: 0, ledger_quantity: -3, drift: 3 });
  });
});
