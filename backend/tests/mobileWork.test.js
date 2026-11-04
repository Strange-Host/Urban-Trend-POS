const bcrypt = require('bcryptjs');
const fs = require('fs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const push = require('../src/services/push.service');
const notifications = require('../src/services/notifications.service');
const cashSessions = require('../src/services/cashSessions.service');
const release = require('../src/services/appRelease.service');
const homeFeed = require('../src/services/homeFeed.service');

// The mobile app's work endpoints: approvals (five kinds, one list), alerts, stock lookup and adjustments with the owner-
// approval threshold, orders, quiet hours, the extra push triggers, and hosting the APK.

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${typeof t === 'string' ? t : t.token}` });   // a token, or anyone with a .token
const PASSWORD = 'Passw0rd!Passw0rd';
let ipN = 0;
const ip = () => { ipN += 1; return `10.77.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
let admin; let manager; let manager2; let cashier; let storeId; let product; let seq = 0;

async function makeUser(role, label = role) {
  seq += 1;
  const email = `mw${seq}-${label}@example.com`;
  const id = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `MW ${label} ${seq}`, email, bcrypt.hashSync(PASSWORD, 4), role).lastInsertRowid;
  const login = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip())
    .send({ email, password: PASSWORD, device: { deviceId: `mw-${seq}`, name: 'Test phone', appVersion: '1.0.0' } });
  expect(login.status).toBe(200);
  return { id, token: login.body.token, name: `MW ${label} ${seq}`, login };
}
const revoke = (userId, key) => db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, 0)`).run(userId, key);
const grant = (userId, key) => db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, 1)`).run(userId, key);
const setSetting = (key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
const stockOf = (pid) => db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(pid, storeId).quantity;
const newProduct = (qty = 100) => {
  seq += 1;
  const pid = db.prepare(`INSERT INTO products (sku, barcode, name, cost_price, sell_price) VALUES (?, ?, ?, 100, 500)`).run(`MW-${seq}`, `BC${seq}${Date.now() % 100000}`, `MW Product ${seq}`).lastInsertRowid;
  db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)').run(pid, storeId, qty);
  return db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
};
const addExpense = (by, amount = 150000) => {
  const cat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get().id;
  return db.prepare(`INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id, status)
    VALUES (?, ?, ?, 'Test expense', date('now'), ?, 'pending')`).run(storeId, cat, amount, by.id).lastInsertRowid;
};
const addRequisition = (by) => {
  const rid = db.prepare(`INSERT INTO requisitions (store_id, requested_by_staff_id, type, notes) VALUES (?, ?, 'shop_operational', 'Need more')`).run(storeId, by.id).lastInsertRowid;
  db.prepare('INSERT INTO requisition_items (requisition_id, product_id, quantity_requested) VALUES (?, ?, 4)').run(rid, product.id);
  return rid;
};
const askVoid = async (by) => {
  const sale = await request(app).post('/api/sales').set(auth(by.token))
    .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
  expect(sale.status).toBe(201);
  const r = await request(app).post('/api/approvals').set(auth(by.token)).send({ kind: 'void_sale', sale_id: sale.body.data.id, reason: 'Customer changed mind' });
  expect(r.status).toBe(201);
  return { saleId: sale.body.data.id, requestId: r.body.data.id };
};
const get = (u, path) => request(app).get(`/api/v1${path}`).set(auth(u.token));
const post = (u, path, body = {}) => request(app).post(`/api/v1${path}`).set(auth(u.token)).send(body);

beforeAll(async () => {
  admin = { token: await loginAsAdmin() };
  admin.id = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  storeId = db.prepare('SELECT store_id FROM users WHERE id = ?').get(admin.id).store_id;
  manager = await makeUser('manager'); manager2 = await makeUser('manager', 'manager2'); cashier = await makeUser('cashier');
  const adminLogin = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
  admin.mobile = { id: admin.id, token: adminLogin.body.token };
  product = newProduct(500);
  db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, 'sales.void_request', 1)`).run(cashier.id);
});
beforeEach(() => homeFeed.clearCache());

describe('sign-in carries the owner\'s app rules', () => {
  it('sends auto-lock seconds and the biometric amount in cents', async () => {
    setSetting('approval_biometric_above_kes', '5000'); setSetting('app_auto_lock_seconds', '90');
    const u = await makeUser('manager', 'settings');
    expect(u.login.body.settings).toEqual({ autoLockSeconds: 90, biometricApprovalAboveCents: 500000 });
    setSetting('approval_biometric_above_kes', '0');
    expect((await makeUser('manager', 'settings2')).login.body.settings.biometricApprovalAboveCents).toBeNull();
    setSetting('approval_biometric_above_kes', '5000'); setSetting('app_auto_lock_seconds', '120');
  });
});

describe('GET /approvals and decisions', () => {
  it('needs a deciding permission, and shows each kind only to people who can decide it', async () => {
    expect((await get(cashier, '/approvals')).status).toBe(403);
    expect((await request(app).get('/api/v1/approvals')).status).toBe(401);

    const v = await askVoid(cashier);
    const eid = addExpense(cashier); const rid = addRequisition(cashier);
    const list = (await get(manager, '/approvals')).body;
    const ids = list.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([`void:${v.requestId}`, `expense:${eid}`, `requisition:${rid}`]));
    expect(ids.some((i) => i.startsWith('stock_adjustment:'))).toBe(false);          // managers do not decide large stock changes

    revoke(manager2.id, 'expenses.approve');
    const ids2 = (await get(manager2, '/approvals')).body.items.map((i) => i.id);
    expect(ids2).toContain(`void:${v.requestId}`);
    expect(ids2).not.toContain(`expense:${eid}`);
    db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?').run(manager2.id, 'expenses.approve');
  });

  it('never shows (or lets you decide) your own request', async () => {
    const eid = addExpense(manager);
    expect((await get(manager, '/approvals')).body.items.map((i) => i.id)).not.toContain(`expense:${eid}`);
    const r = await post(manager, `/approvals/expense:${eid}/approve`);
    expect(r.status).toBe(403);                                                        // it exists, but it is not yours to decide
    expect(db.prepare('SELECT status FROM expenses WHERE id = ?').get(eid).status).toBe('pending');
  });

  it('approves a void: the sale is voided and the request reads approved', async () => {
    const v = await askVoid(cashier);
    const r = await post(manager, `/approvals/void:${v.requestId}/approve`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: true, approval: { id: `void:${v.requestId}`, status: 'approved', type: 'void' } });
    expect(db.prepare('SELECT status FROM sales WHERE id = ?').get(v.saleId).status).toBe('voided');
  });

  it('rejects with a reason (required), and the reason reaches the person who asked', async () => {
    const eid = addExpense(cashier);
    expect((await post(manager, `/approvals/expense:${eid}/reject`, {})).status).toBe(400);
    const r = await post(manager, `/approvals/expense:${eid}/reject`, { reason: 'No receipt attached' });
    expect(r.body).toMatchObject({ applied: true, approval: { status: 'rejected', decisionNote: 'No receipt attached' } });
    expect(db.prepare(`SELECT body FROM notifications WHERE user_id = ? AND type = 'expense_rejected' ORDER BY id DESC`).get(cashier.id).body).toBe('No receipt attached');
  });

  it('approves a requisition (stock goes up) and an expense', async () => {
    const before = stockOf(product.id);
    const rid = addRequisition(cashier);
    expect((await post(manager, `/approvals/requisition:${rid}/approve`)).body.applied).toBe(true);
    expect(stockOf(product.id)).toBe(before + 4);
    const eid = addExpense(cashier);
    expect((await post(manager, `/approvals/expense:${eid}/approve`)).body.approval.status).toBe('approved');
  });

  it('answers applied:false (not an error) when someone else decided first', async () => {
    const eid = addExpense(cashier);
    expect((await post(manager, `/approvals/expense:${eid}/approve`)).body.applied).toBe(true);
    const late = await post(manager2, `/approvals/expense:${eid}/reject`, { reason: 'Too late' });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ applied: false, approval: { status: 'approved' } });
  });

  it('asks for the fingerprint above the owner\'s amount, and records that it was given', async () => {
    setSetting('approval_biometric_above_kes', '1000');                                // KES 1,000 = 100000 cents
    const eid = addExpense(cashier, 250000);
    const refused = await post(manager, `/approvals/expense:${eid}/approve`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('BIOMETRIC_REQUIRED');
    expect(db.prepare('SELECT status FROM expenses WHERE id = ?').get(eid).status).toBe('pending');
    expect((await post(manager, `/approvals/expense:${eid}/approve`, { biometricConfirmed: true })).body.applied).toBe(true);
    const log = db.prepare(`SELECT changes FROM staff_logs WHERE entity_type = 'mobile_approval' ORDER BY id DESC`).get();
    expect(JSON.parse(log.changes).biometric.to).toBe('confirmed');
    const small = addExpense(cashier, 50000);
    expect((await post(manager, `/approvals/expense:${small}/approve`)).body.applied).toBe(true);   // below the limit: no biometric needed
    setSetting('approval_biometric_above_kes', '5000');
  });

  it('refuses malformed ids and a decision a person lacks the permission for', async () => {
    expect((await post(manager, '/approvals/nonsense/approve')).status).toBe(404);
    expect((await post(manager, '/approvals/stock_adjustment:1/approve')).status).toBe(403);
  });

  it('lists decided items under status=closed, newest first, and pages with a cursor', async () => {
    const closed = (await get(manager, '/approvals?status=closed&limit=2')).body;
    expect(closed.items).toHaveLength(2);
    expect(closed.items.every((i) => i.status !== 'pending')).toBe(true);
    expect(closed.nextCursor).toBeTruthy();
    const next = (await get(manager, `/approvals?status=closed&limit=2&cursor=${closed.nextCursor}`)).body;
    expect(next.items.length).toBeGreaterThan(0);
    expect(next.items[0].id).not.toBe(closed.items[0].id);
    expect((await get(manager, '/approvals?status=bogus')).status).toBe(400);
  });
});

describe('stock lookup and adjustments', () => {
  it('finds by barcode and by name, with stock by state, and never returns cost', async () => {
    const p = newProduct(40);
    const byCode = (await get(manager, `/stock/lookup?barcode=${p.barcode}`)).body.items;
    expect(byCode).toHaveLength(1);
    expect(byCode[0]).toMatchObject({ id: p.id, sku: p.sku, available: 40, awaitingDispatch: 0, dispatchedUnpaid: 0, dispatchedPaid: 0, returned: 0 });
    expect(JSON.stringify(byCode)).not.toMatch(/cost|margin|profit/i);
    expect((await get(manager, `/stock/lookup?q=${encodeURIComponent(p.name.slice(0, 10))}`)).body.items.map((i) => i.id)).toContain(p.id);
    expect((await get(manager, '/stock/lookup?barcode=NOPE-NOPE')).body.items).toEqual([]);
    expect((await get(manager, '/stock/lookup')).status).toBe(400);
    expect((await get(cashier, `/stock/lookup?barcode=${p.barcode}`)).status).toBe(403);
  });

  it('applies a small adjustment at once, with a ledger row', async () => {
    const p = newProduct(50);
    const r = await post(manager, '/stock/adjustments', { productId: p.id, delta: -3, reason: 'damaged' });
    expect(r.body).toEqual({ applied: true, newAvailable: 47 });
    expect(db.prepare(`SELECT change_qty, reason, created_by FROM inventory_movements WHERE product_id = ? ORDER BY id DESC`).get(p.id)).toEqual({ change_qty: -3, reason: 'adjustment', created_by: manager.id });
  });

  it('turns a large adjustment by a non-owner into an owner approval and changes nothing yet', async () => {
    setSetting('stock_adjust_approval_units', '25');
    const p = newProduct(100);
    const r = await post(manager, '/stock/adjustments', { productId: p.id, delta: -30, reason: 'lost', note: 'Missing after delivery' });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
    expect(r.body.approvalId).toMatch(/^stock_adjustment:\d+$/);
    expect(stockOf(p.id)).toBe(100);
    // the owner (admin) is told, and the manager (who asked) does not see it as theirs to decide
    expect(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'approval_requested' AND title LIKE ?`).get(admin.id, '%30%')).toBeTruthy();
    expect((await get(manager, '/approvals')).body.items.some((i) => i.id === r.body.approvalId)).toBe(false);
    const ownerList = (await get(admin.mobile, '/approvals')).body.items;
    expect(ownerList.find((i) => i.id === r.body.approvalId)).toMatchObject({ type: 'stock_adjustment', amountCents: null, items: [{ name: p.name, qty: -30 }] });
    // approving applies it, through the same ledger
    expect((await post(admin.mobile, `/approvals/${r.body.approvalId}/approve`)).body).toMatchObject({ applied: true, approval: { status: 'approved' } });
    expect(stockOf(p.id)).toBe(70);
    expect(db.prepare(`SELECT change_qty FROM inventory_movements WHERE product_id = ? ORDER BY id DESC`).get(p.id).change_qty).toBe(-30);
  });

  it('lets the owner adjust a large amount directly, and rejecting leaves stock alone', async () => {
    const p = newProduct(100);
    expect((await post(admin.mobile, '/stock/adjustments', { productId: p.id, delta: 40, reason: 'found' })).body).toEqual({ applied: true, newAvailable: 140 });
    const q = (await post(manager, '/stock/adjustments', { productId: p.id, delta: -40, reason: 'lost' })).body;
    expect((await post(admin.mobile, `/approvals/${q.approvalId}/reject`, { reason: 'Recount first' })).body.approval.status).toBe('rejected');
    expect(stockOf(p.id)).toBe(140);
  });

  it('closes an approval as failed (and tells the asker) when stock fell in the meantime', async () => {
    const p = newProduct(60);
    const q = (await post(manager, '/stock/adjustments', { productId: p.id, delta: -50, reason: 'lost' })).body;
    db.prepare('UPDATE inventory SET quantity = 10 WHERE product_id = ?').run(p.id);
    const r = await post(admin.mobile, `/approvals/${q.approvalId}/approve`);
    expect(r.status).toBe(409);
    expect(db.prepare('SELECT status FROM stock_adjustment_requests WHERE id = ?').get(q.approvalId.split(':')[1]).status).toBe('failed');
    expect(stockOf(p.id)).toBe(10);
  });

  it('validates input: reasons, zero, negative stock, unknown product, "other" needs a note', async () => {
    const p = newProduct(5);
    expect((await post(manager, '/stock/adjustments', { productId: p.id, delta: 0, reason: 'lost' })).status).toBe(400);
    expect((await post(manager, '/stock/adjustments', { productId: p.id, delta: 1.5, reason: 'lost' })).status).toBe(400);
    expect((await post(manager, '/stock/adjustments', { productId: p.id, delta: 1, reason: 'because' })).status).toBe(400);
    expect((await post(manager, '/stock/adjustments', { productId: p.id, delta: -6, reason: 'lost' })).status).toBe(400);
    expect((await post(manager, '/stock/adjustments', { productId: p.id, delta: 1, reason: 'other' })).status).toBe(400);
    expect((await post(manager, '/stock/adjustments', { productId: p.id, delta: 1, reason: 'other', note: 'Gift stock' })).body.applied).toBe(true);
    expect((await post(manager, '/stock/adjustments', { productId: 99999999, delta: 1, reason: 'found' })).status).toBe(404);
    expect((await post(cashier, '/stock/adjustments', { productId: p.id, delta: 1, reason: 'found' })).status).toBe(403);
  });
});

describe('orders', () => {
  let orderId;
  beforeAll(() => {
    const cid = db.prepare(`INSERT INTO customers (name, phone) VALUES ('Mary Njeri', '0712345678')`).run().lastInsertRowid;
    const courier = db.prepare(`INSERT INTO couriers (store_id, name, phone) VALUES (?, 'Rider Otieno', '0799000111')`).run(storeId).lastInsertRowid;
    orderId = db.prepare(`INSERT INTO orders (store_id, customer_id, status, subtotal, total, amount_paid, courier_id, delivery_fee, notes, product_code)
      VALUES (?, ?, 'dispatched_unpaid', 150000, 150000, 0, ?, 20000, 'Call before delivery', 'UT-TESTREF1')`).run(storeId, cid, courier).lastInsertRowid;
    db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total) VALUES (?, ?, 2, 75000, 150000)').run(orderId, product.id);
  });

  it('lists and filters orders, with the courier facet, and needs orders.view', async () => {
    const all = (await get(manager, '/orders')).body;
    expect(all.items.find((o) => o.id === orderId)).toMatchObject({ number: 'UT-TESTREF1', customerName: 'Mary Njeri', status: 'dispatched_unpaid', paymentState: 'unpaid', courier: 'Rider Otieno', totalCents: 150000 });
    expect(all.couriers).toContain('Rider Otieno');
    expect((await get(manager, '/orders?unpaid=1')).body.items.every((o) => o.paymentState !== 'paid')).toBe(true);
    expect((await get(manager, '/orders?courier=Rider%20Otieno')).body.items.map((o) => o.id)).toContain(orderId);
    expect((await get(manager, '/orders?status=cancelled')).body.items.map((o) => o.id)).not.toContain(orderId);
    expect((await get(manager, '/orders?status=bogus')).status).toBe(400);
    expect((await get(cashier, '/orders')).status).toBe(403);
    grant(cashier.id, 'orders.view');
    expect((await get(cashier, '/orders')).status).toBe(200);
    db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?').run(cashier.id, 'orders.view');
  });

  it('returns one order with lines and phone numbers, 404 for others', async () => {
    const o = (await get(manager, `/orders/${orderId}`)).body;
    expect(o).toMatchObject({ customerPhone: '0712345678', courierPhone: '0799000111', deliveryFeeCents: 20000, notes: 'Call before delivery', items: [{ name: product.name, qty: 2, priceCents: 75000 }] });
    expect(JSON.stringify(o)).not.toMatch(/cost/i);
    expect((await get(manager, '/orders/99999999')).status).toBe(404);
    expect((await get(manager, '/orders/abc')).status).toBe(404);
  });

  it('pages by cursor', async () => {
    const cid = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId).customer_id;
    for (let i = 0; i < 3; i += 1) db.prepare(`INSERT INTO orders (store_id, customer_id, status, total) VALUES (?, ?, 'awaiting_dispatch', 1000)`).run(storeId, cid);
    const p1 = (await get(manager, '/orders?limit=2')).body;
    expect(p1.items).toHaveLength(2);
    const p2 = (await get(manager, `/orders?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items[0].id).toBeLessThan(p1.items[1].id);
  });
});

describe('alerts', () => {
  it('lists only your own bell rows, newest first, with read state and a deep link', async () => {
    notifications.notify({ storeId, userIds: [manager.id], type: 'low_stock', title: 'Mine one', entityType: 'product', entityId: product.id });
    notifications.notify({ storeId, userIds: [manager2.id], type: 'low_stock', title: 'Not yours' });
    const r = (await get(manager, '/notifications')).body;
    expect(r.items[0]).toMatchObject({ title: 'Mine one', read: false, deepLink: `product:${product.id}`, type: 'low_stock', severity: 'info' });
    expect(r.items.some((n) => n.title === 'Not yours')).toBe(false);
    expect((await request(app).get('/api/v1/notifications')).status).toBe(401);
  });
});

describe('quiet hours', () => {
  it('saves and returns preferences, validating the times', async () => {
    const u = await makeUser('manager', 'quiet');
    expect((await get(u, '/me/preferences')).body).toEqual({ quietHours: { enabled: false, start: '22:00', end: '06:00' } });
    const put = (body) => request(app).put('/api/v1/me/preferences').set(auth(u)).send(body);
    expect((await request(app).put('/api/v1/me/preferences').set(auth(u)).send({ quietHours: { enabled: true, start: '21:30', end: '05:45' } })).body)
      .toEqual({ quietHours: { enabled: true, start: '21:30', end: '05:45' } });
    expect((await get(u, '/me/preferences')).body.quietHours).toMatchObject({ enabled: true, start: '21:30' });
    expect((await put({ quietHours: { enabled: true, start: '25:00', end: '06:00' } })).status).toBe(400);
    expect((await put({ quietHours: { enabled: true, start: '08:00', end: '08:00' } })).status).toBe(400);
    expect((await put({ quietHours: { enabled: true } })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    await put({ quietHours: { enabled: false } });
    expect(db.prepare('SELECT quiet_start, quiet_end FROM users WHERE id = ?').get(u.id)).toEqual({ quiet_start: null, quiet_end: null });
  });

  it('inQuietHours works on the shop clock, across midnight', () => {
    const user = { quiet_start: '22:00', quiet_end: '06:00' };
    const at = (utcHm) => new Date(`2026-11-04T${utcHm}:00Z`);           // shop clock is UTC+3: 19:00Z = 22:00 local
    expect(push.inQuietHours(user, at('19:00'))).toBe(true);
    expect(push.inQuietHours(user, at('23:30'))).toBe(true);             // 02:30 local
    expect(push.inQuietHours(user, at('02:59'))).toBe(true);             // 05:59 local
    expect(push.inQuietHours(user, at('03:00'))).toBe(false);            // 06:00 local
    expect(push.inQuietHours(user, at('12:00'))).toBe(false);            // 15:00 local
    expect(push.inQuietHours({ quiet_start: '13:00', quiet_end: '14:00' }, at('10:30'))).toBe(true);   // same-day window, 13:30 local
    expect(push.inQuietHours({ quiet_start: null, quiet_end: null }, at('23:00'))).toBe(false);
  });

  it('holds a push back during quiet hours, but not an urgent one', async () => {
    const u = await makeUser('manager', 'sleeper');
    await request(app).post('/api/v1/devices').set(auth(u)).send({ pushToken: 'tok-sleeper' });
    const provider = { name: 'fake', send: vi.fn(async () => ({ ok: true })) }; push.setProvider(provider);
    db.prepare(`UPDATE users SET quiet_start = '00:00', quiet_end = '23:59' WHERE id = ?`).run(u.id);   // asleep nearly all day: stable whatever time the test runs
    const held = await push.sendToUsers({ userIds: [u.id], title: 'Approve a void', severity: 'warning' });
    expect(held).toMatchObject({ sent: 0, skipped: 'quiet_hours' });
    expect((await push.sendToUsers({ userIds: [u.id], title: 'Locked account', severity: 'urgent' })).sent).toBe(1);
    db.prepare('UPDATE users SET quiet_start = NULL, quiet_end = NULL WHERE id = ?').run(u.id);
    expect((await push.sendToUsers({ userIds: [u.id], title: 'Awake again', severity: 'warning' })).sent).toBe(1);
    push.resetForTests();
  });
});

describe('push triggers', () => {
  async function phone(role, label) {
    const u = await makeUser(role, label);
    await request(app).post('/api/v1/devices').set(auth(u)).send({ pushToken: `tok-${label}-${seq}` });
    return u;
  }
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('a stale unmatched payment (over an hour) pushes to people who can reconcile, once', async () => {
    const m = await phone('manager', 'recon');
    const provider = { name: 'fake', send: vi.fn(async () => ({ ok: true })) }; push.setProvider(provider);
    const old = db.prepare(`INSERT INTO payment_notifications (store_id, source, method, amount, status, payer_name, external_reference, created_at)
      VALUES (?, 'mpesa', 'mobile_money', 250000, 'unmatched', 'Jane W', 'QXOLD1', datetime('now', '-90 minutes'))`).run(storeId).lastInsertRowid;
    const fresh = db.prepare(`INSERT INTO payment_notifications (store_id, source, method, amount, status, payer_name, external_reference, created_at)
      VALUES (?, 'mpesa', 'mobile_money', 100000, 'unmatched', 'Jane F', 'QXNEW1', datetime('now', '-10 minutes'))`).run(storeId).lastInsertRowid;
    expect(notifications.sweepStaleUnmatchedPayments()).toBeGreaterThanOrEqual(1);
    await settle();
    expect(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND dedupe_key = ?`).get(m.id, `unmatched_stale:${old}`)).toBeTruthy();
    expect(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND dedupe_key = ?`).get(m.id, `unmatched_stale:${fresh}`)).toBeUndefined();
    const calls = provider.send.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(provider.send.mock.calls.some(([a]) => /2,?500/.test(a.title) && a.data.kind === 'unmatched_payment_stale')).toBe(true);
    notifications.sweepStaleUnmatchedPayments(); await settle();
    expect(provider.send.mock.calls.length).toBe(calls);                  // the repeat sweep does not buzz again
    push.resetForTests();
  });

  it('a till closed short by more than the threshold pushes to those who can see cash sessions, not the closer', async () => {
    setSetting('attention_cash_variance_kes', '500');
    const closer = await phone('cashier', 'closer'); const owner = await phone('manager', 'cashwatch');
    const provider = { name: 'fake', send: vi.fn(async () => ({ ok: true })) }; push.setProvider(provider);
    const sid = db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount) VALUES (?, ?, 100000)`).run(storeId, closer.id).lastInsertRowid;
    cashSessions.close(sid, closer.id, 40000);                           // expected 100000, counted 40000: short KES 600
    await settle();
    expect(db.prepare(`SELECT title FROM notifications WHERE user_id = ? AND type = 'cash_variance'`).get(owner.id).title).toMatch(/short by KES 600/);
    expect(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'cash_variance'`).get(closer.id)).toBeUndefined();
    expect(provider.send.mock.calls.some(([a]) => a.data.kind === 'cash_variance')).toBe(true);
    // a small miss does not
    const sid2 = db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount) VALUES (?, ?, 100000)`).run(storeId, closer.id).lastInsertRowid;
    cashSessions.close(sid2, closer.id, 99000);                          // short KES 10
    expect(db.prepare(`SELECT 1 FROM notifications WHERE dedupe_key = ?`).get(`cash_variance:${sid2}`)).toBeUndefined();
    push.resetForTests();
  });

  it('a large stock adjustment (up or down) pushes to the admins', async () => {
    const p = newProduct(10);
    const provider = { name: 'fake', send: vi.fn(async () => ({ ok: true })) }; push.setProvider(provider);
    db.prepare(`UPDATE auth_sessions SET push_token = 'tok-admin-adj' WHERE id = (SELECT id FROM auth_sessions WHERE user_id = ? AND client = 'mobile' ORDER BY id DESC LIMIT 1)`).run(admin.id);
    setSetting('security_alert_stock_units', '25');
    await post(admin.mobile, '/stock/adjustments', { productId: p.id, delta: 5, reason: 'found' });
    await post(manager, '/stock/adjustments', { productId: p.id, delta: 20, reason: 'found' });         // 20 < 25: no alert
    await settle(); expect(provider.send).not.toHaveBeenCalled();
    setSetting('stock_adjust_approval_units', '1000');                                                    // let a big one through for this check
    await post(manager, '/stock/adjustments', { productId: p.id, delta: 60, reason: 'found' });
    await settle();
    expect(provider.send.mock.calls.some(([a]) => a.data.kind === 'security' && /increased by 60/.test(a.title))).toBe(true);
    setSetting('stock_adjust_approval_units', '25');
    push.resetForTests();
  });

  it('a courier organization past its limit is swept and pushed once per overdue episode', async () => {
    const courierOrganizations = require('../src/services/courierOrganizations.service');
    const m = await phone('manager', 'courierwatch');
    const spy = vi.spyOn(courierOrganizations, 'organizationStanding').mockReturnValue({ overdue: 450000, paused: false });
    const cid = db.prepare(`INSERT INTO couriers (store_id, name, kind, collects_payment) VALUES (?, 'G4S Test Org', 'organization', 1)`).run(storeId).lastInsertRowid;
    const provider = { name: 'fake', send: vi.fn(async () => ({ ok: true })) }; push.setProvider(provider);
    expect(notifications.sweepCourierRemittances()).toBeGreaterThanOrEqual(1);
    await settle();
    expect(db.prepare(`SELECT title FROM notifications WHERE user_id = ? AND type = 'courier_remittance_overdue'`).get(m.id).title).toMatch(/G4S Test Org owes KES 4,500/);
    expect(provider.send.mock.calls.some(([a]) => a.data.kind === 'courier_remittance_overdue')).toBe(true);
    const calls = provider.send.mock.calls.length;
    notifications.sweepCourierRemittances(); await settle();
    expect(provider.send.mock.calls.length).toBe(calls);
    spy.mockRestore(); push.resetForTests();
    db.prepare('UPDATE couriers SET collects_payment = 0 WHERE id = ?').run(cid);
  });

  it('runSweeps includes the new sweeps', () => {
    expect(notifications.runSweeps()).toMatchObject({ unmatchedPayments: expect.any(Number), courierRemittances: expect.any(Number) });
  });
});

describe('hosting the app (APK)', () => {
  const fakeApk = (size = 4096) => { const b = Buffer.alloc(size, 7); b.write('PK', 0, 'latin1'); return b; };
  const upload = (token, version, body) => request(app).post(`/api/v1/app/apk?version=${version}`).set(auth({ token })).set('Content-Type', 'application/octet-stream').send(body);
  afterAll(() => fs.rmSync(release.APK_DIR, { recursive: true, force: true }));

  it('only the owner uploads; it becomes the latest version; bad files are refused', async () => {
    expect((await upload(manager.token, '1.0.1', fakeApk())).status).toBe(403);
    expect((await upload(admin.mobile.token, 'abc', fakeApk())).status).toBe(400);
    expect((await upload(admin.mobile.token, '1.0.1', Buffer.from('not an apk at all'.repeat(100)))).status).toBe(400);
    expect((await upload(admin.mobile.token, '1.0.1', Buffer.alloc(10))).status).toBe(400);
    const ok = await upload(admin.mobile.token, '1.0.1', fakeApk());
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ version: '1.0.1', sizeBytes: 4096, latestVersion: '1.0.1' });
    expect((await request(app).get('/api/v1/app/version')).body.latestVersion).toBe('1.0.1');
    const older = await upload(admin.mobile.token, '1.0.0', fakeApk());
    expect(older.body.latestVersion).toBe('1.0.1');                          // an older upload never lowers "latest"
    expect(fs.readdirSync(release.APK_DIR).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('serves the file to a signed-in person only, as an Android package', async () => {
    expect((await request(app).get('/api/v1/app/apk')).status).toBe(401);
    const r = await request(app).get('/api/v1/app/apk').set(auth(manager)).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/android\.package-archive/);
    expect(r.headers['content-disposition']).toMatch(/urbantrends-1\.0\.1\.apk/);
    expect(r.headers['cache-control']).toMatch(/no-store/);
    expect(r.body.length).toBe(4096);
  });

  it('makes a signed link the owner can share; the link works without signing in, until it is tampered with or expires', async () => {
    expect((await post(manager, '/app/download-links')).status).toBe(403);
    const link = (await post(admin.mobile, '/app/download-links')).body;
    expect(link).toMatchObject({ version: '1.0.1' });
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    const path = link.url.replace(/^https?:\/\/[^/]+/, '');
    expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).get(`${path}x`)).status).toBe(401);
    expect((await request(app).get('/api/v1/app/download')).status).toBe(401);
    // a normal sign-in token is not a download link
    expect((await request(app).get(`/api/v1/app/download?t=${manager.token}`)).body.error.code).toBe('LINK_EXPIRED');
    const jwt = require('jsonwebtoken');
    const expired = jwt.sign({ purpose: 'apk-download', v: '1.0.1' }, process.env.JWT_SECRET, { expiresIn: -10 });
    expect((await request(app).get(`/api/v1/app/download?t=${expired}`)).status).toBe(401);
  });

  it('404s cleanly when no file exists for the latest version', async () => {
    setSetting('app_latest_version', '9.9.9');
    expect((await get(manager, '/app/apk')).status).toBe(404);
    expect((await post(admin.mobile, '/app/download-links')).status).toBe(404);
    setSetting('app_latest_version', '1.0.1');
  });
});
