const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

// "Refund / void requires manager approval": a cashier files a request, a manager approves or rejects it, and approving
// runs the existing void / refund.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';

let admin;
let manager;
let manager2;
let cashier;
let cashier2;
let product;
let storeId;

async function makeUser(role, email) {
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `${role} ${email.split('@')[0]}`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token, name: login.body.user.name };
}

function revoke(userId, key) {
  db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, 0)`).run(userId, key);
}

const stock = () => db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(product.id, storeId).quantity;
const saleRow = (id) => db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
const requestRow = (id) => db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id);
const notices = (type, entityId) => db.prepare('SELECT user_id, title, body FROM notifications WHERE type = ? AND entity_id = ?').all(type, entityId);

async function ringUp(token) {
  const res = await request(app).post('/api/sales').set(auth(token))
    .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function askVoid(token, saleId, reason = 'Customer changed their mind') {
  return request(app).post('/api/approvals').set(auth(token)).send({ kind: 'void_sale', sale_id: saleId, reason });
}

async function recordPayment(saleId, amount = 5000) {
  const res = await request(app).post('/api/payments').set(auth(admin.token))
    .send({ direction: 'incoming', sale_id: saleId, method: 'cash', amount });
  expect(res.status).toBe(201);
  return res.body.data;
}

beforeAll(async () => {
  admin = { token: await loginAsAdmin() };
  admin.id = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  storeId = db.prepare('SELECT store_id FROM users WHERE id = ?').get(admin.id).store_id;

  manager = await makeUser('manager', 'appr-manager@urbantrends.com');
  manager2 = await makeUser('manager', 'appr-manager2@urbantrends.com');
  cashier = await makeUser('cashier', 'appr-cashier@urbantrends.com');
  cashier2 = await makeUser('cashier', 'appr-cashier2@urbantrends.com');

  product = db.prepare(`SELECT p.id, p.sell_price FROM products p WHERE p.is_active = 1 AND p.approval_status = 'approved' LIMIT 1`).get();
  db.prepare('UPDATE inventory SET quantity = quantity + 200 WHERE product_id = ? AND store_id = ?').run(product.id, storeId);
});

afterAll(() => cleanupTestDb());

describe('void a sale: request, then approve', () => {
  it('a cashier cannot void directly, but can ask — and the sale is untouched until someone approves', async () => {
    const sale = await ringUp(cashier.token);
    expect((await request(app).post(`/api/sales/${sale.id}/void`).set(auth(cashier.token))).status).toBe(403);

    const res = await askVoid(cashier.token, sale.id, 'Wrong item scanned');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'void_sale', status: 'pending', sale_id: sale.id, reason: 'Wrong item scanned', amount: sale.total, requested_by: cashier.id });
    expect(saleRow(sale.id).status).toBe('completed');
  });

  it('notifies managers and admins, but not the person who asked', async () => {
    const sale = await ringUp(cashier.token);
    const res = await askVoid(cashier.token, sale.id);
    const ids = notices('approval_requested', res.body.data.id).map((n) => n.user_id);
    expect(ids).toEqual(expect.arrayContaining([admin.id, manager.id, manager2.id]));
    expect(ids).not.toContain(cashier.id);
    expect(ids).not.toContain(cashier2.id);
    expect(notices('approval_requested', res.body.data.id)[0].body).toMatch(/Reason:/);
  });

  it('needs a reason, an existing sale, and only one open request per sale', async () => {
    const sale = await ringUp(cashier.token);
    expect((await request(app).post('/api/approvals').set(auth(cashier.token)).send({ kind: 'void_sale', sale_id: sale.id })).status).toBe(400);
    expect((await request(app).post('/api/approvals').set(auth(cashier.token)).send({ kind: 'void_sale', sale_id: sale.id, reason: 'ab' })).status).toBe(400);
    expect((await request(app).post('/api/approvals').set(auth(cashier.token)).send({ kind: 'void_sale', reason: 'no sale given' })).status).toBe(400);
    expect((await askVoid(cashier.token, 999999)).status).toBe(404);

    expect((await askVoid(cashier.token, sale.id)).status).toBe(201);
    const dup = await askVoid(cashier2.token, sale.id);
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/already waiting/);
    expect(db.prepare(`SELECT COUNT(*) n FROM approval_requests WHERE sale_id = ? AND status = 'pending'`).get(sale.id).n).toBe(1);
  });

  it('will not take a request for a sale that is already voided', async () => {
    const sale = await ringUp(cashier.token);
    await request(app).post(`/api/sales/${sale.id}/void`).set(auth(admin.token));
    const res = await askVoid(cashier.token, sale.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already voided/);
  });

  it('only a reviewer can approve or reject; a cashier cannot, even for someone else\'s request', async () => {
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;
    expect((await request(app).post(`/api/approvals/${id}/approve`).set(auth(cashier.token))).status).toBe(403);
    expect((await request(app).post(`/api/approvals/${id}/approve`).set(auth(cashier2.token))).status).toBe(403);
    expect((await request(app).post(`/api/approvals/${id}/reject`).set(auth(cashier2.token)).send({ note: 'nope nope' })).status).toBe(403);
    expect(requestRow(id).status).toBe('pending');
    expect(saleRow(sale.id).status).toBe('completed');
  });

  it('approving voids the sale, restocks it, records who approved, and tells the requester', async () => {
    const before = stock();
    const sale = await ringUp(cashier.token);
    expect(stock()).toBe(before - 1);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;

    const res = await request(app).post(`/api/approvals/${id}/approve`).set(auth(manager.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', reviewed_by: manager.id });
    expect(saleRow(sale.id).status).toBe('voided');
    expect(stock()).toBe(before); // restocked
    expect(db.prepare(`SELECT COUNT(*) n FROM inventory_movements WHERE reason = 'void' AND reference_id = ?`).get(sale.id).n).toBe(1);

    const told = notices('approval_decided', id);
    expect(told.map((n) => n.user_id)).toEqual([cashier.id]);
    expect(told[0].title).toMatch(/approved/);

    // Already handled: a second approval must not void twice.
    const again = await request(app).post(`/api/approvals/${id}/approve`).set(auth(manager2.token));
    expect(again.status).toBe(409);
    expect(stock()).toBe(before);
  });

  it('nobody can approve or reject their own request', async () => {
    const sale = await ringUp(manager.token);
    const id = (await askVoid(manager.token, sale.id)).body.data.id;
    const approve = await request(app).post(`/api/approvals/${id}/approve`).set(auth(manager.token));
    expect(approve.status).toBe(403);
    expect(approve.body.error.message).toMatch(/your own request/);
    expect((await request(app).post(`/api/approvals/${id}/reject`).set(auth(manager.token)).send({ note: 'self review' })).status).toBe(403);
    expect(saleRow(sale.id).status).toBe('completed');

    // …but another manager can.
    expect((await request(app).post(`/api/approvals/${id}/approve`).set(auth(manager2.token))).status).toBe(200);
    expect(saleRow(sale.id).status).toBe('voided');
  });

  it('a manager whose void right was taken away cannot use approvals to get round it', async () => {
    const limited = await makeUser('manager', 'appr-limited@urbantrends.com');
    revoke(limited.id, 'sales.void');
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;
    const res = await request(app).post(`/api/approvals/${id}/approve`).set(auth(limited.token));
    expect(res.status).toBe(403);
    expect(saleRow(sale.id).status).toBe('completed');
    expect(requestRow(id).status).toBe('pending');
  });

  it('rejecting needs a reason, leaves the sale alone, and passes the reason to the requester', async () => {
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;

    expect((await request(app).post(`/api/approvals/${id}/reject`).set(auth(manager.token)).send({})).status).toBe(400);
    expect(requestRow(id).status).toBe('pending');

    const res = await request(app).post(`/api/approvals/${id}/reject`).set(auth(manager.token)).send({ note: 'Item was not returned' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'rejected', review_note: 'Item was not returned', reviewed_by: manager.id });
    expect(saleRow(sale.id).status).toBe('completed');

    const told = notices('approval_decided', id);
    expect(told[0]).toMatchObject({ user_id: cashier.id });
    expect(told[0].title).toMatch(/rejected/);
    expect(told[0].body).toBe('Item was not returned');

    // A rejected request frees the sale for a fresh one.
    expect((await askVoid(cashier.token, sale.id, 'Customer came back with the item')).status).toBe(201);
  });

  it('the requester can withdraw their own pending request; nobody else, and not once it is decided', async () => {
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;
    expect((await request(app).post(`/api/approvals/${id}/cancel`).set(auth(cashier2.token))).status).toBe(403);
    const res = await request(app).post(`/api/approvals/${id}/cancel`).set(auth(cashier.token));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    expect((await request(app).post(`/api/approvals/${id}/cancel`).set(auth(cashier.token))).status).toBe(409);
    expect((await request(app).post(`/api/approvals/${id}/approve`).set(auth(manager.token))).status).toBe(409);
    expect(saleRow(sale.id).status).toBe('completed');
  });

  it('a manager voiding directly answers the open request instead of leaving it dangling', async () => {
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;
    expect((await request(app).post(`/api/sales/${sale.id}/void`).set(auth(manager.token))).status).toBe(200);
    const row = requestRow(id);
    expect(row.status).toBe('approved');
    expect(row.reviewed_by).toBe(manager.id);
    expect(row.review_note).toMatch(/Voided directly by/);
    expect(notices('approval_decided', id).map((n) => n.user_id)).toEqual([cashier.id]);
  });

  it('if the sale can no longer be voided, approving closes the request as failed rather than leaving it waiting', async () => {
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;
    db.prepare(`UPDATE sales SET status = 'voided' WHERE id = ?`).run(sale.id); // changed behind the request's back
    const before = stock();

    const res = await request(app).post(`/api/approvals/${id}/approve`).set(auth(manager.token));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already voided/);
    const row = requestRow(id);
    expect(row.status).toBe('failed');
    expect(row.review_note).toMatch(/already voided/);
    expect(stock()).toBe(before); // nothing restocked twice
    expect(notices('approval_decided', id)[0].title).toMatch(/could not be completed/);
  });

  it('the void alert and the audit log still fire when a void goes through approval', async () => {
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;
    await request(app).post(`/api/approvals/${id}/approve`).set(auth(manager.token));
    const logs = db.prepare(`SELECT staff_id, action FROM staff_logs WHERE entity_type = 'approval' AND entity_id = ? ORDER BY id`).all(id);
    expect(logs).toEqual([{ staff_id: cashier.id, action: 'create' }, { staff_id: manager.id, action: 'update' }]);
  });
});

describe('who sees which requests', () => {
  it('a cashier sees only their own; a reviewer sees the whole store\'s; the list says how many are waiting', async () => {
    const sale = await ringUp(cashier2.token);
    const id = (await askVoid(cashier2.token, sale.id, 'Duplicate charge')).body.data.id;

    const mine = await request(app).get('/api/approvals?status=pending').set(auth(cashier2.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((r) => r.id)).toContain(id);
    expect(mine.body.data.every((r) => r.requested_by === cashier2.id)).toBe(true);
    expect(mine.body.data[0]).toHaveProperty('requested_by_name');
    expect(mine.body.data[0]).toHaveProperty('target_ref');

    const other = await request(app).get('/api/approvals?status=pending').set(auth(cashier.token));
    expect(other.body.data.map((r) => r.id)).not.toContain(id);

    const all = await request(app).get('/api/approvals?status=pending').set(auth(manager.token));
    expect(all.body.data.map((r) => r.id)).toContain(id);
    expect(all.body.pending).toBeGreaterThanOrEqual(1);

    await request(app).post(`/api/approvals/${id}/reject`).set(auth(manager.token)).send({ note: 'Not valid' });
    const closed = await request(app).get('/api/approvals?status=closed').set(auth(manager.token));
    expect(closed.body.data.map((r) => r.id)).toContain(id);
    expect(closed.body.data.every((r) => r.status !== 'pending')).toBe(true);
    const stillPending = await request(app).get('/api/approvals?status=pending').set(auth(manager.token));
    expect(stillPending.body.data.map((r) => r.id)).not.toContain(id);
  });

  it('the sales list flags a sale that has a void request open, so the till can show "requested"', async () => {
    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;
    const list = await request(app).get('/api/sales?pageSize=50').set(auth(cashier.token));
    const row = list.body.data.find((s) => s.id === sale.id);
    expect(row.pending_void_request_id).toBe(id);
    const untouched = list.body.data.find((s) => s.id !== sale.id && s.status === 'completed' && s.pending_void_request_id == null);
    expect(untouched).toBeTruthy();
  });

  it('the storekeeper role has no till, so no access to any of this', async () => {
    const store = await makeUser('store', 'appr-store@urbantrends.com');
    expect((await request(app).get('/api/approvals').set(auth(store.token))).status).toBe(403);
  });
});

describe('another store cannot reach these requests', () => {
  it('a different store\'s admin cannot ask for, see, or approve a void on this store\'s sale', async () => {
    const storeB = db.prepare(`INSERT INTO stores (name) VALUES ('Approvals Store B')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'B Admin', 'appr-b-admin@urbantrends.com', ?, 'admin', 1)`)
      .run(storeB, bcrypt.hashSync(PASSWORD, 10));
    const bToken = (await request(app).post('/api/auth/login').send({ email: 'appr-b-admin@urbantrends.com', password: PASSWORD })).body.token;

    const sale = await ringUp(cashier.token);
    const id = (await askVoid(cashier.token, sale.id)).body.data.id;

    expect((await askVoid(bToken, sale.id)).status).toBe(404);
    const list = await request(app).get('/api/approvals').set(auth(bToken));
    expect(list.body.data.map((r) => r.id)).not.toContain(id);
    expect((await request(app).post(`/api/approvals/${id}/approve`).set(auth(bToken))).status).toBe(404);
    expect((await request(app).post(`/api/approvals/${id}/reject`).set(auth(bToken)).send({ note: 'not yours' })).status).toBe(404);
    expect(saleRow(sale.id).status).toBe('completed');
    expect(requestRow(id).status).toBe('pending');
  });
});

describe('refunding a recorded payment', () => {
  it('has its own permission: admin and manager keep it by default, and it can be taken away', async () => {
    const sale = await ringUp(cashier.token);
    const p1 = await recordPayment(sale.id);
    expect((await request(app).post(`/api/payments/${p1.id}/refund`).set(auth(manager.token))).status).toBe(200);

    const limited = await makeUser('manager', 'appr-norefund@urbantrends.com');
    revoke(limited.id, 'payments.refund');
    const p2 = await recordPayment(sale.id);
    const res = await request(app).post(`/api/payments/${p2.id}/refund`).set(auth(limited.token));
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT status FROM payment_records WHERE id = ?').get(p2.id).status).toBe('completed');
    expect((await request(app).post(`/api/payments/${p2.id}/refund`).set(auth(admin.token))).status).toBe(200);
  });

  it('someone who may not refund can ask; a reviewer approves and the refund runs', async () => {
    const asker = await makeUser('manager', 'appr-asker@urbantrends.com');
    revoke(asker.id, 'payments.refund');
    const sale = await ringUp(cashier.token);
    const payment = await recordPayment(sale.id, 7000);

    const res = await request(app).post('/api/approvals').set(auth(asker.token))
      .send({ kind: 'refund_payment', payment_id: payment.id, reason: 'Customer paid twice' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'refund_payment', status: 'pending', amount: 7000, payment_record_id: payment.id });
    expect(db.prepare('SELECT status FROM payment_records WHERE id = ?').get(payment.id).status).toBe('completed');

    const flagged = await request(app).get('/api/payments').set(auth(manager.token));
    expect(flagged.body.data.find((p) => p.id === payment.id).pending_refund_request_id).toBe(res.body.data.id);

    // can't approve their own, and a reviewer without the refund right can't either
    expect((await request(app).post(`/api/approvals/${res.body.data.id}/approve`).set(auth(asker.token))).status).toBe(403);
    const noRefund = await makeUser('manager', 'appr-norefund2@urbantrends.com');
    revoke(noRefund.id, 'payments.refund');
    expect((await request(app).post(`/api/approvals/${res.body.data.id}/approve`).set(auth(noRefund.token))).status).toBe(403);

    const ok = await request(app).post(`/api/approvals/${res.body.data.id}/approve`).set(auth(manager.token));
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('approved');
    expect(db.prepare('SELECT status FROM payment_records WHERE id = ?').get(payment.id).status).toBe('refunded');
    expect(notices('approval_decided', res.body.data.id).map((n) => n.user_id)).toEqual([asker.id]);
  });

  it('a cashier cannot ask for a payment refund (they cannot even see payments), and a refunded payment cannot be asked about', async () => {
    const sale = await ringUp(cashier.token);
    const payment = await recordPayment(sale.id);
    const asCashier = await request(app).post('/api/approvals').set(auth(cashier.token))
      .send({ kind: 'refund_payment', payment_id: payment.id, reason: 'Please refund' });
    expect(asCashier.status).toBe(403);

    await request(app).post(`/api/payments/${payment.id}/refund`).set(auth(admin.token));
    const again = await request(app).post('/api/approvals').set(auth(manager.token))
      .send({ kind: 'refund_payment', payment_id: payment.id, reason: 'Already done' });
    expect(again.status).toBe(409);
  });

  it('a direct refund answers the open request', async () => {
    const asker = await makeUser('manager', 'appr-asker2@urbantrends.com');
    revoke(asker.id, 'payments.refund');
    const sale = await ringUp(cashier.token);
    const payment = await recordPayment(sale.id);
    const id = (await request(app).post('/api/approvals').set(auth(asker.token))
      .send({ kind: 'refund_payment', payment_id: payment.id, reason: 'Wrong amount taken' })).body.data.id;

    expect((await request(app).post(`/api/payments/${payment.id}/refund`).set(auth(admin.token))).status).toBe(200);
    expect(requestRow(id)).toMatchObject({ status: 'approved', reviewed_by: admin.id });
    expect(requestRow(id).review_note).toMatch(/Refunded directly by/);
  });
});
