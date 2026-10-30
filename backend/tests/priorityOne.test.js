const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

// Priority 1: the storekeeper ('store') role, hidden buying prices with product approval,
// expense approval, and petty cash.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const today = new Date().toISOString().slice(0, 10);
const PASSWORD = 'Passw0rd!Passw0rd';

let adminToken;
let storeKeeper;
let manager;
let manager2;
let cashier;
let categoryId;

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} p1`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token, loginBody: login.body };
}

const dbCost = (sku) => db.prepare('SELECT cost_price FROM products WHERE sku = ?').get(sku).cost_price;

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  storeKeeper = await makeUser('store', 'p1-store@urbantrends.com');
  manager = await makeUser('manager', 'p1-manager@urbantrends.com');
  manager2 = await makeUser('manager', 'p1-manager2@urbantrends.com');
  cashier = await makeUser('cashier', 'p1-cashier@urbantrends.com');
  categoryId = db.prepare('SELECT id FROM expense_categories LIMIT 1').get().id;
});

afterAll(() => cleanupTestDb());

describe('store role', () => {
  it('signs in, and its permissions are narrow', () => {
    expect(storeKeeper.token).toBeTruthy();
    const perms = storeKeeper.loginBody.user.permissions;
    expect(perms).toContain('products.propose');
    expect(perms).not.toContain('products.manage');
    expect(perms).not.toContain('products.view_cost');
    expect(perms).not.toContain('expenses.manage');
  });

  it('has no till: cannot sell, browse sales or open a cash session', async () => {
    expect((await request(app).post('/api/sales').set(auth(storeKeeper.token)).send({})).status).toBe(403);
    expect((await request(app).get('/api/sales').set(auth(storeKeeper.token))).status).toBe(403);
    expect((await request(app).post('/api/cash-sessions/open').set(auth(storeKeeper.token)).send({ opening_amount: 0 })).status).toBe(403);
    expect((await request(app).get('/api/cash-sessions/current').set(auth(storeKeeper.token))).status).toBe(403);
  });

  it('can still look at stock, and cannot reach money or staff screens', async () => {
    expect((await request(app).get('/api/inventory').set(auth(storeKeeper.token))).status).toBe(200);
    expect((await request(app).get('/api/expenses').set(auth(storeKeeper.token))).status).toBe(403);
    expect((await request(app).get('/api/petty-cash').set(auth(storeKeeper.token))).status).toBe(403);
    expect((await request(app).get('/api/staff').set(auth(storeKeeper.token))).status).toBe(403);
    expect((await request(app).get('/api/reports/profit-summary').set(auth(storeKeeper.token))).status).toBe(403);
  });

  it('an admin can create a storekeeper through the staff API', async () => {
    const res = await request(app).post('/api/staff').set(auth(adminToken))
      .send({ name: 'New Keeper', email: 'p1-newkeeper@urbantrends.com', phone: '0711000111', password: 'Sturdy-Pass-Word-91', role: 'store' });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('store');
  });
});

describe('buying price is hidden from people who may not see it', () => {
  const sku = 'P1-COST-1';
  let productId;

  beforeAll(async () => {
    const res = await request(app).post('/api/products').set(auth(adminToken))
      .send({ sku, barcode: 'P1BARCODE1', name: 'Cost Test Item', cost_price: 7777, sell_price: 12000 });
    productId = res.body.data.id;
    expect(res.status).toBe(201);
  });

  it('admin and manager see cost_price everywhere', async () => {
    for (const t of [adminToken, manager.token]) {
      const list = await request(app).get('/api/products?q=P1-COST-1').set(auth(t));
      expect(list.body.data[0].cost_price).toBe(7777);
      expect((await request(app).get(`/api/products/${productId}`).set(auth(t))).body.data.cost_price).toBe(7777);
      expect((await request(app).get('/api/products/barcode/P1BARCODE1').set(auth(t))).body.data.cost_price).toBe(7777);
    }
  });

  it('cashier and storekeeper never receive cost_price (list, single, barcode)', async () => {
    for (const t of [cashier.token, storeKeeper.token]) {
      const list = await request(app).get('/api/products?q=P1-COST-1').set(auth(t));
      expect(list.status).toBe(200);
      expect(list.body.data[0]).not.toHaveProperty('cost_price');
      expect(list.body.data[0].sell_price).toBe(12000);
      const one = await request(app).get(`/api/products/${productId}`).set(auth(t));
      expect(one.body.data).not.toHaveProperty('cost_price');
      const bc = await request(app).get('/api/products/barcode/P1BARCODE1').set(auth(t));
      expect(bc.body.data).not.toHaveProperty('cost_price');
      expect(JSON.stringify(list.body)).not.toContain('7777');
    }
  });

  it('someone allowed to edit products but not see cost cannot change cost either, and is not shown it', async () => {
    await request(app).put(`/api/staff/${cashier.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'products.manage': true } });
    const res = await request(app).put(`/api/products/${productId}`).set(auth(cashier.token)).send({ cost_price: 1, name: 'Renamed by cashier' });
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('cost_price');
    expect(res.body.data.name).toBe('Renamed by cashier');
    expect(dbCost(sku)).toBe(7777);
    await request(app).put(`/api/staff/${cashier.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'products.manage': null } });
  });

  it('granting products.view_cost reveals it to that one person', async () => {
    await request(app).put(`/api/staff/${cashier.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'products.view_cost': true } });
    const list = await request(app).get('/api/products?q=P1-COST-1').set(auth(cashier.token));
    expect(list.body.data[0].cost_price).toBe(7777);
    await request(app).put(`/api/staff/${cashier.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'products.view_cost': null } });
  });
});

describe('product proposals (approval workflow)', () => {
  let proposed;

  it('a storekeeper proposal is saved pending and inactive, and any cost they typed is discarded', async () => {
    const res = await request(app).post('/api/products').set(auth(storeKeeper.token))
      .send({ sku: 'P1-NEW-1', name: 'New Shipment Item', cost_price: 5555, sell_price: 9000 });
    expect(res.status).toBe(201);
    proposed = res.body.data;
    expect(proposed.approval_status).toBe('pending');
    expect(proposed.is_active).toBe(0);
    expect(proposed).not.toHaveProperty('cost_price');
    expect(dbCost('P1-NEW-1')).toBe(0);
  });

  it('a pending product cannot be sold or found in the normal catalogue', async () => {
    const list = await request(app).get('/api/products?q=P1-NEW-1').set(auth(adminToken));
    expect(list.body.data).toHaveLength(0);
    const sale = await request(app).post('/api/sales').set(auth(cashier.token))
      .send({ items: [{ product_id: proposed.id, quantity: 1 }], payments: [{ method: 'cash', amount: 9000 }] });
    expect([400, 404, 409, 422]).toContain(sale.status); // refused as a client error, not a server error
    expect(db.prepare('SELECT COUNT(*) c FROM sale_items WHERE product_id = ?').get(proposed.id).c).toBe(0);
  });

  it('managers are notified, and the proposal shows in the pending list', async () => {
    const n = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'product_proposed'`).get(manager.id).c;
    expect(n).toBeGreaterThan(0);
    const pending = await request(app).get('/api/products/pending/list').set(auth(manager.token));
    expect(pending.status).toBe(200);
    expect(pending.body.data.map((p) => p.sku)).toContain('P1-NEW-1');
    expect(pending.body.data.find((p) => p.sku === 'P1-NEW-1').submitted_by_name).toBe('store p1');
  });

  it('only the submitter and approvers can open a pending product', async () => {
    expect((await request(app).get(`/api/products/${proposed.id}`).set(auth(storeKeeper.token))).status).toBe(200);
    expect((await request(app).get(`/api/products/${proposed.id}`).set(auth(manager.token))).status).toBe(200);
    expect((await request(app).get(`/api/products/${proposed.id}`).set(auth(cashier.token))).status).toBe(404);
  });

  it('the storekeeper cannot edit, delete, approve or reject', async () => {
    expect((await request(app).put(`/api/products/${proposed.id}`).set(auth(storeKeeper.token)).send({ sell_price: 1 })).status).toBe(403);
    expect((await request(app).delete(`/api/products/${proposed.id}`).set(auth(storeKeeper.token))).status).toBe(403);
    expect((await request(app).post(`/api/products/${proposed.id}/approve`).set(auth(storeKeeper.token)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/products/${proposed.id}/reject`).set(auth(storeKeeper.token)).send({ note: 'x' })).status).toBe(403);
  });

  it('a manager approves it, entering the buying price; it becomes sellable', async () => {
    const res = await request(app).post(`/api/products/${proposed.id}/approve`).set(auth(manager.token)).send({ cost_price: 4200 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ approval_status: 'approved', is_active: 1, cost_price: 4200 });
    expect(dbCost('P1-NEW-1')).toBe(4200);

    const asKeeper = await request(app).get('/api/products?q=P1-NEW-1').set(auth(storeKeeper.token));
    expect(asKeeper.body.data).toHaveLength(1);
    expect(asKeeper.body.data[0]).not.toHaveProperty('cost_price');
    expect((await request(app).post(`/api/products/${proposed.id}/approve`).set(auth(manager.token)).send({})).status).toBe(409);
  });

  it('rejecting needs a reason, hides the product, and tells the storekeeper', async () => {
    const p = (await request(app).post('/api/products').set(auth(storeKeeper.token)).send({ sku: 'P1-NEW-2', name: 'Bad Item', sell_price: 100 })).body.data;
    expect((await request(app).post(`/api/products/${p.id}/reject`).set(auth(manager.token)).send({})).status).toBe(400);
    const res = await request(app).post(`/api/products/${p.id}/reject`).set(auth(manager.token)).send({ note: 'Wrong price' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ approval_status: 'rejected', is_active: 0, review_note: 'Wrong price' });
    const n = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'product_rejected'`).get(storeKeeper.id).c;
    expect(n).toBe(1);
  });

  it('nobody but an admin can approve their own proposal', async () => {
    await request(app).put(`/api/staff/${storeKeeper.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'products.approve': true } });
    const p = (await request(app).post('/api/products').set(auth(storeKeeper.token)).send({ sku: 'P1-NEW-3', name: 'Self Approve', sell_price: 100 })).body.data;
    const res = await request(app).post(`/api/products/${p.id}/approve`).set(auth(storeKeeper.token)).send({});
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT approval_status FROM products WHERE id = ?').get(p.id).approval_status).toBe('pending');
    await request(app).put(`/api/staff/${storeKeeper.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'products.approve': null } });
  });

  it('a manager creating a product still creates it straight away', async () => {
    const res = await request(app).post('/api/products').set(auth(manager.token)).send({ sku: 'P1-DIRECT', name: 'Direct', cost_price: 10, sell_price: 20 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ approval_status: 'approved', is_active: 1 });
  });

  it('a cashier cannot propose or create products', async () => {
    expect((await request(app).post('/api/products').set(auth(cashier.token)).send({ sku: 'P1-NOPE', name: 'Nope', sell_price: 1 })).status).toBe(403);
  });
});

describe('expense approval', () => {
  const create = (token, amount = 10000, extra = {}) =>
    request(app).post('/api/expenses').set(auth(token)).send({ category_id: categoryId, amount, description: 'p1 test', expense_date: today, ...extra });
  const summary = async () => (await request(app).get(`/api/expenses/summary?from=${today}&to=${today}`).set(auth(adminToken))).body.data;
  const profitExpenses = async () => (await request(app).get(`/api/reports/profit-summary?from=${today}&to=${today}`).set(auth(adminToken))).body.data.businessExpenses;

  it('a manager\'s expense is pending and does not count until approved', async () => {
    const before = await summary();
    const profitBefore = await profitExpenses();
    const res = await create(manager.token, 12345);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');

    const mid = await summary();
    expect(mid.grand_total).toBe(before.grand_total);
    expect(mid.pending_count).toBe(before.pending_count + 1);
    expect(mid.pending_total).toBe(before.pending_total + 12345);
    expect(await profitExpenses()).toBe(profitBefore);

    const ap = await request(app).post(`/api/expenses/${res.body.data.id}/approve`).set(auth(manager2.token));
    expect(ap.status).toBe(200);
    expect(ap.body.data).toMatchObject({ status: 'approved', reviewed_by_staff_id: manager2.id });

    const after = await summary();
    expect(after.grand_total).toBe(before.grand_total + 12345);
    expect(after.pending_count).toBe(before.pending_count);
    expect(await profitExpenses()).toBe(profitBefore + 12345);
  });

  it('nobody approves their own expense, and a cashier cannot approve at all', async () => {
    const e = (await create(manager.token)).body.data;
    expect((await request(app).post(`/api/expenses/${e.id}/approve`).set(auth(manager.token))).status).toBe(403);
    expect((await request(app).post(`/api/expenses/${e.id}/approve`).set(auth(cashier.token))).status).toBe(403);
    expect((await request(app).post(`/api/expenses/${e.id}/approve`).set(auth(storeKeeper.token))).status).toBe(403);
    expect(db.prepare('SELECT status FROM expenses WHERE id = ?').get(e.id).status).toBe('pending');
  });

  it('an admin\'s own expense is approved on the spot', async () => {
    const res = await create(adminToken, 500);
    expect(res.body.data).toMatchObject({ status: 'approved' });
    expect(res.body.data.reviewed_by_staff_id).toBeTruthy();
  });

  it('rejecting needs a note; a rejected expense never counts; editing it sends it back for approval', async () => {
    const before = await summary();
    const e = (await create(manager.token, 777)).body.data;
    expect((await request(app).post(`/api/expenses/${e.id}/reject`).set(auth(manager2.token)).send({})).status).toBe(400);
    const rej = await request(app).post(`/api/expenses/${e.id}/reject`).set(auth(manager2.token)).send({ note: 'No receipt' });
    expect(rej.body.data).toMatchObject({ status: 'rejected', review_note: 'No receipt' });
    expect((await summary()).grand_total).toBe(before.grand_total);

    // already decided
    expect((await request(app).post(`/api/expenses/${e.id}/approve`).set(auth(manager2.token))).status).toBe(409);

    const fix = await request(app).patch(`/api/expenses/${e.id}`).set(auth(manager.token)).send({ receipt_url: 'https://x.test/r.png' });
    expect(fix.body.data).toMatchObject({ status: 'pending', review_note: null, reviewed_by_staff_id: null });
  });

  it('editing an approved expense needs a new approval unless an admin does it', async () => {
    const e = (await create(adminToken, 1000)).body.data;
    const byAdmin = await request(app).patch(`/api/expenses/${e.id}`).set(auth(adminToken)).send({ amount: 1100 });
    expect(byAdmin.body.data.status).toBe('approved');
    const byManager = await request(app).patch(`/api/expenses/${e.id}`).set(auth(manager.token)).send({ amount: 9999 });
    expect(byManager.body.data.status).toBe('pending');
  });

  it('only an admin can delete an approved expense', async () => {
    const approved = (await create(adminToken, 1)).body.data;
    expect((await request(app).delete(`/api/expenses/${approved.id}`).set(auth(manager.token))).status).toBe(403);
    expect((await request(app).delete(`/api/expenses/${approved.id}`).set(auth(adminToken))).status).toBe(204);

    const pending = (await create(manager.token, 2)).body.data;
    expect((await request(app).delete(`/api/expenses/${pending.id}`).set(auth(manager.token))).status).toBe(204);
  });

  it('can be filtered by status and records who decided', async () => {
    const res = await request(app).get('/api/expenses?status=approved&limit=50').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.every((e) => e.status === 'approved')).toBe(true);
    expect(res.body.data.some((e) => e.reviewed_by_name)).toBe(true);
  });

  it('approvals and rejections are written to the audit log, showing the status change', () => {
    const rows = db.prepare(`SELECT changes FROM staff_logs WHERE entity_type = 'expense' AND action = 'update'`).all().map((r) => JSON.parse(r.changes));
    expect(rows.some((c) => c.status && c.status.from === 'pending' && c.status.to === 'approved')).toBe(true);
    expect(rows.some((c) => c.status && c.status.from === 'pending' && c.status.to === 'rejected')).toBe(true);
  });

  it('product approvals are audited too, and the log never contains a buying price', () => {
    const rows = db.prepare(`SELECT changes FROM staff_logs WHERE entity_type = 'product'`).all().map((r) => r.changes);
    expect(rows.some((c) => c.includes('"approval_status"'))).toBe(true);
    expect(rows.join('')).not.toContain('cost_price');
  });
});

describe('petty cash', () => {
  const spend = (token, amount) => request(app).post('/api/expenses').set(auth(token))
    .send({ category_id: categoryId, amount, description: 'petty spend', expense_date: today, paid_from: 'petty_cash' });
  const figures = async () => (await request(app).get('/api/petty-cash').set(auth(adminToken))).body.data;

  it('starts empty: spending from it is refused', async () => {
    const f = await figures();
    expect(f.available).toBe(0);
    const res = await spend(manager.token, 100);
    expect(res.status).toBe(409);
    expect(res.body.code || res.body.error?.code).toBeDefined();
  });

  it('an admin top-up counts at once; a manager top-up waits for a different approver', async () => {
    const a = await request(app).post('/api/petty-cash/topups').set(auth(adminToken)).send({ amount: 50000, note: 'float' });
    expect(a.status).toBe(201);
    expect(a.body.data.status).toBe('approved');
    expect((await figures()).available).toBe(50000);

    const m = await request(app).post('/api/petty-cash/topups').set(auth(manager.token)).send({ amount: 10000, note: 'more' });
    expect(m.body.data.status).toBe('pending');
    expect((await figures()).available).toBe(50000);
    expect((await figures()).pending_topup_count).toBe(1);

    expect((await request(app).post(`/api/petty-cash/topups/${m.body.data.id}/approve`).set(auth(manager.token))).status).toBe(403);
    expect((await request(app).post(`/api/petty-cash/topups/${m.body.data.id}/approve`).set(auth(manager2.token))).status).toBe(200);
    expect((await figures()).available).toBe(60000);
  });

  it('a spend is reserved while pending, drawn down once approved, and returned if rejected', async () => {
    const s1 = (await spend(manager.token, 20000)).body.data;
    expect(s1.status).toBe('pending');
    let f = await figures();
    expect(f.balance).toBe(60000);
    expect(f.available).toBe(40000);

    // two spends cannot together promise more than the float holds
    expect((await spend(manager.token, 45000)).status).toBe(409);

    await request(app).post(`/api/expenses/${s1.id}/approve`).set(auth(manager2.token));
    f = await figures();
    expect(f).toMatchObject({ balance: 40000, spent: 20000, available: 40000 });

    const s2 = (await spend(manager.token, 15000)).body.data;
    expect((await figures()).available).toBe(25000);
    await request(app).post(`/api/expenses/${s2.id}/reject`).set(auth(manager2.token)).send({ note: 'no' });
    expect((await figures()).available).toBe(40000);
  });

  it('petty-cash spends are real expenses: they reach the totals only once approved', async () => {
    const res = await request(app).get('/api/expenses?paid_from=petty_cash&limit=50').set(auth(adminToken));
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((e) => e.paid_from === 'petty_cash')).toBe(true);
  });

  it('rejects an invalid top-up amount and keeps the storekeeper and cashier out', async () => {
    expect((await request(app).post('/api/petty-cash/topups').set(auth(adminToken)).send({ amount: -5 })).status).toBe(400);
    expect((await request(app).post('/api/petty-cash/topups').set(auth(cashier.token)).send({ amount: 100 })).status).toBe(403);
    expect((await request(app).post('/api/petty-cash/topups').set(auth(storeKeeper.token)).send({ amount: 100 })).status).toBe(403);
  });

  it('an over-large edit of a pending petty spend is checked against the float too', async () => {
    const s = (await spend(manager.token, 1000)).body.data;
    const res = await request(app).patch(`/api/expenses/${s.id}`).set(auth(manager.token)).send({ amount: 9999999 });
    expect(res.status).toBe(409);
  });
});

describe('migration: existing databases are upgraded safely', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const Database = require('better-sqlite3');
  const migrateScript = path.join(__dirname, '../src/db/migrate.js');

  function runMigrate(dbFile) {
    execFileSync(process.execPath, [migrateScript], {
      env: { ...process.env, DATABASE_PATH: dbFile, NODE_ENV: 'test' },
      stdio: 'pipe',
    });
  }

  it('adds the store role to an old users table without losing anyone, and keeps expenses as approved', () => {
    const file = path.join(os.tmpdir(), `utpos-p1mig-${process.pid}-${Date.now()}.db`);
    try {
      runMigrate(file); // a current database

      // Put it back into the legacy shape: role CHECK without 'store', and an expenses table with no approval columns.
      const d = new Database(file);
      d.pragma('foreign_keys = OFF');
      const usersSql = d.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get().sql;
      d.exec('DROP TABLE users');
      d.exec(usersSql.replace("'admin','manager','cashier','store'", "'admin','manager','cashier'"));
      d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL`);
      d.exec(`CREATE INDEX IF NOT EXISTS idx_users_store ON users(store_id)`);
      expect(d.prepare(`SELECT sql FROM sqlite_master WHERE name='users'`).get().sql).not.toContain("'store'");

      const storeId = d.prepare(`INSERT INTO stores (name) VALUES ('Legacy Store')`).run().lastInsertRowid;
      const mkUser = (name, email, role) => d.prepare(
        `INSERT INTO users (store_id, name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'hash', ?)`
      ).run(storeId, name, email, `07000${Math.floor(Math.random() * 90000 + 10000)}`, role).lastInsertRowid;
      const adminId = mkUser('Old Admin', 'old-admin@x.test', 'admin');
      const cashierId = mkUser('Old Cashier', 'old-cashier@x.test', 'cashier');
      expect(() => mkUser('Nope', 'nope@x.test', 'store')).toThrow(/CHECK/);

      const catId = d.prepare(`INSERT INTO expense_categories (name) VALUES ('Legacy cat')`).run().lastInsertRowid;
      d.exec('DROP TABLE expenses');
      d.exec(`CREATE TABLE expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER REFERENCES stores(id),
        category_id INTEGER NOT NULL REFERENCES expense_categories(id), amount INTEGER NOT NULL CHECK (amount >= 0),
        description TEXT, expense_date TEXT NOT NULL, recorded_by_staff_id INTEGER NOT NULL REFERENCES users(id),
        receipt_url TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT)`);
      d.prepare(`INSERT INTO expenses (store_id, category_id, amount, expense_date, recorded_by_staff_id) VALUES (?, ?, 4200, '2026-01-01', ?)`)
        .run(storeId, catId, cashierId);
      d.close();

      runMigrate(file);

      const e = new Database(file);
      expect(e.prepare(`SELECT sql FROM sqlite_master WHERE name='users'`).get().sql).toContain("'store'");
      expect(e.prepare('SELECT id, email, role FROM users ORDER BY id').all()).toEqual([
        { id: adminId, email: 'old-admin@x.test', role: 'admin' },
        { id: cashierId, email: 'old-cashier@x.test', role: 'cashier' },
      ]);
      e.prepare(`INSERT INTO users (store_id, name, email, password_hash, role) VALUES (?, 'Keeper', 'keeper@x.test', 'h', 'store')`).run(storeId);
      const indexes = e.prepare('PRAGMA index_list(users)').all().map((i) => i.name);
      expect(indexes).toEqual(expect.arrayContaining(['idx_users_store', 'idx_users_phone']));
      expect(e.pragma('foreign_key_check')).toHaveLength(0);

      // the old expense is kept, already approved, so existing totals do not change
      expect(e.prepare('SELECT status, paid_from, amount FROM expenses').all()).toEqual([{ status: 'approved', paid_from: 'main', amount: 4200 }]);
      expect(e.prepare(`SELECT name FROM sqlite_master WHERE name = 'petty_cash_topups'`).get()).toBeTruthy();
      const productCols = e.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
      expect(productCols).toEqual(expect.arrayContaining(['approval_status', 'submitted_by_staff_id', 'reviewed_by_staff_id']));
      e.close();

      runMigrate(file); // second run changes nothing
      const f = new Database(file);
      expect(f.prepare('SELECT COUNT(*) c FROM users').get().c).toBe(3);
      f.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
    }
  });
});
