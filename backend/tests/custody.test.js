const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { moneyAtRisk, summarize } = require('../src/services/atRisk.service');
const custody = require('../src/services/custody.service');

// Ported from the update branch's server/tests/custody.test.ts. No ledger here, so "the books agree" is
// checked from the tables: the cash lands as an order payment, and the custody record is the evidence
// of who holds it until it is deposited.

let token; let product; let storeId; let adminId; let cashier; let phoneSeq = 0;
const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
const days = (n) => new Date(Date.now() + n * 86_400_000);
const code = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };

async function makeUser(role, email) {
  const hash = bcrypt.hashSync('Passw0rd!Passw0rd', 4);
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`).run(storeId, `Test ${role}`, email, hash, role);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' });
  return { id: r.lastInsertRowid, token: login.body.token };
}

beforeAll(async () => {
  token = await loginAsAdmin();
  product = (await request(app).get('/api/products?pageSize=1').set(auth())).body.data[0];
  const admin = db.prepare(`SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'`).get();
  adminId = admin.id; storeId = admin.store_id;
  cashier = await makeUser('cashier', 'custody-cashier@urbantrends.com');
});
afterAll(() => cleanupTestDb());

// A prepaid order dispatched with nothing paid yet (dispatched_unpaid): the state shop cash can be taken in.
async function dispatched() {
  const phone = `07770${String(++phoneSeq).padStart(5, '0')}`;
  const create = await request(app).post('/api/orders').set(auth()).send({ name: 'Custody Test', phone, payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
  const id = create.body.data.id;
  await request(app).post(`/api/orders/${id}/dispatch`).set(auth());
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}
const shopCash = (orderId, body, t = token) => request(app).post(`/api/orders/${orderId}/shop-cash`).set(auth(t)).send(body);
const row = (id) => db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);

describe('shop cash custody', () => {
  it('cash taken at the shop is held by a named person until it is deposited', async () => {
    const o = await dispatched();
    const res = await shopCash(o.id, { amount: o.total, reason: 'Customer came in with cash' }, cashier.token);
    expect(res.status).toBe(201);
    const rec = res.body.data.custody;
    expect(rec).toMatchObject({ holder_staff_id: cashier.id, order_id: o.id, amount: o.total, status: 'open', reason: 'Customer came in with cash' });

    // The cash counts as a payment on the order, and the order is now paid.
    const after = db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    expect(after.amount_paid).toBe(o.total);
    expect(after.status).toBe('dispatched_paid');
    expect(db.prepare(`SELECT method, amount, notes FROM payment_records WHERE id = ?`).get(rec.payment_record_id))
      .toEqual({ method: 'cash', amount: o.total, notes: 'Shop cash: Customer came in with cash' });

    // A manager sees who holds it.
    const list = await request(app).get('/api/custody').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.data.find((r) => r.id === rec.id)).toMatchObject({ order_id: o.id, order_ref: o.product_code, amount: o.total, holder: 'Test cashier' });

    const dep = await request(app).post(`/api/custody/${rec.id}/deposit`).set(auth());
    expect(dep.status).toBe(200);
    expect(dep.body.data.amount).toBe(o.total);
    expect(row(rec.id)).toMatchObject({ status: 'deposited', deposited_by: adminId });
    expect((await request(app).get('/api/custody').set(auth())).body.data.some((r) => r.id === rec.id)).toBe(false);
  });

  it('is an exception: it needs a reason, a positive amount, and cannot exceed what is owed', async () => {
    const o = await dispatched();
    expect((await shopCash(o.id, { amount: 1000 })).status).toBe(400);
    expect((await shopCash(o.id, { amount: 1000, reason: '   ' })).status).toBe(400);
    expect((await shopCash(o.id, { amount: 0, reason: 'x' })).status).toBe(400);
    expect(await code(() => custody.recordShopCash({ orderId: o.id, storeId, staffId: adminId, amount: 1000, reason: ' ' }))).toBe('CASH_REASON_REQUIRED');
    const over = await shopCash(o.id, { amount: o.total + 1, reason: 'too much' });
    expect(over.status).toBe(422);
    expect(over.body.error?.code ?? over.body.code).toBe('CASH_EXCEEDS_BALANCE');
    // Nothing was recorded by any of the refusals.
    expect(db.prepare('SELECT COUNT(*) AS n FROM custody_records WHERE order_id = ?').get(o.id).n).toBe(0);
    expect(db.prepare('SELECT amount_paid FROM orders WHERE id = ?').get(o.id).amount_paid).toBe(0);
  });

  it('part payment: the balance shrinks and a second cash taking cannot push past it', async () => {
    const o = await dispatched();
    const half = Math.floor(o.total / 2);
    const first = await shopCash(o.id, { amount: half, reason: 'part in cash' });
    expect(first.body.data.balance).toBe(o.total - half);
    expect((await shopCash(o.id, { amount: o.total - half + 1, reason: 'too much' })).status).toBe(422);
    expect((await shopCash(o.id, { amount: o.total - half, reason: 'rest in cash' })).status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM custody_records WHERE order_id = ?').get(o.id).n).toBe(2);
  });

  it('cannot be deposited twice, and a deposited record never changes', async () => {
    const o = await dispatched();
    const rec = (await shopCash(o.id, { amount: 10_000, reason: 'in person' })).body.data.custody;
    expect((await request(app).post(`/api/custody/${rec.id}/deposit`).set(auth())).status).toBe(200);
    const again = await request(app).post(`/api/custody/${rec.id}/deposit`).set(auth());
    expect(again.status).toBe(409);
    expect(again.body.error?.code ?? again.body.code).toBe('CUSTODY_ALREADY_DEPOSITED');
    expect(() => db.prepare(`UPDATE custody_records SET status = 'open', deposited_by = NULL, deposited_at = NULL WHERE id = ?`).run(rec.id)).toThrow(/never changes/);
    expect(() => db.prepare('UPDATE custody_records SET amount = 1 WHERE id = ?').run(rec.id)).toThrow();
    expect(() => db.prepare('DELETE FROM custody_records WHERE id = ?').run(rec.id)).toThrow(/cannot be deleted/);
    expect(await code(() => custody.deposit({ custodyId: 999_999, storeId, staffId: adminId }))).toBe('CUSTODY_NOT_FOUND');
    expect(await code(() => custody.deposit({ custodyId: rec.id, storeId, staffId: null }))).toBe('CUSTODY_NO_ACTOR');
  });

  it('while open, the amount, holder and order cannot be edited either, and a record cannot be closed without a closer', async () => {
    const o = await dispatched();
    const rec = (await shopCash(o.id, { amount: 5000, reason: 'in person' }, cashier.token)).body.data.custody;
    expect(() => db.prepare('UPDATE custody_records SET amount = 1 WHERE id = ?').run(rec.id)).toThrow(/never change/);
    expect(() => db.prepare('UPDATE custody_records SET holder_staff_id = ? WHERE id = ?').run(adminId, rec.id)).toThrow(/never change/);
    expect(() => db.prepare(`UPDATE custody_records SET status = 'deposited' WHERE id = ?`).run(rec.id)).toThrow();
    expect(row(rec.id).status).toBe('open');
  });

  it('only a manager or admin can list or deposit custody; a cashier can take the cash but not close it out', async () => {
    const o = await dispatched();
    const rec = (await shopCash(o.id, { amount: 7000, reason: 'in person' }, cashier.token)).body.data.custody;
    expect((await request(app).get('/api/custody').set(auth(cashier.token))).status).toBe(403);
    expect((await request(app).post(`/api/custody/${rec.id}/deposit`).set(auth(cashier.token))).status).toBe(403);
    expect(row(rec.id).status).toBe('open');
    expect((await request(app).get('/api/custody')).status).toBe(401);
  });

  it('two people depositing the same cash at once deposit it once', async () => {
    const o = await dispatched();
    const rec = (await shopCash(o.id, { amount: 12_000, reason: 'in person' })).body.data.custody;
    const results = await Promise.all([
      request(app).post(`/api/custody/${rec.id}/deposit`).set(auth()),
      request(app).post(`/api/custody/${rec.id}/deposit`).set(auth()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('only works on the shop\'s own orders, and only while the order can take a payment', async () => {
    const o = await dispatched();
    expect(await code(() => custody.recordShopCash({ orderId: o.id, storeId: storeId + 999, staffId: adminId, amount: 100, reason: 'x' }))).toBe('ORDER_NOT_FOUND');
    expect((await shopCash(999_999, { amount: 100, reason: 'x' })).status).toBe(404);
    await shopCash(o.id, { amount: o.total, reason: 'all in cash' });          // now dispatched_paid, nothing owed
    expect((await shopCash(o.id, { amount: 1, reason: 'more' })).status).toBe(422);
  });

  it('cash not deposited for days shows up as money at risk, naming who holds it', async () => {
    const o = await dispatched();
    const rec = (await shopCash(o.id, { amount: 8000, reason: 'in person' }, cashier.token)).body.data.custody;
    expect(moneyAtRisk({ storeId }).some((i) => i.kind === 'cash_not_deposited' && i.order_id === o.id)).toBe(false); // just taken
    const later = moneyAtRisk({ storeId, now: days(5) });
    const item = later.find((i) => i.kind === 'cash_not_deposited' && i.order_id === o.id);
    expect(item).toMatchObject({ owner: 'Test cashier', amount: 8000, order_ref: o.product_code, age_days: 5 });
    expect(summarize(later).by_kind.cash_not_deposited.count).toBeGreaterThan(0);

    // The threshold can be moved, and once deposited it stops being at risk.
    expect(moneyAtRisk({ storeId, now: days(5), cashHeldDays: 10 }).some((i) => i.kind === 'cash_not_deposited' && i.order_id === o.id)).toBe(false);
    custody.deposit({ custodyId: rec.id, storeId, staffId: adminId });
    expect(moneyAtRisk({ storeId, now: days(5) }).some((i) => i.kind === 'cash_not_deposited' && i.order_id === o.id)).toBe(false);
  });

  it('the money-at-risk endpoint accepts cash_held_days', async () => {
    const o = await dispatched();
    await shopCash(o.id, { amount: 3000, reason: 'in person' });
    const res = await request(app).get('/api/orders/at-risk?cash_held_days=0').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.summary.by_kind.cash_not_deposited).toBeDefined();
  });
});
