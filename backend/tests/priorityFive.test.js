const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

// Priority 5: percentage discount limit and the delivery-area rate table.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
let adminToken; let cashier; let manager; let product;
let phoneCounter = 0;
const nextPhone = () => `07550${String(10000 + phoneCounter++)}`;

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} p5`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token };
}
const setSetting = (key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  cashier = await makeUser('cashier', 'p5-cashier@urbantrends.com');
  manager = await makeUser('manager', 'p5-manager@urbantrends.com');
  const res = await request(app).get('/api/products?pageSize=1').set(auth(adminToken));
  product = res.body.data[0];
});
afterAll(() => cleanupTestDb());

describe('percentage discount limit', () => {
  const sale = (token, discount) => request(app).post('/api/sales').set(auth(token)).send({
    items: [{ product_id: product.id, quantity: 1, discount }],
    payments: [{ method: 'cash', amount: product.sell_price - discount }],
  });

  it('is off by default (0 = no limit)', async () => {
    const res = await sale(cashier.token, Math.floor(product.sell_price * 0.9));
    expect(res.status).toBe(201);
  });

  it('stops a cashier above the limit but allows it at or below', async () => {
    setSetting('max_discount_percent', '10');
    const over = await sale(cashier.token, Math.floor(product.sell_price * 0.11));
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/above the 10% limit/i);
    const ok = await sale(cashier.token, Math.floor(product.sell_price * 0.1));
    expect(ok.status).toBe(201);
  });

  it('does not hold a manager or admin to the limit', async () => {
    const big = Math.floor(product.sell_price * 0.5);
    expect((await sale(manager.token, big)).status).toBe(201);
    expect((await sale(adminToken, big)).status).toBe(201);
  });

  it('counts the sale-wide discount together with line discounts', async () => {
    const res = await request(app).post('/api/sales').set(auth(cashier.token)).send({
      items: [{ product_id: product.id, quantity: 1 }],
      discountTotal: Math.floor(product.sell_price * 0.2),
      payments: [{ method: 'cash', amount: product.sell_price - Math.floor(product.sell_price * 0.2) }],
    });
    expect(res.status).toBe(400);
  });

  it('applies to orders too', async () => {
    const res = await request(app).post('/api/orders').set(auth(cashier.token)).send({
      name: 'Disc Test', phone: nextPhone(), city: 'Nairobi',
      items: [{ product_id: product.id, quantity: 1, discount: Math.floor(product.sell_price * 0.5) }],
    });
    expect(res.status).toBe(400);
    setSetting('max_discount_percent', '0');
  });
});

describe('delivery-area rate table', () => {
  it('imports rows (KES -> cents), updates on re-import, and rejects a bad sheet whole', async () => {
    const bad = await request(app).post('/api/delivery-areas/import').set(auth(adminToken)).send({ rows: [{ area_name: 'Ruiru', fee: '350' }, { area_name: 'Thika', fee: 'abc' }] });
    expect(bad.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM delivery_areas').get().c).toBe(0);

    const first = await request(app).post('/api/delivery-areas/import').set(auth(adminToken)).send({
      rows: [{ area_name: 'Ruiru', fee: '350' }, { area_name: 'Thika', fee: '1,200', courier_type: 'g4s' }, { area_name: 'Kasarani', fee: 250 }],
    });
    expect(first.body.data).toEqual({ created: 3, updated: 0, total: 3 });
    const again = await request(app).post('/api/delivery-areas/import').set(auth(adminToken)).send({ rows: [{ area_name: 'RUIRU', fee: 400 }] });
    expect(again.body.data).toEqual({ created: 0, updated: 1, total: 1 });
    expect(db.prepare(`SELECT fee FROM delivery_areas WHERE area_key = 'ruiru'`).get().fee).toBe(40000);
  });

  it('matches a town to its area, including "Town, County" text', async () => {
    const a = await request(app).get('/api/delivery-areas/lookup').query({ town: 'Kasarani, Nairobi', total: 100000 }).set(auth(cashier.token));
    expect(a.body.data).toMatchObject({ fee: 25000, source: 'area', area: { area_name: 'Kasarani' } });
    const b = await request(app).get('/api/delivery-areas/lookup').query({ town: 'Thika Town', total: 100000 }).set(auth(cashier.token));
    expect(b.body.data.fee).toBe(120000);
    const none = await request(app).get('/api/delivery-areas/lookup').query({ town: 'Mombasa', total: 100000 }).set(auth(cashier.token));
    expect(none.body.data).toMatchObject({ source: 'rule', area: null });
    expect(none.body.data.fee).toBe(30000); // flat KSh 300 under the KSh 5,000 threshold
  });

  it('sets the delivery fee and courier on a new order from the area, not the flat/percent rule', async () => {
    const res = await request(app).post('/api/orders').set(auth(adminToken)).send({
      name: 'Area Test', phone: nextPhone(), city: 'Thika', items: [{ product_id: product.id, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.delivery_fee).toBe(120000);
    expect(res.body.data.courier_type).toBe('g4s');
  });

  it('can be switched off so the old rule applies again', async () => {
    setSetting('delivery_use_area_rates', '0');
    const res = await request(app).get('/api/delivery-areas/lookup').query({ town: 'Thika', total: 100000 }).set(auth(cashier.token));
    expect(res.body.data.source).toBe('rule');
    setSetting('delivery_use_area_rates', '1');
  });

  it('only managers/admins can change the table', async () => {
    const res = await request(app).post('/api/delivery-areas').set(auth(cashier.token)).send({ area_name: 'Nowhere', fee: 100 });
    expect(res.status).toBe(403);
    const ok = await request(app).post('/api/delivery-areas').set(auth(manager.token)).send({ area_name: 'Juja', fee: 30000 });
    expect(ok.status).toBe(201);
    const dup = await request(app).post('/api/delivery-areas').set(auth(manager.token)).send({ area_name: 'juja', fee: 1 });
    expect(dup.status).toBe(409);
  });
});

describe('PDF invoices', () => {
  const binary = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

  it('downloads an order invoice and a sale invoice as real PDFs, store-scoped', async () => {
    const order = await request(app).post('/api/orders').set(auth(adminToken)).send({ name: 'Inv Test', phone: nextPhone(), city: 'Juja', items: [{ product_id: product.id, quantity: 2 }] });
    const o = await request(app).get(`/api/orders/${order.body.data.id}/invoice.pdf`).set(auth(adminToken)).buffer(true).parse(binary);
    expect(o.status).toBe(200);
    expect(o.headers['content-type']).toBe('application/pdf');
    expect(o.headers['content-disposition']).toMatch(/invoice_UT\d+\.pdf/);
    expect(o.body.slice(0, 5).toString()).toBe('%PDF-');

    const sale = await request(app).post('/api/sales').set(auth(adminToken)).send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
    const s = await request(app).get(`/api/sales/${sale.body.data.id}/invoice.pdf`).set(auth(adminToken)).buffer(true).parse(binary);
    expect(s.status).toBe(200);
    expect(s.body.slice(0, 5).toString()).toBe('%PDF-');
    expect((await request(app).get('/api/sales/999999/invoice.pdf').set(auth(adminToken))).status).toBe(404);
  });
});

describe('settings validation for the new keys', () => {
  it('rejects a percent outside 0-100 and accepts a valid one', async () => {
    const put = (body) => request(app).put('/api/settings').set(auth(adminToken)).send(body);
    expect((await put({ max_discount_percent: '150' })).status).toBe(400);
    expect((await put({ vat_rate_percent: 'abc' })).status).toBe(400);
    expect((await put({ max_discount_percent: '' })).status).toBe(400);
    expect((await put({ max_discount_percent: '12.5', vat_rate_percent: '16', business_pin: 'P051234567X' })).status).toBe(200);
    setSetting('max_discount_percent', '0');
  });
});
