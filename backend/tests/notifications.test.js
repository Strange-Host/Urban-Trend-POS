process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';

const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const notificationsService = require('../src/services/notifications.service');

let adminToken;
let managerToken;
let cashierToken;
let adminId;
let managerId;
let cashierId;
let product;

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const rowsFor = (userId, type) => db.prepare('SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY id').all(userId, type);

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const result = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} user`, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' });
  return { id: result.lastInsertRowid, token: login.body.token };
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  adminId = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  ({ id: managerId, token: managerToken } = await makeUser('manager', 'manager-n@urbantrends.com'));
  ({ id: cashierId, token: cashierToken } = await makeUser('cashier', 'cashier-n@urbantrends.com'));
  const res = await request(app).get('/api/products?pageSize=1').set(auth(adminToken));
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

describe('notifications API — ownership and read state', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/notifications')).status).toBe(401);
    expect((await request(app).get('/api/notifications/unread-count')).status).toBe(401);
  });

  it('only ever lists, counts and marks the caller\'s own notifications', async () => {
    const storeId = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
    notificationsService.notify({ storeId, userIds: [adminId], type: 'test', title: 'for admin only' });
    notificationsService.notify({ storeId, userIds: [cashierId], type: 'test', title: 'for cashier only' });

    const adminList = await request(app).get('/api/notifications').set(auth(adminToken));
    expect(adminList.body.data.map((n) => n.title)).toContain('for admin only');
    expect(adminList.body.data.map((n) => n.title)).not.toContain('for cashier only');

    const adminRow = rowsFor(adminId, 'test')[0];
    // A cashier trying to mark the ADMIN's notification must look exactly like a missing id.
    const steal = await request(app).post(`/api/notifications/${adminRow.id}/read`).set(auth(cashierToken));
    expect(steal.status).toBe(404);
    expect(db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(adminRow.id).read_at).toBeNull();

    const own = await request(app).post(`/api/notifications/${adminRow.id}/read`).set(auth(adminToken));
    expect(own.status).toBe(200);
    expect(db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(adminRow.id).read_at).toBeTruthy();
  });

  it('tracks the unread count and supports read-all and the unread filter', async () => {
    const storeId = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(managerId);
    notificationsService.notify({ storeId, userIds: [managerId], type: 'test', title: 'one' });
    notificationsService.notify({ storeId, userIds: [managerId], type: 'test', title: 'two' });

    expect((await request(app).get('/api/notifications/unread-count').set(auth(managerToken))).body.data.unreadCount).toBe(2);
    const first = rowsFor(managerId, 'test')[0];
    await request(app).post(`/api/notifications/${first.id}/read`).set(auth(managerToken));

    const unread = await request(app).get('/api/notifications?unread=1').set(auth(managerToken));
    expect(unread.body.data).toHaveLength(1);
    expect(unread.body.unreadCount).toBe(1);

    const all = await request(app).post('/api/notifications/read-all').set(auth(managerToken));
    expect(all.body.data.updated).toBe(1);
    expect((await request(app).get('/api/notifications/unread-count').set(auth(managerToken))).body.data.unreadCount).toBe(0);
  });

  it('404s for an id that does not exist', async () => {
    expect((await request(app).post('/api/notifications/999999/read').set(auth(adminToken))).status).toBe(404);
  });
});

describe('notifications — lead assignment', () => {
  it('tells the assignee about a new lead, but not the person who assigned it to themselves', async () => {
    const res = await request(app).post('/api/leads').set(auth(adminToken))
      .send({ name: 'Lead For Cashier', phone: '0700100001', source: 'whatsapp', assigned_staff_id: cashierId });
    expect(res.status).toBe(201);
    const mine = rowsFor(cashierId, 'lead_assigned');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ entity_type: 'lead', entity_id: res.body.data.id });
    expect(mine[0].title).toContain('Lead For Cashier');

    const selfAssigned = await request(app).post('/api/leads').set(auth(adminToken))
      .send({ name: 'Admin Self Lead', phone: '0700100002', source: 'whatsapp', assigned_staff_id: adminId });
    expect(selfAssigned.status).toBe(201);
    expect(rowsFor(adminId, 'lead_assigned')).toHaveLength(0);
  });

  it('notifies the new owner when a lead is reassigned', async () => {
    const created = await request(app).post('/api/leads').set(auth(adminToken))
      .send({ name: 'Reassign Me', phone: '0700100003', source: 'referral', assigned_staff_id: adminId });
    const before = rowsFor(managerId, 'lead_assigned').length;
    const upd = await request(app).patch(`/api/leads/${created.body.data.id}`).set(auth(adminToken)).send({ assigned_staff_id: managerId });
    expect(upd.status).toBe(200);
    expect(rowsFor(managerId, 'lead_assigned')).toHaveLength(before + 1);
  });
});

describe('notifications — follow-up reminders', () => {
  it('notifies the owner AND managers/admins when a rescheduled lead\'s date arrives, once per date', async () => {
    const created = await request(app).post('/api/leads').set(auth(adminToken))
      .send({ name: 'Follow Up Lead', phone: '0700200001', source: 'whatsapp', assigned_staff_id: cashierId });
    const id = created.body.data.id;
    await request(app).patch(`/api/leads/${id}/status`).set(auth(adminToken)).send({ status: 'contacted' });
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const resched = await request(app).patch(`/api/leads/${id}/status`).set(auth(adminToken)).send({ status: 'rescheduled', follow_up_date: yesterday });
    expect(resched.status).toBe(200);

    const created1 = notificationsService.sweepLeadFollowUps();
    expect(created1).toBe(3); // cashier (owner) + manager + admin
    for (const uid of [cashierId, managerId, adminId]) {
      expect(rowsFor(uid, 'lead_follow_up_due').some((n) => n.entity_id === id)).toBe(true);
    }

    // The sweep runs every 15 minutes — it must not re-notify.
    expect(notificationsService.sweepLeadFollowUps()).toBe(0);

    // Pushing the date back notifies afresh for the new date.
    db.prepare(`UPDATE leads SET follow_up_date = ? WHERE id = ?`).run(new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10), id);
    expect(notificationsService.sweepLeadFollowUps()).toBe(3);
  });

  it('does not notify for a follow-up date in the future', async () => {
    const created = await request(app).post('/api/leads').set(auth(adminToken))
      .send({ name: 'Future Lead', phone: '0700200002', source: 'whatsapp', assigned_staff_id: cashierId });
    await request(app).patch(`/api/leads/${created.body.data.id}/status`).set(auth(adminToken)).send({ status: 'contacted' });
    const nextWeek = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    await request(app).patch(`/api/leads/${created.body.data.id}/status`).set(auth(adminToken)).send({ status: 'rescheduled', follow_up_date: nextWeek });
    expect(notificationsService.sweepLeadFollowUps()).toBe(0);
  });

  it('stops notifying once the lead leaves "rescheduled"', async () => {
    const created = await request(app).post('/api/leads').set(auth(adminToken))
      .send({ name: 'Resolved Lead', phone: '0700200003', source: 'whatsapp' });
    const id = created.body.data.id;
    await request(app).patch(`/api/leads/${id}/status`).set(auth(adminToken)).send({ status: 'contacted' });
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    await request(app).patch(`/api/leads/${id}/status`).set(auth(adminToken)).send({ status: 'rescheduled', follow_up_date: yesterday });
    await request(app).patch(`/api/leads/${id}/status`).set(auth(adminToken)).send({ status: 'cancelled' });
    notificationsService.sweepLeadFollowUps();
    expect(rowsFor(adminId, 'lead_follow_up_due').some((n) => n.entity_id === id)).toBe(false);
  });
});

describe('notifications — low stock', () => {
  it('notifies once per low episode and re-arms after stock recovers', () => {
    const inv = db.prepare('SELECT * FROM inventory WHERE product_id = ?').get(product.id);
    db.prepare('UPDATE inventory SET quantity = 2, reorder_level = 5 WHERE id = ?').run(inv.id);

    const first = notificationsService.sweepLowStock();
    expect(first).toBeGreaterThanOrEqual(2); // admin + manager (at least; other seeded products may also be low)
    const mine = rowsFor(adminId, 'low_stock').filter((n) => n.entity_id === product.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].severity).toBe('warning');
    expect(rowsFor(cashierId, 'low_stock')).toHaveLength(0); // cashiers don't manage stock

    // Still low next sweep — and even after being READ — no repeat.
    db.prepare('UPDATE notifications SET read_at = datetime(\'now\') WHERE user_id = ? AND type = ?').run(adminId, 'low_stock');
    const again = notificationsService.sweepLowStock();
    expect(rowsFor(adminId, 'low_stock').filter((n) => n.entity_id === product.id)).toHaveLength(1);
    expect(again).toBe(0);

    // Stock recovers: the dedupe key is released...
    db.prepare('UPDATE inventory SET quantity = 50 WHERE id = ?').run(inv.id);
    notificationsService.sweepLowStock();
    expect(db.prepare(`SELECT dedupe_key FROM notifications WHERE user_id = ? AND type = 'low_stock' AND entity_id = ?`).get(adminId, product.id).dedupe_key).toBeNull();

    // ...so running low AGAIN notifies again, and out-of-stock is urgent.
    db.prepare('UPDATE inventory SET quantity = 0 WHERE id = ?').run(inv.id);
    notificationsService.sweepLowStock();
    const all = rowsFor(adminId, 'low_stock').filter((n) => n.entity_id === product.id);
    expect(all).toHaveLength(2);
    expect(all[1].severity).toBe('urgent');
    expect(all[1].title).toContain('Out of stock');

    db.prepare('UPDATE inventory SET quantity = ?, reorder_level = ? WHERE id = ?').run(inv.quantity, inv.reorder_level, inv.id);
  });
});

describe('notifications — damaged return and unmatched payment', () => {
  it('raises an urgent notice for the owner (admin) when a return is inspected as damaged', async () => {
    const created = await request(app).post('/api/orders').set(auth(adminToken))
      .send({ name: 'Damaged Return', phone: '0700300001', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
    const order = created.body.data;
    await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth(adminToken));
    await request(app).post(`/api/orders/${order.id}/returned-in-transit`).set(auth(adminToken)).send({});
    await request(app).post(`/api/orders/${order.id}/returned-awaiting-inspection`).set(auth(adminToken));
    const inspect = await request(app).post(`/api/orders/${order.id}/inspect`).set(auth(adminToken)).send({ result: 'damaged' });
    expect(inspect.status).toBe(200);

    const n = rowsFor(adminId, 'damaged_return').find((x) => x.entity_id === order.id);
    expect(n).toBeTruthy();
    expect(n.severity).toBe('urgent');
    expect(rowsFor(managerId, 'damaged_return')).toHaveLength(0);
    expect(rowsFor(cashierId, 'damaged_return')).toHaveLength(0);
  });

  it('does not raise a damaged-return notice for a good inspection', async () => {
    const created = await request(app).post('/api/orders').set(auth(adminToken))
      .send({ name: 'Good Return', phone: '0700300002', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
    const order = created.body.data;
    await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth(adminToken));
    await request(app).post(`/api/orders/${order.id}/returned-in-transit`).set(auth(adminToken)).send({});
    await request(app).post(`/api/orders/${order.id}/returned-awaiting-inspection`).set(auth(adminToken));
    await request(app).post(`/api/orders/${order.id}/inspect`).set(auth(adminToken)).send({ result: 'good' });
    expect(rowsFor(adminId, 'damaged_return').some((x) => x.entity_id === order.id)).toBe(false);
  });

  it('tells admins and managers about an unmatched payment — once, even if the webhook is redelivered', async () => {
    const url = '/api/integrations/payments/callbacks/kcb/test-webhook-secret/callback';
    const body = { amount: '750.00', transactionId: 'NOTIF-TX-1', accountNumber: 'NOSUCHCODE', customerName: 'Mystery Payer' };
    await request(app).post(url).send(body);
    await request(app).post(url).send(body);

    for (const uid of [adminId, managerId]) {
      const rows = rowsFor(uid, 'unmatched_payment');
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toContain('KCB');
      expect(rows[0].title).toContain('750');
      expect(rows[0].severity).toBe('warning');
      expect(rows[0].body).toContain('Mystery Payer');
    }
    expect(rowsFor(cashierId, 'unmatched_payment')).toHaveLength(0);
  });

  it('does NOT raise an unmatched notice for a payment that matched an order', async () => {
    const created = await request(app).post('/api/orders').set(auth(adminToken))
      .send({ name: 'Matched Payer', phone: '0700300003', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
    const order = created.body.data;
    await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth(adminToken));
    const before = rowsFor(adminId, 'unmatched_payment').length;
    await request(app).post('/api/integrations/payments/callbacks/kcb/test-webhook-secret/callback')
      .send({ amount: (order.total / 100).toFixed(2), transactionId: 'NOTIF-TX-2', accountNumber: order.product_code });
    expect(rowsFor(adminId, 'unmatched_payment')).toHaveLength(before);
  });
});

describe('notifications — housekeeping', () => {
  it('prunes old read notices and very old unread ones, keeping recent and unread-recent', () => {
    const storeId = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(cashierId);
    const ins = db.prepare(`INSERT INTO notifications (store_id, user_id, type, title, read_at, created_at) VALUES (?, ?, 'prune_test', ?, ?, ?)`);
    ins.run(storeId, cashierId, 'old-read', "2020-01-01 00:00:00", "2020-01-01 00:00:00");
    ins.run(storeId, cashierId, 'old-unread-90d', null, "2020-01-01 00:00:00");
    const recent = new Date().toISOString().replace('T', ' ').slice(0, 19);
    ins.run(storeId, cashierId, 'recent-read', recent, recent);
    ins.run(storeId, cashierId, 'recent-unread', null, recent);
    const mid = db.prepare(`SELECT datetime('now', '-40 days') AS d`).get().d;
    ins.run(storeId, cashierId, 'mid-unread', null, mid); // 40 days old but UNREAD: kept (under 90d)
    ins.run(storeId, cashierId, 'mid-read', mid, mid);    // 40 days old and read: pruned

    notificationsService.pruneOld();
    const titles = db.prepare(`SELECT title FROM notifications WHERE user_id = ? AND type = 'prune_test' ORDER BY id`).all(cashierId).map((r) => r.title);
    expect(titles).toEqual(['recent-read', 'recent-unread', 'mid-unread']);
  });

  it('a failure inside notify() never throws into the caller', () => {
    expect(() => notificationsService.notify({ storeId: 99999, userIds: [99999], type: 'x', title: 'y' })).not.toThrow();
  });
});
