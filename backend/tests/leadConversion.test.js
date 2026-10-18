const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;
let product;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set(auth());
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

let phoneCounter = 0;
const nextPhone = () => `07440${String(10000 + phoneCounter++)}`;

async function makeLead(extra = {}) {
  const res = await request(app).post('/api/leads').set(auth())
    .send({ name: 'Phase0 Lead', phone: nextPhone(), source: 'walk_in', ...extra });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('leads.converted_order_id foreign key', () => {
  it('points at orders, not sales', () => {
    const fk = db.prepare('PRAGMA foreign_key_list(leads)').all().find((f) => f.from === 'converted_order_id');
    expect(fk.table).toBe('orders');
  });

  it('PATCH refuses a converted_order_id that is not a real order', async () => {
    const lead = await makeLead();
    const res = await request(app).patch(`/api/leads/${lead.id}`).set(auth()).send({ converted_order_id: 999999 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/leads/:id/convert', () => {
  it('creates the order, links both ways, and marks the lead converted (stepping new -> contacted -> converted)', async () => {
    const lead = await makeLead({ email: 'convert@example.com' });
    const res = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 2 }], city: 'Nairobi' });
    expect(res.status).toBe(201);

    const { order, lead: converted, merged } = res.body.data;
    expect(merged).toBe(false);
    expect(order.status).toBe('awaiting_dispatch');
    expect(order.lead_id).toBe(lead.id);
    expect(order.customer.name).toBe('Phase0 Lead');
    expect(converted.status).toBe('converted');
    expect(converted.converted_order_id).toBe(order.id);

    const history = db.prepare('SELECT from_status, to_status FROM lead_status_history WHERE lead_id = ? ORDER BY id').all(lead.id);
    expect(history.map((h) => h.to_status)).toEqual(['contacted', 'converted']);
  });

  it('starts from one unit of the lead\'s product of interest when no items are sent', async () => {
    const lead = await makeLead();
    db.prepare('UPDATE leads SET interested_product_id = ? WHERE id = ?').run(product.id, lead.id);
    const res = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth()).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.order.items).toHaveLength(1);
    expect(res.body.data.order.items[0].quantity).toBe(1);
  });

  it('with no items and no product of interest, returns 400 and changes nothing', async () => {
    const lead = await makeLead();
    const res = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth()).send({});
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status).toBe('new');
  });

  it('is all-or-nothing: a failing order leaves the lead untouched and creates no order', async () => {
    const lead = await makeLead();
    const ordersBefore = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    const res = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth()).send({
      items: [{ product_id: product.id, quantity: 1 }], discount_total: product.sell_price + 1,
    });
    expect(res.status).toBe(400);

    const after = db.prepare('SELECT status, converted_order_id FROM leads WHERE id = ?').get(lead.id);
    expect(after.status).toBe('new');
    expect(after.converted_order_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n).toBe(ordersBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lead_status_history WHERE lead_id = ?').get(lead.id).n).toBe(0);
  });

  it('refuses to convert a lead twice, and a cancelled lead', async () => {
    const lead = await makeLead();
    const first = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(second.status).toBe(409);
    expect(second.body.details.orderId).toBe(first.body.data.order.id);

    const cancelled = await makeLead();
    await request(app).patch(`/api/leads/${cancelled.id}/status`).set(auth()).send({ status: 'cancelled' });
    const res = await request(app).post(`/api/leads/${cancelled.id}/convert`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(res.status).toBe(409);
  });

  it('a phone with an active order gets a 409 naming it; merge_into_order_id then merges in one step', async () => {
    const phone = nextPhone();
    const existing = await request(app).post('/api/orders').set(auth())
      .send({ name: 'Already Ordered', phone, items: [{ product_id: product.id, quantity: 1 }] });
    expect(existing.status).toBe(201);
    const existingId = existing.body.data.id;
    const totalBefore = existing.body.data.total;

    const lead = await makeLead({ phone });
    const items = [{ product_id: product.id, quantity: 1 }];

    const blocked = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth()).send({ items });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.existingOrderId).toBe(existingId);
    expect(blocked.body.details.canMerge).toBe(true);
    expect(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status).toBe('new');

    const merged = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth())
      .send({ items, merge_into_order_id: existingId });
    expect(merged.status).toBe(200);
    expect(merged.body.data.merged).toBe(true);
    expect(merged.body.data.order.id).toBe(existingId);
    expect(merged.body.data.order.total).toBe(totalBefore + product.sell_price);
    expect(merged.body.data.lead.status).toBe('converted');
    expect(merged.body.data.lead.converted_order_id).toBe(existingId);
    expect(db.prepare('SELECT lead_id FROM orders WHERE id = ?').get(existingId).lead_id).toBe(lead.id);
  });

  it('rejects a merge_into_order_id when the customer has no active order', async () => {
    const lead = await makeLead();
    const res = await request(app).post(`/api/leads/${lead.id}/convert`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1 }], merge_into_order_id: 1 });
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status).toBe('new');
  });

  it('404s for a lead that does not exist', async () => {
    const res = await request(app).post('/api/leads/999999/convert').set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(res.status).toBe(404);
  });
});

describe('migration: leads.converted_order_id foreign key repair', () => {
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

  it('rebuilds a legacy table: keeps provable links, clears wrong ones, restores missing ones, and is idempotent', () => {
    const file = path.join(os.tmpdir(), `utpos-fkmig-${process.pid}-${Date.now()}.db`);
    try {
      runMigrate(file); // a current, correct database

      // Put it back into the legacy shape: leads.converted_order_id -> sales(id).
      const d = new Database(file);
      d.pragma('foreign_keys = OFF');
      const sql = d.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='leads'`).get().sql;
      d.exec('DROP TABLE leads');
      d.exec(sql.replace(/(converted_order_id\s+INTEGER\s+REFERENCES\s+)orders/i, '$1sales'));
      expect(d.prepare('PRAGMA foreign_key_list(leads)').all().find((f) => f.from === 'converted_order_id').table).toBe('sales');

      const storeId = d.prepare(`INSERT INTO stores (name) VALUES ('Test Store')`).run().lastInsertRowid;
      d.prepare(`INSERT INTO customers (name, phone, phone_normalized) VALUES ('C', '0700000001', '700000001')`).run();
      const customerId = d.prepare('SELECT id FROM customers ORDER BY id DESC LIMIT 1').get().id;
      const lead = (name, phone, conv) => d.prepare(
        `INSERT INTO leads (store_id, name, phone, phone_normalized, source, converted_order_id) VALUES (?, ?, ?, ?, 'other', ?)`
      ).run(storeId, name, phone, phone.slice(-9), conv).lastInsertRowid;
      const order = (leadId) => d.prepare(
        `INSERT INTO orders (store_id, customer_id, lead_id, subtotal, total) VALUES (?, ?, ?, 100, 100)`
      ).run(storeId, customerId, leadId).lastInsertRowid;

      const missingLink = lead('missing', '0700000011', null);   // order points at it, lead does not point back
      const wrongLink = lead('wrong', '0700000012', 987654);     // points at nothing real
      const goodLink = lead('good', '0700000013', null);
      const orderForMissing = order(missingLink);
      const orderForGood = order(goodLink);
      d.prepare('UPDATE leads SET converted_order_id = ? WHERE id = ?').run(orderForGood, goodLink);
      d.close();

      runMigrate(file);

      const e = new Database(file);
      expect(e.prepare('PRAGMA foreign_key_list(leads)').all().find((f) => f.from === 'converted_order_id').table).toBe('orders');
      const get = (id) => e.prepare('SELECT converted_order_id AS c FROM leads WHERE id = ?').get(id).c;
      expect(get(missingLink)).toBe(orderForMissing);
      expect(get(wrongLink)).toBeNull();
      expect(get(goodLink)).toBe(orderForGood);
      expect(e.pragma('foreign_key_check')).toHaveLength(0);
      const indexes = e.prepare('PRAGMA index_list(leads)').all().map((i) => i.name);
      expect(indexes).toEqual(expect.arrayContaining(['idx_leads_phone_norm', 'idx_leads_status', 'idx_leads_external']));
      e.close();

      runMigrate(file); // second run must change nothing
      const f = new Database(file);
      expect(f.prepare('SELECT id, converted_order_id FROM leads ORDER BY id').all().map((r) => r.converted_order_id))
        .toEqual([orderForMissing, null, orderForGood]);
      f.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
    }
  });
});
