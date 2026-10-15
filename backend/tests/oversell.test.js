const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let token;
let n = 0;

beforeAll(async () => { token = await loginAsAdmin(); });

// A fresh product with an exact amount of stock, so tests never depend on the seed data.
function makeProduct(stock, price = 10000) {
  n += 1;
  const pid = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES (?, ?, 5000, ?, 1)`)
    .run(`OVS-${n}-${Date.now()}`, `Oversell Test ${n}`, price).lastInsertRowid;
  db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, ?)').run(pid, stock);
  return pid;
}
const stockOf = (pid) => db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = 1').get(pid).quantity;
const salesCount = () => db.prepare('SELECT COUNT(*) c FROM sales').get().c;
const checkout = (items, total) => request(app).post('/api/sales').set(auth(token))
  .send({ items, payments: [{ method: 'cash', amount: total }] });

describe('checkout never sells more than is in stock', () => {
  it('rejects the same product on two lines when the lines together exceed stock', async () => {
    const pid = makeProduct(4);
    const before = salesCount();
    const res = await checkout([{ product_id: pid, quantity: 3 }, { product_id: pid, quantity: 3 }], 60000);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Available: 4, requested: 6/);
    expect(stockOf(pid)).toBe(4);               // nothing deducted
    expect(salesCount()).toBe(before);          // no sale was created
  });

  it('accepts two lines that together fit exactly, and leaves stock at zero (not negative)', async () => {
    const pid = makeProduct(4);
    const res = await checkout([{ product_id: pid, quantity: 2 }, { product_id: pid, quantity: 2 }], 40000);
    expect(res.status).toBe(201);
    expect(stockOf(pid)).toBe(0);
  });

  it('still rejects a single line above stock, and sells the last unit', async () => {
    const pid = makeProduct(1);
    expect((await checkout([{ product_id: pid, quantity: 2 }], 20000)).status).toBe(409);
    expect((await checkout([{ product_id: pid, quantity: 1 }], 10000)).status).toBe(201);
    expect(stockOf(pid)).toBe(0);
    expect((await checkout([{ product_id: pid, quantity: 1 }], 10000)).status).toBe(409);
  });
});

describe('dispatching an online order never takes stock below zero', () => {
  it('rejects an order whose duplicate lines together exceed stock', async () => {
    const pid = makeProduct(4);
    n += 1;
    const created = await request(app).post('/api/orders').set(auth(token))
      .send({ payment_type: 'prepaid', name: 'Dup Lines', phone: `07440000${String(n).padStart(2, '0')}`, items: [{ product_id: pid, quantity: 3 }] });
    expect(created.status).toBe(201);
    const orderId = created.body.data.id;
    // an order pulled from a store can carry the same product on two lines
    db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, line_total) VALUES (?, ?, 3, 10000, 30000)').run(orderId, pid);

    const res = await request(app).post(`/api/orders/${orderId}/dispatch`).set(auth(token));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Available: 4, requested: 6/);
    expect(stockOf(pid)).toBe(4);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status).toBe('awaiting_dispatch');
  });
});

describe('the database refuses negative stock whichever code path tries it', () => {
  it('blocks a decrease below zero and a negative insert', () => {
    const pid = makeProduct(2);
    expect(() => db.prepare('UPDATE inventory SET quantity = quantity - 3 WHERE product_id = ?').run(pid))
      .toThrow(/cannot go below zero/);
    expect(stockOf(pid)).toBe(2);
    n += 1;
    const other = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES (?, 'neg insert', 1, 1, 1)`).run(`OVS-NEG-${n}`).lastInsertRowid;
    expect(() => db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, -1)').run(other))
      .toThrow(/cannot go below zero/);
  });

  it('lets an already-negative legacy row be restocked towards zero', () => {
    const pid = makeProduct(0);
    // simulate old data: force a negative value by dropping the guard, as it would exist in a pre-fix database
    db.exec('DROP TRIGGER trg_inventory_no_oversell');
    db.prepare('UPDATE inventory SET quantity = -3 WHERE product_id = ?').run(pid);
    db.exec(`CREATE TRIGGER trg_inventory_no_oversell BEFORE UPDATE OF quantity ON inventory
      WHEN NEW.quantity < 0 AND NEW.quantity < OLD.quantity
      BEGIN SELECT RAISE(ABORT, 'Insufficient stock: quantity cannot go below zero.'); END;`);
    expect(() => db.prepare('UPDATE inventory SET quantity = quantity + 2 WHERE product_id = ?').run(pid)).not.toThrow();
    expect(stockOf(pid)).toBe(-1);
    expect(() => db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE product_id = ?').run(pid)).toThrow();
  });
});

describe('manual stock adjustment input', () => {
  it('requires whole numbers and still refuses a result below zero', async () => {
    const pid = makeProduct(5);
    const frac = await request(app).post('/api/inventory/adjust').set(auth(token)).send({ product_id: pid, change_qty: 1.5, reason: 'adjustment' });
    expect(frac.status).toBe(400);
    const below = await request(app).post('/api/inventory/adjust').set(auth(token)).send({ product_id: pid, change_qty: -9, reason: 'adjustment' });
    expect(below.status).toBe(400);
    const ok = await request(app).post('/api/inventory/adjust').set(auth(token)).send({ product_id: pid, change_qty: -5, reason: 'adjustment' });
    expect(ok.status).toBe(200);
    expect(stockOf(pid)).toBe(0);
  });
});
