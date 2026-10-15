const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const notificationsService = require('../src/services/notifications.service');

let adminToken;
let adminId;
let cashier;
let manager;
let product;

const auth = (t) => ({ Authorization: `Bearer ${t}` });
// staff_logs.changes is { field: { from, to } } — flatten to the new values
const toAfter = (changesJson) => Object.fromEntries(Object.entries(JSON.parse(changesJson)).map(([k, v]) => [k, v.to]));

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} csr`, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' });
  return { id: r.lastInsertRowid, token: login.body.token };
}

async function makeOrder(overrides = {}) {
  const res = await request(app).post('/api/orders').set(auth(adminToken)).send({
    name: 'Receipt <b>Customer</b>', phone: '0711555001', city: 'Nairobi', payment_type: 'prepaid',
    items: [{ product_id: product.id, quantity: 2 }], ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.data;
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  adminId = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  cashier = await makeUser('cashier', 'csr-cashier@urbantrends.com');
  manager = await makeUser('manager', 'csr-manager@urbantrends.com');
  product = (await request(app).get('/api/products?pageSize=1').set(auth(adminToken))).body.data[0];
});

afterAll(() => cleanupTestDb());

describe('couriers', () => {
  let courierId;

  it('admin/manager can add couriers; a cashier cannot', async () => {
    const res = await request(app).post('/api/couriers').set(auth(manager.token))
      .send({ name: 'Peter Boda', phone: '0700111222', vehicle: 'KMEB 123X', courier_type: 'boda' });
    expect(res.status).toBe(201);
    courierId = res.body.data.id;
    expect((await request(app).post('/api/couriers').set(auth(cashier.token)).send({ name: 'X', courier_type: 'boda' })).status).toBe(403);
  });

  it('every signed-in user can list active couriers (the order screen needs the picker)', async () => {
    const res = await request(app).get('/api/couriers').set(auth(cashier.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.name)).toContain('Peter Boda');
    expect((await request(app).get('/api/couriers')).status).toBe(401);
  });

  it('validates input', async () => {
    expect((await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: '', courier_type: 'boda' })).status).toBe(400);
    expect((await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Z', courier_type: 'drone' })).status).toBe(400);
  });

  it('assigning a named courier sets the courier type too, and shows on the order', async () => {
    const order = await makeOrder();
    const res = await request(app).post(`/api/orders/${order.id}/courier`).set(auth(cashier.token)).send({ courier_id: courierId });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ courier_id: courierId, courier_type: 'boda' });

    const detail = await request(app).get(`/api/orders/${order.id}`).set(auth(adminToken));
    expect(detail.body.data.courier).toMatchObject({ name: 'Peter Boda', phone: '0700111222' });
  });

  it('choosing only a courier TYPE clears the named courier (they would no longer match)', async () => {
    const order = await makeOrder({ phone: '0711555002' });
    await request(app).post(`/api/orders/${order.id}/courier`).set(auth(adminToken)).send({ courier_id: courierId });
    const res = await request(app).post(`/api/orders/${order.id}/courier`).set(auth(adminToken)).send({ courier_type: 'g4s' });
    expect(res.body.data).toMatchObject({ courier_type: 'g4s', courier_id: null });
  });

  it('an unknown or inactive courier cannot be assigned', async () => {
    const order = await makeOrder({ phone: '0711555003' });
    expect((await request(app).post(`/api/orders/${order.id}/courier`).set(auth(adminToken)).send({ courier_id: 99999 })).status).toBe(404);

    const gone = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Retired', courier_type: 'g4s' })).body.data;
    expect((await request(app).delete(`/api/couriers/${gone.id}`).set(auth(adminToken))).status).toBe(200);
    expect((await request(app).post(`/api/orders/${order.id}/courier`).set(auth(adminToken)).send({ courier_id: gone.id })).status).toBe(409);

    const active = await request(app).get('/api/couriers').set(auth(adminToken));
    expect(active.body.data.map((c) => c.name)).not.toContain('Retired');
    const all = await request(app).get('/api/couriers?all=1').set(auth(adminToken));
    expect(all.body.data.map((c) => c.name)).toContain('Retired');
    // a cashier asking for ?all=1 does not get inactive couriers
    const cashierAll = await request(app).get('/api/couriers?all=1').set(auth(cashier.token));
    expect(cashierAll.body.data.map((c) => c.name)).not.toContain('Retired');
  });

  it('the courier list shows each rider\'s unpaid parcels', async () => {
    const order = await makeOrder({ phone: '0711555004' });
    await request(app).post(`/api/orders/${order.id}/courier`).set(auth(adminToken)).send({ courier_id: courierId });
    await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth(adminToken));
    const row = (await request(app).get('/api/couriers').set(auth(adminToken))).body.data.find((c) => c.id === courierId);
    expect(row.unpaid_parcels).toBeGreaterThanOrEqual(1);
    expect(row.unpaid_amount).toBeGreaterThan(0);
  });
});

describe('receipts', () => {
  it('builds an order receipt server-side with paybill and the prefixed account when owed', async () => {
    await request(app).put('/api/settings').set(auth(adminToken)).send({ paybill_number: '522533', kcb_account_prefix: '8025631', business_name: 'Urban Trends Ltd', receipt_footer: 'Karibu tena' });
    const order = await makeOrder({ phone: '0711555005' });
    const res = await request(app).get(`/api/orders/${order.id}/receipt`).set(auth(cashier.token)); // a cashier can print — no Settings access needed
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.kind).toBe('order');
    expect(r.business).toMatchObject({ name: 'Urban Trends Ltd', footer: 'Karibu tena' });
    expect(r.reference).toBe(order.product_code);
    expect(r.items[0]).toMatchObject({ name: product.name, quantity: 2 });
    expect(r.totals.total).toBe(order.total);
    expect(r.totals.balance).toBe(order.total);
    expect(r.payment).toEqual({ paybill: '522533', account: `8025631#${order.product_code}`, show: true });
  });

  it('hides payment instructions once fully paid, and passes customer text through untouched (the browser renders it as text)', async () => {
    const order = await makeOrder({ phone: '0711555006', name: 'Eve <script>alert(1)</script>' });
    await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth(adminToken));
    await request(app).post('/api/integrations/payments/webhook').set('X-Webhook-Secret', 'x').send({}); // ignored; payment below is via the recorded-payment route
    const pay = await request(app).post(`/api/orders/${order.id}/payments`).set(auth(adminToken)).send({ amount: order.total, method: 'cash' });
    expect([200, 201]).toContain(pay.status);
    const r = (await request(app).get(`/api/orders/${order.id}/receipt`).set(auth(adminToken))).body.data;
    expect(r.totals).toMatchObject({ paid: order.total, balance: 0 });
    expect(r.payment.show).toBe(false);
    expect(r.customer.name).toBe('Eve <script>alert(1)</script>');
  });

  it('404s for a missing order, requires sign-in, and builds a till receipt for a sale', async () => {
    expect((await request(app).get('/api/orders/999999/receipt').set(auth(adminToken))).status).toBe(404);
    expect((await request(app).get('/api/orders/1/receipt')).status).toBe(401);

    await request(app).post('/api/cash-sessions/open').set(auth(adminToken)).send({ openingAmount: 0 });
    const sale = await request(app).post('/api/sales').set(auth(adminToken)).send({
      items: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: product.sell_price }],
    });
    expect(sale.status).toBe(201);
    const till = (await request(app).get(`/api/sales/${sale.body.data.id}/receipt`).set(auth(cashier.token))).body.data;
    expect(till.kind).toBe('sale');
    expect(till.reference).toBe(`S-${sale.body.data.id}`);
    expect(till.items).toHaveLength(1);
    expect(till.items[0].name).toBe(product.name);
    expect(till.totals.total).toBe(product.sell_price);
    expect(till.totals.paid).toBe(product.sell_price);
    expect(till.payments[0].method).toBe('cash');
    expect(till.cashier).toBeTruthy();
    expect((await request(app).get('/api/sales/999999/receipt').set(auth(adminToken))).status).toBe(404);
  });
});

describe('shift handover', () => {
  it('lists the signed-in person\'s own open items — and only theirs', async () => {
    const mine = await makeOrder({ phone: '0711555007', payment_type: 'cod', assigned_staff_id: cashier.id });
    await makeOrder({ phone: '0711555008', payment_type: 'cod', assigned_staff_id: manager.id });
    const lead = await request(app).post('/api/leads').set(auth(adminToken)).send({ name: 'Open Lead', phone: '0711555009', source: 'whatsapp', assigned_staff_id: cashier.id });
    expect(lead.status).toBe(201);

    const res = await request(app).get('/api/shift/handover').set(auth(cashier.token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.has_open_items).toBe(true);
    expect(d.unconfirmed_cod.sample.map((o) => o.id)).toContain(mine.id);
    expect(d.unconfirmed_cod.count).toBe(1);
    expect(d.leads_needing_action.count).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/shift/handover')).status).toBe(401);
  });

  it('clock-out records the snapshot + note in the audit log and tells managers (once per day)', async () => {
    await request(app).post('/api/attendance/clock-in').set(auth(cashier.token));
    const out = await request(app).post('/api/attendance/clock-out').set(auth(cashier.token)).send({ handover_notes: 'Customer will pay tomorrow' });
    expect(out.status).toBe(200);
    expect(out.body.handover.has_open_items).toBe(true);

    const log = db.prepare(`SELECT changes FROM staff_logs WHERE entity_type = 'shift_handover' AND staff_id = ? ORDER BY id DESC`).get(cashier.id);
    const after = toAfter(log.changes);
    expect(after).toMatchObject({ trigger: 'clock_out', notes: 'Customer will pay tomorrow' });
    expect(after.unconfirmed_cod).toBe(1);

    for (const uid of [manager.id, adminId]) {
      const notes = db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND type = 'shift_handover'`).all(uid);
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toContain('Customer will pay tomorrow');
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'shift_handover'`).get(cashier.id).n).toBe(0);
  });

  it('closing a cash session also records a handover; no notification when nothing is open', async () => {
    const quiet = await makeUser('cashier', 'csr-quiet@urbantrends.com');
    const open = await request(app).post('/api/cash-sessions/open').set(auth(quiet.token)).send({ openingAmount: 100 });
    expect(open.status).toBe(201);
    const close = await request(app).post(`/api/cash-sessions/${open.body.data.id}/close`).set(auth(quiet.token)).send({ closingAmount: 100 });
    expect(close.status).toBe(200);
    expect(close.body.handover.has_open_items).toBe(false);
    const log = db.prepare(`SELECT changes FROM staff_logs WHERE entity_type = 'shift_handover' AND staff_id = ?`).get(quiet.id);
    expect(toAfter(log.changes).trigger).toBe('cash_session_close');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE type = 'shift_handover' AND title LIKE ?`).get('%csr quiet%').n).toBe(0);
  });

  it('a handover failure can never break clock-out (the service swallows errors)', () => {
    const shift = require('../src/services/shift.service');
    expect(() => shift.recordHandover({ userId: 999999, storeId: 999999, trigger: 'clock_out' })).not.toThrow();
    expect(notificationsService).toBeTruthy();
  });
});
