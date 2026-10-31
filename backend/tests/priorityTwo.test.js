const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

// Priority 2: main-store inventory control - receiving (with hidden buying price), suppliers, issue logs,
// inter-branch transfers with approval, outlet opening/closing counts, and the staff accountability log.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';

let adminToken;
let mainId;
let outletId;
let storeKeeper;
let manager;
let manager2;
let cashier;
let outletCashier;
let outletManager;
let apparelId;
let seededProduct;

async function makeUser(role, email, storeId) {
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `${role} p2 ${email.split('@')[0]}`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token, loginBody: login.body };
}

const qty = (productId, storeId) => (db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId) || { quantity: 0 }).quantity;
const movements = (reason) => db.prepare('SELECT * FROM inventory_movements WHERE reason = ? ORDER BY id').all(reason);

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  mainId = db.prepare('SELECT id FROM stores WHERE is_main = 1').get().id;
  const created = await request(app).post('/api/stores').set(auth(adminToken)).send({ name: 'Westlands Outlet', address: 'Westlands' });
  outletId = created.body.data.id;
  storeKeeper = await makeUser('store', 'p2-store@urbantrends.com', mainId);
  manager = await makeUser('manager', 'p2-manager@urbantrends.com', mainId);
  manager2 = await makeUser('manager', 'p2-manager2@urbantrends.com', mainId);
  cashier = await makeUser('cashier', 'p2-cashier@urbantrends.com', mainId);
  outletCashier = await makeUser('cashier', 'p2-ocashier@urbantrends.com', outletId);
  outletManager = await makeUser('manager', 'p2-omanager@urbantrends.com', outletId);
  apparelId = db.prepare(`SELECT id FROM categories WHERE name = 'Apparel'`).get().id;
  seededProduct = db.prepare(`SELECT * FROM products WHERE sku = 'UT-TSH-001'`).get();
});

afterAll(() => cleanupTestDb());

describe('main store and branches', () => {
  it('the seeded store is the main store and the outlet is not', () => {
    expect(db.prepare('SELECT is_main FROM stores WHERE id = ?').get(mainId).is_main).toBe(1);
    expect(db.prepare('SELECT is_main FROM stores WHERE id = ?').get(outletId).is_main).toBe(0);
  });

  it('only an admin adds a branch; names are unique; anyone signed in can list them', async () => {
    expect((await request(app).post('/api/stores').set(auth(manager.token)).send({ name: 'Nope' })).status).toBe(403);
    expect((await request(app).post('/api/stores').set(auth(adminToken)).send({ name: 'westlands outlet' })).status).toBe(409);
    expect((await request(app).post('/api/stores').set(auth(adminToken)).send({ name: '  ' })).status).toBe(400);
    const list = await request(app).get('/api/stores').set(auth(cashier.token));
    expect(list.status).toBe(200);
    expect(list.body.data.map((s) => s.name)).toEqual(expect.arrayContaining(['Westlands Outlet']));
    expect(list.body.data[0].is_main).toBe(1);
  });

  it('the main store cannot be switched off', async () => {
    const res = await request(app).put(`/api/stores/${mainId}`).set(auth(adminToken)).send({ is_active: false });
    expect(res.status).toBe(400);
  });

  it('an admin can add staff to an outlet; a manager cannot', async () => {
    const body = { name: 'Outlet Clerk', email: 'clerk@outlet.test', phone: '0700123456', password: 'Cobalt-Willow-9152!', role: 'cashier', store_id: outletId };
    const made = await request(app).post('/api/staff').set(auth(adminToken)).send(body);
    expect(made.status).toBe(201);
    expect(db.prepare('SELECT store_id FROM users WHERE email = ?').get('clerk@outlet.test').store_id).toBe(outletId);
    const listed = await request(app).get(`/api/staff?store_id=${outletId}`).set(auth(adminToken));
    expect(listed.body.data.some((u) => u.email === 'clerk@outlet.test')).toBe(true);
    const denied = await request(app).get(`/api/staff?store_id=${outletId}`).set(auth(manager.token));
    expect(denied.status).toBe(403);
  });

  it('new permissions: the storekeeper can receive, transfer and count but not review', () => {
    const perms = storeKeeper.loginBody.user.permissions;
    expect(perms).toEqual(expect.arrayContaining(['stock.receive', 'stock.transfer', 'stock.count']));
    expect(perms).not.toContain('stock.review');
    expect(perms).not.toContain('products.view_cost');
    expect(cashier.loginBody.user.permissions).toContain('stock.count');
    expect(cashier.loginBody.user.permissions).not.toContain('stock.receive');
  });
});

describe('receiving a shipment', () => {
  let receiptId;

  it('refuses people without the permission, and refuses receiving at an outlet', async () => {
    const body = { items: [{ product_id: seededProduct.id, quantity: 1 }] };
    expect((await request(app).post('/api/stock/receipts').set(auth(cashier.token)).send(body)).status).toBe(403);
    expect((await request(app).get('/api/stock/receipts').set(auth(cashier.token))).status).toBe(403);
    const atOutlet = await request(app).post('/api/stock/receipts').set(auth(outletManager.token)).send(body);
    expect(atOutlet.status).toBe(409);
    expect(atOutlet.body.code || atOutlet.body.error?.code).toBeTruthy();
  });

  it('adds stock for an existing product with a ledger line naming who did it', async () => {
    const before = qty(seededProduct.id, mainId);
    const res = await request(app).post('/api/stock/receipts').set(auth(storeKeeper.token)).send({
      reference: 'DN-1001', note: 'First delivery', new_supplier: { name: 'Acme Wholesale', phone: '0711000000' },
      items: [{ product_id: seededProduct.id, quantity: 12 }],
    });
    expect(res.status).toBe(201);
    receiptId = res.body.data.id;
    expect(qty(seededProduct.id, mainId)).toBe(before + 12);
    expect(res.body.data.supplier_name).toBe('Acme Wholesale');
    expect(res.body.data.received_by_name).toContain('store');
    const m = movements('receipt').find((x) => x.reference_id === receiptId);
    expect(m).toMatchObject({ change_qty: 12, reference_type: 'receipt', created_by: storeKeeper.id, store_id: mainId });
  });

  it('never exposes a buying price anywhere in the receipt', async () => {
    const res = await request(app).get(`/api/stock/receipts/${receiptId}`).set(auth(storeKeeper.token));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/cost/i);
    const list = await request(app).get('/api/stock/receipts').set(auth(storeKeeper.token));
    expect(JSON.stringify(list.body)).not.toMatch(/cost/i);
  });

  it('a new product from the storekeeper is a pending proposal with no buying price, in a new sub-category', async () => {
    const res = await request(app).post('/api/stock/receipts').set(auth(storeKeeper.token)).send({
      supplier_id: db.prepare('SELECT id FROM suppliers LIMIT 1').get().id,
      items: [{
        quantity: 30,
        new_product: {
          name: 'Linen Shirt', sell_price: 150000, image_url: 'https://img.example/linen.jpg', cost_price: 99999,
          new_category: { name: 'Shirts', parent_id: apparelId },
        },
      }],
    });
    expect(res.status).toBe(201);
    const line = res.body.data.items[0];
    expect(line).toMatchObject({ is_new_product: 1, quantity: 30, sell_price: 150000, product_status: 'pending', image_url: 'https://img.example/linen.jpg' });

    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id);
    expect(p).toMatchObject({ is_active: 0, approval_status: 'pending', cost_price: 0, submitted_by_staff_id: storeKeeper.id, image_url: 'https://img.example/linen.jpg' });
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(p.category_id);
    expect(cat).toMatchObject({ name: 'Shirts', parent_id: apparelId });
    expect(qty(p.id, mainId)).toBe(30);

    // Nothing can sell it yet: it is not in the active stock list.
    const stockList = await request(app).get('/api/inventory').set(auth(adminToken));
    expect(stockList.body.data.some((r) => r.product_id === p.id)).toBe(false);

    // The managers were told.
    expect(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'product_proposed' AND entity_id = ?`).get(manager.id, p.id).c).toBe(1);

    // The approver fills in the buying price; the storekeeper still cannot see it afterwards.
    const approved = await request(app).post(`/api/products/${p.id}/approve`).set(auth(manager.token)).send({ cost_price: 90000 });
    expect(approved.status).toBe(200);
    expect(db.prepare('SELECT cost_price, is_active FROM products WHERE id = ?').get(p.id)).toEqual({ cost_price: 90000, is_active: 1 });
    const seen = await request(app).get(`/api/products/${p.id}`).set(auth(storeKeeper.token));
    expect(seen.body.data.cost_price).toBeUndefined();
  });

  it('reuses an existing sub-category instead of duplicating it', async () => {
    const before = db.prepare(`SELECT COUNT(*) c FROM categories WHERE name = 'Shirts'`).get().c;
    const res = await request(app).post('/api/stock/receipts').set(auth(storeKeeper.token)).send({
      items: [{ quantity: 5, new_product: { name: 'Oxford Shirt', sell_price: 120000, new_category: { name: 'shirts', parent_id: apparelId } } }],
    });
    expect(res.status).toBe(201);
    expect(db.prepare(`SELECT COUNT(*) c FROM categories WHERE name = 'Shirts' COLLATE NOCASE`).get().c).toBe(before);
  });

  it('a storekeeper cannot create a top-level category, but a manager can', async () => {
    const asKeeper = await request(app).post('/api/stock/receipts').set(auth(storeKeeper.token)).send({
      items: [{ quantity: 1, new_product: { name: 'Mystery Item', sell_price: 100, new_category: { name: 'Brand New Top Level' } } }],
    });
    expect(asKeeper.status).toBe(403);
    expect(db.prepare(`SELECT 1 FROM products WHERE name = 'Mystery Item'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM categories WHERE name = 'Brand New Top Level'`).get()).toBeUndefined();

    const asManager = await request(app).post('/api/stock/receipts').set(auth(manager.token)).send({
      items: [{ quantity: 4, new_product: { name: 'Managers Hat', sell_price: 50000, new_category: { name: 'Hats' } } }],
    });
    expect(asManager.status).toBe(201);
    // A manager's new product is live straight away, like the catalog.
    expect(asManager.body.data.items[0].product_status).toBe('approved');
    expect(db.prepare(`SELECT is_active FROM products WHERE name = 'Managers Hat'`).get().is_active).toBe(1);
  });

  it('is all-or-nothing: a bad second line saves nothing', async () => {
    const receipts = db.prepare('SELECT COUNT(*) c FROM stock_receipts').get().c;
    const products = db.prepare('SELECT COUNT(*) c FROM products').get().c;
    const before = qty(seededProduct.id, mainId);
    const res = await request(app).post('/api/stock/receipts').set(auth(storeKeeper.token)).send({
      items: [{ product_id: seededProduct.id, quantity: 7 }, { quantity: 3, new_product: { name: 'Half Saved', sell_price: -5 } }],
    });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM stock_receipts').get().c).toBe(receipts);
    expect(db.prepare('SELECT COUNT(*) c FROM products').get().c).toBe(products);
    expect(qty(seededProduct.id, mainId)).toBe(before);
  });

  it('refuses duplicates, bad quantities, future dates and empty shipments', async () => {
    const send = (body) => request(app).post('/api/stock/receipts').set(auth(storeKeeper.token)).send(body);
    expect((await send({ items: [{ quantity: 2, new_product: { name: 'classic crew t-shirt', sell_price: 100 } }] })).status).toBe(409);
    expect((await send({ items: [{ quantity: 2, new_product: { name: 'Fresh One', sell_price: 100, sku: 'UT-TSH-001' } }] })).status).toBe(409);
    expect((await send({ items: [{ product_id: seededProduct.id, quantity: 0 }] })).status).toBe(400);
    expect((await send({ items: [{ product_id: seededProduct.id, quantity: 1.5 }] })).status).toBe(400);
    expect((await send({ items: [] })).status).toBe(400);
    expect((await send({ received_on: '2999-01-01', items: [{ product_id: seededProduct.id, quantity: 1 }] })).status).toBe(400);
    expect((await send({ received_on: 'yesterday', items: [{ product_id: seededProduct.id, quantity: 1 }] })).status).toBe(400);
    expect((await send({ items: [{ product_id: 999999, quantity: 1 }] })).status).toBe(404);
  });

  it('lists receipts with filters and the person who received them', async () => {
    const res = await request(app).get('/api/stock/receipts?limit=100').set(auth(manager.token));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(4);
    expect(res.body.data[0]).toHaveProperty('received_by_name');
    const bySupplier = await request(app).get(`/api/stock/receipts?supplier_id=${db.prepare('SELECT id FROM suppliers LIMIT 1').get().id}`).set(auth(manager.token));
    expect(bySupplier.body.data.every((r) => r.supplier_name === 'Acme Wholesale')).toBe(true);
    expect((await request(app).get('/api/stock/receipts?from=banana').set(auth(manager.token))).status).toBe(400);
  });
});

describe('suppliers', () => {
  it('the storekeeper can add and list, but renaming or switching off needs product-management rights', async () => {
    const added = await request(app).post('/api/suppliers').set(auth(storeKeeper.token)).send({ name: 'Zed Traders', email: 'z@zed.test' });
    expect(added.status).toBe(201);
    expect((await request(app).post('/api/suppliers').set(auth(storeKeeper.token)).send({ name: 'ZED traders' })).status).toBe(409);
    expect((await request(app).put(`/api/suppliers/${added.body.data.id}`).set(auth(storeKeeper.token)).send({ is_active: false })).status).toBe(403);
    const off = await request(app).put(`/api/suppliers/${added.body.data.id}`).set(auth(manager.token)).send({ is_active: false });
    expect(off.status).toBe(200);
    const active = await request(app).get('/api/suppliers').set(auth(storeKeeper.token));
    expect(active.body.data.some((s) => s.name === 'Zed Traders')).toBe(false);
    const all = await request(app).get('/api/suppliers?include_inactive=1').set(auth(storeKeeper.token));
    expect(all.body.data.some((s) => s.name === 'Zed Traders')).toBe(true);
  });

  it('a switched-off supplier cannot be used on a new receipt', async () => {
    const id = db.prepare(`SELECT id FROM suppliers WHERE name = 'Zed Traders'`).get().id;
    const res = await request(app).post('/api/stock/receipts').set(auth(storeKeeper.token)).send({ supplier_id: id, items: [{ product_id: seededProduct.id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe('issuing stock out', () => {
  it('records who issued what and why, and takes the stock off', async () => {
    const before = qty(seededProduct.id, mainId);
    const res = await request(app).post('/api/stock/issues').set(auth(storeKeeper.token)).send({ product_id: seededProduct.id, quantity: 2, reason: 'damaged', note: 'Water damage' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ reason: 'damaged', quantity: 2, issued_by_name: expect.stringContaining('store') });
    expect(qty(seededProduct.id, mainId)).toBe(before - 2);
    expect(movements('issue').pop()).toMatchObject({ change_qty: -2, reference_type: 'issue', created_by: storeKeeper.id });
    expect(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'stock_issued_loss'`).get(manager.id).c).toBe(1);
  });

  it('refuses over-issuing, unknown reasons and "other" without a note, leaving no log', async () => {
    const issues = db.prepare('SELECT COUNT(*) c FROM stock_issues').get().c;
    const before = qty(seededProduct.id, mainId);
    const send = (b) => request(app).post('/api/stock/issues').set(auth(storeKeeper.token)).send({ product_id: seededProduct.id, ...b });
    expect((await send({ quantity: before + 1, reason: 'lost' })).status).toBe(409);
    expect((await send({ quantity: 1, reason: 'stolen' })).status).toBe(400);
    expect((await send({ quantity: 1, reason: 'other' })).status).toBe(400);
    expect((await send({ quantity: 0, reason: 'lost' })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM stock_issues').get().c).toBe(issues);
    expect(qty(seededProduct.id, mainId)).toBe(before);
  });

  it('lists issues with a reason filter, and a cashier cannot issue', async () => {
    const res = await request(app).get('/api/stock/issues?reason=damaged').set(auth(manager.token));
    expect(res.body.data.length).toBe(1);
    expect((await request(app).post('/api/stock/issues').set(auth(cashier.token)).send({ product_id: seededProduct.id, quantity: 1, reason: 'lost' })).status).toBe(403);
  });

  it('a pending product cannot be issued', async () => {
    const pending = db.prepare(`SELECT id FROM products WHERE name = 'Oxford Shirt'`).get();
    const res = await request(app).post('/api/stock/issues').set(auth(storeKeeper.token)).send({ product_id: pending.id, quantity: 1, reason: 'lost' });
    expect(res.status).toBe(409);
  });
});

describe('transfers between branches', () => {
  let transferId;

  it('requesting moves nothing, and tells the managers', async () => {
    const mainBefore = qty(seededProduct.id, mainId);
    const res = await request(app).post('/api/stock/transfers').set(auth(storeKeeper.token)).send({ to_store_id: outletId, note: 'Weekend stock', items: [{ product_id: seededProduct.id, quantity: 10 }] });
    expect(res.status).toBe(201);
    transferId = res.body.data.id;
    expect(res.body.data).toMatchObject({ status: 'pending', from_store_id: mainId, to_store_id: outletId, total_units: 10 });
    expect(qty(seededProduct.id, mainId)).toBe(mainBefore);
    expect(qty(seededProduct.id, outletId)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'stock_transfer_pending'`).get(manager.id).c).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'stock_transfer_pending'`).get(outletManager.id).c).toBe(1);
  });

  it('only a reviewer decides, and never on their own request', async () => {
    expect((await request(app).post(`/api/stock/transfers/${transferId}/approve`).set(auth(storeKeeper.token))).status).toBe(403);
    expect((await request(app).post(`/api/stock/transfers/${transferId}/approve`).set(auth(cashier.token))).status).toBe(403);

    const own = await request(app).post('/api/stock/transfers').set(auth(manager.token)).send({ to_store_id: outletId, items: [{ product_id: seededProduct.id, quantity: 1 }] });
    expect(own.status).toBe(201);
    expect((await request(app).post(`/api/stock/transfers/${own.body.data.id}/approve`).set(auth(manager.token))).status).toBe(403);
    expect((await request(app).post(`/api/stock/transfers/${own.body.data.id}/reject`).set(auth(manager.token)).send({ note: 'x' })).status).toBe(403);
    // Another manager can; the requester can also withdraw it.
    expect((await request(app).post(`/api/stock/transfers/${own.body.data.id}/cancel`).set(auth(manager.token))).body.data.status).toBe('cancelled');
    expect((await request(app).post(`/api/stock/transfers/${own.body.data.id}/approve`).set(auth(manager2.token))).status).toBe(409);
  });

  it('approving writes both movements together and moves the stock', async () => {
    const mainBefore = qty(seededProduct.id, mainId);
    const res = await request(app).post(`/api/stock/transfers/${transferId}/approve`).set(auth(manager2.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', reviewed_by_name: expect.stringContaining('manager') });
    expect(qty(seededProduct.id, mainId)).toBe(mainBefore - 10);
    expect(qty(seededProduct.id, outletId)).toBe(10);
    const out = movements('transfer_out').find((m) => m.reference_id === transferId);
    const inn = movements('transfer_in').find((m) => m.reference_id === transferId);
    expect(out).toMatchObject({ change_qty: -10, store_id: mainId, reference_type: 'transfer', created_by: manager2.id });
    expect(inn).toMatchObject({ change_qty: 10, store_id: outletId, reference_type: 'transfer', created_by: manager2.id });
  });

  it('cannot be approved twice (the stock does not move again)', async () => {
    const before = qty(seededProduct.id, outletId);
    expect((await request(app).post(`/api/stock/transfers/${transferId}/approve`).set(auth(manager2.token))).status).toBe(409);
    expect(qty(seededProduct.id, outletId)).toBe(before);
  });

  it('fails cleanly if the stock was used up between request and approval', async () => {
    const onHand = qty(seededProduct.id, mainId);
    const asked = await request(app).post('/api/stock/transfers').set(auth(storeKeeper.token)).send({ to_store_id: outletId, items: [{ product_id: seededProduct.id, quantity: onHand }] });
    expect(asked.status).toBe(201);
    // The stock goes to a damaged-goods write-off before anyone approves.
    await request(app).post('/api/stock/issues').set(auth(storeKeeper.token)).send({ product_id: seededProduct.id, quantity: 1, reason: 'lost' });
    const res = await request(app).post(`/api/stock/transfers/${asked.body.data.id}/approve`).set(auth(manager.token));
    expect(res.status).toBe(409);
    expect(qty(seededProduct.id, outletId)).toBe(10); // unchanged: neither movement was written
    expect(db.prepare('SELECT status FROM stock_transfers WHERE id = ?').get(asked.body.data.id).status).toBe('pending');
    expect((await request(app).post(`/api/stock/transfers/${asked.body.data.id}/reject`).set(auth(manager.token)).send({})).status).toBe(400);
    expect((await request(app).post(`/api/stock/transfers/${asked.body.data.id}/reject`).set(auth(manager.token)).send({ note: 'Stock was written off' })).body.data.status).toBe('rejected');
  });

  it('validates the request itself', async () => {
    const send = (b) => request(app).post('/api/stock/transfers').set(auth(storeKeeper.token)).send(b);
    expect((await send({ to_store_id: mainId, items: [{ product_id: seededProduct.id, quantity: 1 }] })).status).toBe(400); // same branch
    expect((await send({ to_store_id: 999, items: [{ product_id: seededProduct.id, quantity: 1 }] })).status).toBe(400);
    expect((await send({ to_store_id: outletId, items: [] })).status).toBe(400);
    expect((await send({ to_store_id: outletId, items: [{ product_id: seededProduct.id, quantity: 999999 }] })).status).toBe(409);
    expect((await send({ to_store_id: outletId, items: [{ product_id: seededProduct.id, quantity: 1 }, { product_id: seededProduct.id, quantity: 1 }] })).status).toBe(400);
    const pending = db.prepare(`SELECT id FROM products WHERE name = 'Oxford Shirt'`).get();
    expect((await send({ to_store_id: outletId, items: [{ product_id: pending.id, quantity: 1 }] })).status).toBe(409);
    // A storekeeper cannot send stock out of another branch; a cashier cannot ask at all.
    expect((await send({ from_store_id: outletId, to_store_id: mainId, items: [{ product_id: seededProduct.id, quantity: 1 }] })).status).toBe(403);
    expect((await request(app).post('/api/stock/transfers').set(auth(cashier.token)).send({ to_store_id: outletId, items: [{ product_id: seededProduct.id, quantity: 1 }] })).status).toBe(403);
  });

  it('the receiving branch can see its incoming transfer; an outlet manager can send stock back', async () => {
    const seen = await request(app).get(`/api/stock/transfers/${transferId}`).set(auth(outletManager.token));
    expect(seen.status).toBe(200);
    expect(seen.body.data.items[0].product_name).toBe('Classic Crew T-Shirt');
    const back = await request(app).post('/api/stock/transfers').set(auth(outletManager.token)).send({ to_store_id: mainId, items: [{ product_id: seededProduct.id, quantity: 2 }] });
    expect(back.status).toBe(201);
    expect(back.body.data.from_store_id).toBe(outletId);
    const filtered = await request(app).get('/api/stock/transfers?status=pending').set(auth(manager.token));
    expect(filtered.body.data.every((t) => t.status === 'pending')).toBe(true);
  });
});

describe('outlet opening and closing counts', () => {
  let openingId;
  const today = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); // shop date (UTC+3)

  it('records the variance against what the system expected, once per day and kind', async () => {
    expect(qty(seededProduct.id, outletId)).toBe(10);
    const res = await request(app).post('/api/stock/counts').set(auth(outletCashier.token)).send({ kind: 'opening', items: [{ product_id: seededProduct.id, counted_qty: 9 }] });
    expect(res.status).toBe(201);
    openingId = res.body.data.id;
    expect(res.body.data.lines[0]).toMatchObject({ expected_qty: 10, counted_qty: 9, variance: -1 });
    expect(res.body.data).toMatchObject({ status: 'submitted', units_short: 1, units_over: 0, lines_with_variance: 1, store_id: outletId });
    expect(qty(seededProduct.id, outletId)).toBe(10); // counting alone never changes stock
    expect(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'stock_count_variance'`).get(outletManager.id).c).toBe(1);

    const again = await request(app).post('/api/stock/counts').set(auth(outletCashier.token)).send({ kind: 'opening', items: [{ product_id: seededProduct.id, counted_qty: 10 }] });
    expect(again.status).toBe(409);
  });

  it('validates the count', async () => {
    const send = (b) => request(app).post('/api/stock/counts').set(auth(outletCashier.token)).send(b);
    const item = { product_id: seededProduct.id, counted_qty: 1 };
    expect((await send({ kind: 'midday', items: [item] })).status).toBe(400);
    expect((await send({ kind: 'closing', items: [] })).status).toBe(400);
    expect((await send({ kind: 'closing', items: [{ ...item, counted_qty: -1 }] })).status).toBe(400);
    expect((await send({ kind: 'closing', items: [{ ...item, counted_qty: 1.5 }] })).status).toBe(400);
    expect((await send({ kind: 'closing', items: [item, item] })).status).toBe(400);
    expect((await send({ kind: 'closing', count_date: '2999-01-01', items: [item] })).status).toBe(400);
    expect((await send({ kind: 'closing', count_date: '2020-01-01', items: [item] })).status).toBe(400);
    expect((await send({ kind: 'closing', items: [{ product_id: 999999, counted_qty: 1 }] })).status).toBe(404);
  });

  it('the submitter cannot review their own count; a reviewer must give a reason to reject', async () => {
    expect((await request(app).post(`/api/stock/counts/${openingId}/approve`).set(auth(outletCashier.token))).status).toBe(403); // no review right
    // A reviewer who submitted a count may not approve it either.
    const mgrCount = await request(app).post('/api/stock/counts').set(auth(outletManager.token)).send({ kind: 'opening', count_date: new Date(Date.now() + 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10), items: [{ product_id: seededProduct.id, counted_qty: 10 }] });
    expect(mgrCount.status).toBe(201);
    expect((await request(app).post(`/api/stock/counts/${mgrCount.body.data.id}/approve`).set(auth(outletManager.token))).status).toBe(403);
    expect((await request(app).post(`/api/stock/counts/${openingId}/reject`).set(auth(outletManager.token)).send({})).status).toBe(400);
  });

  it('a rejected count can be redone; approving with adjustments makes the system match the shelf', async () => {
    const rejected = await request(app).post(`/api/stock/counts/${openingId}/reject`).set(auth(outletManager.token)).send({ note: 'Recount please' });
    expect(rejected.body.data.status).toBe('rejected');
    expect(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'stock_count_rejected'`).get(outletCashier.id).c).toBe(1);

    const redo = await request(app).post('/api/stock/counts').set(auth(outletCashier.token)).send({ kind: 'opening', items: [{ product_id: seededProduct.id, counted_qty: 9 }] });
    expect(redo.status).toBe(201);
    openingId = redo.body.data.id;

    const approved = await request(app).post(`/api/stock/counts/${openingId}/approve`).set(auth(outletManager.token)).send({ apply_adjustments: true, note: 'Confirmed' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'approved', adjustments_applied: 1, reviewed_by_name: expect.stringContaining('manager') });
    expect(qty(seededProduct.id, outletId)).toBe(9);
    expect(movements('stocktake').pop()).toMatchObject({ change_qty: -1, reference_type: 'stocktake', store_id: outletId, created_by: outletManager.id });
    expect((await request(app).post(`/api/stock/counts/${openingId}/approve`).set(auth(outletManager.token))).status).toBe(409);
  });

  it('the day summary explains the gap between opening and closing from the ledger', async () => {
    // Between the two counts: 2 units are written off (a ledger line), and the shelf then comes up 1 short on top of that.
    await request(app).post('/api/stock/issues').set(auth(outletManager.token)).send({ product_id: seededProduct.id, quantity: 2, reason: 'damaged' });
    const closing = await request(app).post('/api/stock/counts').set(auth(outletCashier.token)).send({ kind: 'closing', items: [{ product_id: seededProduct.id, counted_qty: 6 }] });
    expect(closing.status).toBe(201);
    expect(closing.body.data.lines[0]).toMatchObject({ expected_qty: 7, counted_qty: 6, variance: -1 });

    const sum = await request(app).get(`/api/stock/counts/day-summary?date=${today()}`).set(auth(outletCashier.token));
    expect(sum.status).toBe(200);
    expect(sum.body.data.opening.id).toBe(openingId);
    const line = sum.body.data.lines[0];
    expect(line).toMatchObject({ opening_counted: 9, closing_counted: 6, net_movement: -2, expected_closing: 7, unexplained: -1 });
    expect(line.movements).toEqual({ issue: -2 });
    expect(sum.body.data.totals).toMatchObject({ units_missing: 1, units_surplus: 0, products_with_difference: 1 });
  });

  it('is empty (not an error) when one of the two counts is missing, and a branch cannot read another', async () => {
    const none = await request(app).get('/api/stock/counts/day-summary?date=2026-01-01').set(auth(outletCashier.token));
    expect(none.body.data).toMatchObject({ opening: null, closing: null, lines: [] });
    // Main-store staff cannot open the outlet's count; reviewers can.
    expect((await request(app).get(`/api/stock/counts/${openingId}`).set(auth(cashier.token))).status).toBe(404);
    expect((await request(app).get(`/api/stock/counts/${openingId}`).set(auth(manager.token))).status).toBe(200);
    expect((await request(app).get(`/api/stock/counts?store_id=${outletId}`).set(auth(cashier.token))).status).toBe(403);
    const asReviewer = await request(app).get(`/api/stock/counts?store_id=${outletId}`).set(auth(manager.token));
    expect(asReviewer.body.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe('who did what', () => {
  it('lists non-sale stock actions with names, per-person tallies and filters', async () => {
    const res = await request(app).get(`/api/stock/activity?store_id=${mainId}`).set(auth(manager.token));
    expect(res.status).toBe(200);
    const kinds = res.body.data.entries.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['receipt', 'issue', 'transfer_out', 'transfer_requested', 'transfer_approved']));
    expect(kinds).not.toContain('sale');
    const keeper = res.body.data.summary.find((s) => s.staff_id === storeKeeper.id);
    expect(keeper.actions).toBeGreaterThan(0);
    expect(keeper.units_in).toBeGreaterThan(0);
    expect(keeper.units_out).toBeGreaterThan(0);

    const only = await request(app).get(`/api/stock/activity?store_id=${mainId}&staff_id=${storeKeeper.id}`).set(auth(manager.token));
    expect(only.body.data.entries.every((e) => e.staff_id === storeKeeper.id)).toBe(true);
  });

  it('shows counts and their review at the outlet, and is for reviewers only', async () => {
    const res = await request(app).get(`/api/stock/activity?store_id=${outletId}`).set(auth(adminToken));
    const kinds = res.body.data.entries.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['count_opening_submitted', 'count_opening_approved', 'count_closing_submitted', 'stocktake', 'transfer_in']));
    expect((await request(app).get('/api/stock/activity').set(auth(storeKeeper.token))).status).toBe(403);
    expect((await request(app).get('/api/stock/activity').set(auth(outletCashier.token))).status).toBe(403);
    expect((await request(app).get('/api/stock/activity?from=nope').set(auth(manager.token))).status).toBe(400);
  });
});

describe('the ledger still adds up', () => {
  it('reconciliation finds no drift after all of the above', async () => {
    const res = await request(app).get('/api/inventory/reconcile').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
