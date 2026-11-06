const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { runIntegrityChecks } = require('../src/integrity/checks');

// Draft receipts (redesign Phase 5, option 1): a delivery saved half-entered. A draft never touches stock; submitting runs the
// ordinary receive (stock goes in then) and removes the draft in the same transaction.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
let adminToken; let mainId; let outletId; let keeper; let keeper2; let manager; let outletKeeper;
let counter = 0;

async function makeUser(role, email, storeId) {
  const r = db.prepare('INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(storeId, `${role} draft ${email.split('@')[0]}`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token };
}
const newProduct = (sell = 500) => {
  counter += 1;
  return db.prepare("INSERT INTO products (sku, name, cost_price, sell_price, is_active, approval_status) VALUES (?, ?, 100, ?, 1, 'approved')")
    .run(`DR-${counter}`, `Draft Product ${counter}`, sell).lastInsertRowid;
};
const onHand = (productId) => (db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, mainId) || { quantity: 0 }).quantity;
const movements = (productId) => db.prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = ?').get(productId).n;
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const save = (t, body) => request(app).post('/api/stock/receipts/drafts').set(auth(t)).send(body);
const replace = (t, id, body) => request(app).put(`/api/stock/receipts/drafts/${id}`).set(auth(t)).send(body);
const open = (t, id) => request(app).get(`/api/stock/receipts/drafts/${id}`).set(auth(t));
const list = (t) => request(app).get('/api/stock/receipts/drafts').set(auth(t));
const remove = (t, id) => request(app).delete(`/api/stock/receipts/drafts/${id}`).set(auth(t));
const submit = (t, id) => request(app).post(`/api/stock/receipts/drafts/${id}/submit`).set(auth(t));

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  mainId = db.prepare('SELECT id FROM stores WHERE is_main = 1').get().id;
  outletId = db.prepare("INSERT INTO stores (name) VALUES ('Draft Outlet')").run().lastInsertRowid;
  keeper = await makeUser('store', 'dr-keeper@urbantrends.com', mainId);
  keeper2 = await makeUser('store', 'dr-keeper2@urbantrends.com', mainId);
  manager = await makeUser('manager', 'dr-manager@urbantrends.com', mainId);
  outletKeeper = await makeUser('store', 'dr-outlet@urbantrends.com', outletId);
});
afterAll(() => cleanupTestDb());

describe('saving a draft', () => {
  it('stores the form and touches no stock, receipt, batch or movement', async () => {
    const p = newProduct();
    const before = { receipts: count('stock_receipts'), items: count('stock_receipt_items'), moves: count('inventory_movements'), qty: onHand(p) };
    const res = await save(keeper.token, { reference: 'DN-1', items: [{ product_id: p, quantity: 12 }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ reference: 'DN-1', line_count: 1 });
    expect(count('stock_receipts')).toBe(before.receipts);
    expect(count('stock_receipt_items')).toBe(before.items);
    expect(count('inventory_movements')).toBe(before.moves);
    expect(onHand(p)).toBe(before.qty);
  });

  it('accepts an incomplete form: no items, a half-filled line', async () => {
    expect((await save(keeper.token, {})).status).toBe(201);
    expect((await save(keeper.token, { items: [{ quantity: 3 }] })).status).toBe(201); // no product yet: refused only at submit
  });

  it('refuses what makes a draft unusable', async () => {
    expect((await save(keeper.token, { received_on: '2999-01-01' })).status).toBe(400);
    expect((await save(keeper.token, { received_on: 'yesterday' })).status).toBe(400);
    expect((await save(keeper.token, { supplier_id: 999999 })).status).toBe(400);
    expect((await save(keeper.token, { items: Array.from({ length: 201 }, () => ({ quantity: 1 })) })).status).toBe(400);
    expect((await save(keeper.token, { items: 'nope' })).status).toBe(400);
  });

  it('is for the main store only, like a receipt', async () => {
    const res = await save(outletKeeper.token, { items: [] });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('NOT_MAIN_STORE');
  });

  it('needs the receive permission', async () => {
    const cashier = await makeUser('cashier', 'dr-cashier@urbantrends.com', mainId);
    expect((await save(cashier.token, {})).status).toBe(403);
    expect((await list(cashier.token)).status).toBe(403);
  });

  it('keeps only the receipt fields, not whatever else was sent', async () => {
    const res = await save(keeper.token, { reference: 'DN-2', store_id: 999, received_by_staff_id: 1, items: [] });
    expect(res.status).toBe(201);
    const open2 = await open(keeper.token, res.body.data.id);
    expect(Object.keys(open2.body.data.body).sort()).toEqual(['items', 'reference']);
  });
});

describe('buying prices in drafts', () => {
  it('are never stored for someone who may not set them', async () => {
    const p = newProduct();
    const res = await save(keeper.token, { items: [{ product_id: p, quantity: 5, unit_cost: 777 }] });
    const stored = JSON.parse(db.prepare('SELECT body FROM stock_receipt_drafts WHERE id = ?').get(res.body.data.id).body);
    expect(stored.items[0]).not.toHaveProperty('unit_cost');
    expect(JSON.stringify(res.body)).not.toContain('777');
  });

  it('are kept for a manager, and hidden from a storekeeper who can open the draft only if they could set them', async () => {
    const p = newProduct();
    const res = await save(manager.token, { items: [{ product_id: p, quantity: 5, unit_cost: 321 }] });
    expect((await open(manager.token, res.body.data.id)).body.data.body.items[0].unit_cost).toBe(321);
    expect((await open(keeper.token, res.body.data.id)).status).toBe(404); // someone else's draft: not visible to a storekeeper at all
  });
});

describe('who sees and changes a draft', () => {
  it('shows a storekeeper their own drafts only, and a reviewer all of them', async () => {
    const mine = (await save(keeper.token, { reference: 'KEEPER-A' })).body.data.id;
    const theirs = (await save(keeper2.token, { reference: 'KEEPER-B' })).body.data.id;
    const keeperIds = (await list(keeper.token)).body.data.map((d) => d.id);
    expect(keeperIds).toContain(mine);
    expect(keeperIds).not.toContain(theirs);
    const adminIds = (await list(adminToken)).body.data.map((d) => d.id);
    expect(adminIds).toEqual(expect.arrayContaining([mine, theirs]));
  });

  it('is not found, not forbidden, for a draft the caller may not open', async () => {
    const id = (await save(keeper.token, { reference: 'PRIVATE' })).body.data.id;
    expect((await open(keeper2.token, id)).status).toBe(404);
    expect((await replace(keeper2.token, id, { reference: 'X' })).status).toBe(404);
    expect((await remove(keeper2.token, id)).status).toBe(404);
    expect((await submit(keeper2.token, id)).status).toBe(404);
    expect((await open(adminToken, id)).status).toBe(200); // a reviewer can
  });

  it('replaces the contents on save, and deletes', async () => {
    const id = (await save(keeper.token, { reference: 'OLD', items: [] })).body.data.id;
    const p = newProduct();
    const res = await replace(keeper.token, id, { reference: 'NEW', items: [{ product_id: p, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reference: 'NEW', line_count: 1 });
    expect((await remove(keeper.token, id)).status).toBe(200);
    expect((await open(keeper.token, id)).status).toBe(404);
  });
});

describe('submitting a draft', () => {
  it('receives it for real: stock goes in once, the receipt exists, the draft is gone', async () => {
    const p = newProduct();
    const id = (await save(keeper.token, { reference: 'DN-SUB', items: [{ product_id: p, quantity: 12, batch_no: 'B1' }] })).body.data.id;
    expect(onHand(p)).toBe(0);

    const res = await submit(keeper.token, id);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ reference: 'DN-SUB', total_units: 12 });
    expect(res.body.data.items[0]).not.toHaveProperty('unit_cost'); // the storekeeper still never sees a buying price
    expect(onHand(p)).toBe(12);
    expect(movements(p)).toBe(1);
    expect((await open(keeper.token, id)).status).toBe(404);
  });

  it('cannot put stock in twice, however often it is submitted', async () => {
    const p = newProduct();
    const id = (await save(keeper.token, { items: [{ product_id: p, quantity: 7 }] })).body.data.id;
    const results = await Promise.all([submit(keeper.token, id), submit(keeper.token, id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    expect(onHand(p)).toBe(7);
    expect(movements(p)).toBe(1);
  });

  it('leaves the draft and the stock untouched when the receive is refused', async () => {
    const p = newProduct();
    const id = (await save(keeper.token, { items: [{ product_id: p, quantity: 5 }, { quantity: 3 }] })).body.data.id; // line 2 has no product
    const res = await submit(keeper.token, id);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Line 2');
    expect(onHand(p)).toBe(0);
    expect(movements(p)).toBe(0);
    expect((await open(keeper.token, id)).status).toBe(200); // still there to fix
  });

  it('refuses an empty draft at submit, with the same message as a direct receive', async () => {
    const id = (await save(keeper.token, {})).body.data.id;
    const res = await submit(keeper.token, id);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('at least one item');
    expect((await open(keeper.token, id)).status).toBe(200);
  });

  it('creates the supplier and any new product only at submit, not when the draft is saved', async () => {
    const suppliers = count('suppliers');
    const products = count('products');
    const id = (await save(keeper.token, {
      new_supplier: { name: 'Draft Supplier Ltd' },
      items: [{ quantity: 4, new_product: { name: 'Draft Brand New Thing', sell_price: 900 } }],
    })).body.data.id;
    expect(count('suppliers')).toBe(suppliers);
    expect(count('products')).toBe(products);
    const res = await submit(keeper.token, id);
    expect(res.status).toBe(201);
    expect(count('suppliers')).toBe(suppliers + 1);
    expect(count('products')).toBe(products + 1);
    // a storekeeper's new product is a proposal: it still needs approval and a buying price before it can be sold
    expect(db.prepare("SELECT approval_status FROM products WHERE name = 'Draft Brand New Thing'").get().approval_status).toBe('pending');
  });

  it('ignores the display reminder the form keeps on a product line', async () => {
    const p = newProduct();
    const id = (await save(keeper.token, { items: [{ product_id: p, quantity: 6, display: { name: 'Whatever it was called', sku: 'X' } }] })).body.data.id;
    const res = await submit(keeper.token, id);
    expect(res.status).toBe(201);
    expect(res.body.data.items[0]).toMatchObject({ product_id: p, quantity: 6 });
    expect(onHand(p)).toBe(6);
  });

  it('lets a reviewer submit a storekeeper\'s draft', async () => {
    const p = newProduct();
    const id = (await save(keeper.token, { items: [{ product_id: p, quantity: 3 }] })).body.data.id;
    expect((await submit(adminToken, id)).status).toBe(201);
    expect(onHand(p)).toBe(3);
  });

  it('leaves the integrity check clean (on-hand still equals the ledger after saving, submitting and failing)', () => {
    const report = runIntegrityChecks();
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('the migration', () => {
  it('is applied once and named as the migrations folder expects', () => {
    const rows = db.prepare("SELECT version, name FROM schema_migrations WHERE name LIKE '%draft_receipts%' OR version LIKE '0002%'").all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('draft_receipts');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stock_receipt_drafts'").get()).toBeTruthy();
  });
});
