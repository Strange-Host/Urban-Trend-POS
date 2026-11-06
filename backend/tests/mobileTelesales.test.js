const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');
const ordersService = require('../src/services/orders.service');

beforeAll(async () => { await H.loginAsAdmin(); });
afterAll(() => cleanupTestDb());

let n = 0;
const phone = () => { n += 1; return `07${String(10000000 + Math.floor(Math.random() * 80000000) + n).slice(0, 8)}`; };

// An online COD order assigned to `agent` (an explicit assignment always wins over auto-distribution).
function makeOrder(agent, { qty = 1, p = phone() } = {}) {
  const product = H.makeProduct({ sell: 150000 });
  db.prepare('UPDATE inventory SET quantity = 20 WHERE product_id = ? AND store_id = ?').run(product.id, H.storeId());
  const o = ordersService.create({ storeId: H.storeId(), staffId: agent.id, name: `Customer ${n}`, phone: p, city: 'Nairobi', assignedStaffId: agent.id, channel: 'manual', items: [{ product_id: product.id, quantity: qty }], paymentType: 'cod' });
  return o.id;
}
// Make a second active order that shares the first one's customer (create() itself refuses a duplicate phone).
function makeDuplicateOf(orderId, agent) {
  const other = makeOrder(agent);
  db.prepare('UPDATE orders SET customer_id = (SELECT customer_id FROM orders WHERE id = ?) WHERE id = ?').run(orderId, other);
  return other;
}
const get = (u, id) => request(app).get(`/api/v1/telesales/orders/${id}`).set(auth(u));
const post = (u, path, body = {}) => request(app).post(`/api/v1/${path}`).set(auth(u)).send(body);
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

describe('my orders', () => {
  it('lists only my unconfirmed COD orders, oldest first, and never another agent\'s', async () => {
    const a = await H.makeUser('cashier', 'tele-a');
    const b = await H.makeUser('cashier', 'tele-b');
    const first = makeOrder(a);
    const second = makeOrder(a);
    const theirs = makeOrder(b);
    db.prepare(`UPDATE orders SET created_at = datetime('now','-2 hours') WHERE id = ?`).run(first);
    db.prepare(`UPDATE orders SET created_at = datetime('now','-1 hours') WHERE id = ?`).run(second);

    const res = await request(app).get('/api/v1/telesales/orders').set(auth(a));
    expect(res.status).toBe(200);
    expect(res.body.items.map((o) => o.id)).toEqual([first, second]);
    expect(res.body.total).toBe(2);
    expect(res.body.items[0]).toMatchObject({ status: 'awaiting_dispatch', paymentType: 'cod', itemCount: 1, duplicateCount: 0 });
    expect(res.body.items[0].confirmBy).toMatch(/Z$/);
    expect(new Date(res.body.serverTime).getTime()).toBeLessThan(Date.now() + 5000);
    expect(res.body.items.find((o) => o.id === theirs)).toBeUndefined();
  });

  it('answers 404 (not 403) for someone else\'s order, on every action, so nothing leaks', async () => {
    const a = await H.makeUser('cashier', 'tele-own');
    const b = await H.makeUser('cashier', 'tele-other');
    const id = makeOrder(b);
    expect((await get(a, id)).status).toBe(404);
    expect((await post(a, `orders/${id}/confirm`)).status).toBe(404);
    expect((await post(a, `orders/${id}/reschedule`, { callbackAt: inHours(3) })).status).toBe(404);
    expect((await post(a, `orders/${id}/cancel`, { reason: 'not mine' })).status).toBe(404);
    expect((await get(a, 99999999)).status).toBe(404);
    expect(db.prepare('SELECT cod_confirmed_at, status FROM orders WHERE id = ?').get(id)).toMatchObject({ cod_confirmed_at: null, status: 'awaiting_dispatch' });
  });

  it('needs the telesales.work permission', async () => {
    const mgr = await H.makeUser('manager', 'tele-mgr');
    expect((await request(app).get('/api/v1/telesales/orders').set(auth(mgr))).status).toBe(403);
    const cashier = await H.makeUser('cashier', 'tele-revoked');
    H.revoke(cashier.id, 'telesales.work');
    expect((await request(app).get('/api/v1/telesales/orders').set(auth(cashier))).status).toBe(403);
  });

  it('pages with a cursor', async () => {
    const a = await H.makeUser('cashier', 'tele-page');
    const ids = [makeOrder(a), makeOrder(a), makeOrder(a)];
    ids.forEach((id, i) => db.prepare(`UPDATE orders SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${10 - i} minutes`, id));
    const p1 = await request(app).get('/api/v1/telesales/orders?limit=2').set(auth(a));
    expect(p1.body.items.map((o) => o.id)).toEqual(ids.slice(0, 2));
    const p2 = await request(app).get(`/api/v1/telesales/orders?limit=2&cursor=${p1.body.nextCursor}`).set(auth(a));
    expect(p2.body.items.map((o) => o.id)).toEqual([ids[2]]);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe('confirm, reschedule, cancel', () => {
  it('confirming goes through the COD gate and the web order shows it immediately', async () => {
    const a = await H.makeUser('cashier', 'tele-confirm');
    const id = makeOrder(a);
    const d = await get(a, id);
    expect(d.body).toMatchObject({ confirmed: false, duplicates: [], duplicateApproval: null });
    expect(d.body.items[0]).toMatchObject({ quantity: 1, unitPriceCents: 150000 });

    const res = await post(a, `orders/${id}/confirm`);
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(true);
    const web = ordersService.getOrderWithItems(id, H.storeId());
    expect(web.cod_confirmed_at).toBeTruthy();
    expect(web.cod_confirmed_by).toBe(a.id);
    expect(web.status).toBe('awaiting_dispatch');   // dispatch is still the shop's step
    expect((await post(a, `orders/${id}/confirm`)).body.error.code).toBe('NOT_AWAITING');
    const listed = await request(app).get('/api/v1/telesales/orders').set(auth(a));
    expect(listed.body.items.find((o) => o.id === id)).toBeUndefined();
    expect(H.lastLog('order', id).changes.telesales.to).toBe('confirmed');
  });

  it('refuses to confirm once the confirmation window has elapsed (the sweep then cancels it)', async () => {
    const a = await H.makeUser('cashier', 'tele-late');
    const id = makeOrder(a);
    db.prepare(`UPDATE orders SET cod_confirmation_expires_at = datetime('now','-5 minutes') WHERE id = ?`).run(id);
    const res = await post(a, `orders/${id}/confirm`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/window/i);
    // the 409 rolls the attempt back, so the periodic sweep is what cancels it
    expect(ordersService.expireUnconfirmedOrders()).toContain(id);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status).toBe('cancelled');
  });

  it('reschedule records the callback and moves the auto-cancel past it; bad times are refused', async () => {
    const a = await H.makeUser('cashier', 'tele-resched');
    const id = makeOrder(a);
    const before = db.prepare('SELECT cod_confirmation_expires_at AS e FROM orders WHERE id = ?').get(id).e;
    expect((await post(a, `orders/${id}/reschedule`, { callbackAt: new Date(Date.now() - 60000).toISOString() })).body.error.code).toBe('INVALID_TIME');
    expect((await post(a, `orders/${id}/reschedule`, { callbackAt: inHours(24 * 9) })).body.error.code).toBe('INVALID_TIME');
    expect((await post(a, `orders/${id}/reschedule`, { callbackAt: 'tomorrow-ish' })).body.error.code).toBe('INVALID_TIME');

    const when = inHours(26);
    const res = await post(a, `orders/${id}/reschedule`, { callbackAt: when, note: 'At work, call after 6' });
    expect(res.status).toBe(200);
    expect(Math.abs(new Date(res.body.callbackAt).getTime() - new Date(when).getTime())).toBeLessThan(1000);   // stored to the second
    expect(res.body.callbackCount).toBe(1);
    const row = db.prepare('SELECT cod_confirmation_expires_at AS e, status FROM orders WHERE id = ?').get(id);
    expect(row.status).toBe('awaiting_dispatch');
    expect(row.e > before).toBe(true);                       // it must survive until after the promised call
    expect(res.body.history.some((h) => /rescheduled/i.test(h.note || ''))).toBe(true);
    // expireUnconfirmedOrders (the 15-minute sweep) must leave it alone now
    expect(ordersService.expireUnconfirmedOrders()).not.toContain(id);
  });

  it('cancel needs a reason, cancels through the state machine, and a cancelled order is gone from my list', async () => {
    const a = await H.makeUser('cashier', 'tele-cancel');
    const id = makeOrder(a);
    expect((await post(a, `orders/${id}/cancel`, {})).status).toBe(400);
    expect((await post(a, `orders/${id}/cancel`, { reason: 'ok' })).status).toBe(400);   // too short to be a reason
    const res = await post(a, `orders/${id}/cancel`, { reason: 'Customer changed their mind' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(db.prepare('SELECT cancelled_at FROM orders WHERE id = ?').get(id).cancelled_at).toBeTruthy();
    expect(ordersService.getOrderWithItems(id, H.storeId()).status_history.some((h) => /Customer changed their mind/.test(h.notes || ''))).toBe(true);
    expect((await post(a, `orders/${id}/cancel`, { reason: 'again please' })).body.error.code).toBe('NOT_AWAITING');
    expect(H.lastLog('order', id).changes.telesales.to).toBe('cancelled');
  });

  it('a confirmed order can no longer be rescheduled or cancelled from the phone', async () => {
    const a = await H.makeUser('cashier', 'tele-done');
    const id = makeOrder(a);
    await post(a, `orders/${id}/confirm`);
    expect((await post(a, `orders/${id}/reschedule`, { callbackAt: inHours(3) })).body.error.code).toBe('NOT_AWAITING');
    expect((await post(a, `orders/${id}/cancel`, { reason: 'too late now' })).body.error.code).toBe('NOT_AWAITING');
  });
});

describe('duplicate phone numbers', () => {
  it('warns, refuses to confirm, and lets a manager approve it from the approvals list', async () => {
    const a = await H.makeUser('cashier', 'dup-agent');
    const mgr = await H.makeUser('manager', 'dup-mgr');
    const first = makeOrder(a);
    const second = makeDuplicateOf(first, a);

    const d = await get(a, second);
    expect(d.body.duplicates).toHaveLength(1);
    expect(d.body.duplicates[0]).toMatchObject({ orderId: first, status: 'awaiting_dispatch' });
    expect(d.body.duplicateApproval).toBeNull();
    expect((await request(app).get('/api/v1/telesales/orders').set(auth(a))).body.items.find((o) => o.id === second).duplicateCount).toBe(1);

    const refused = await post(a, `orders/${second}/confirm`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('DUPLICATE_PHONE');
    expect(refused.body.details.duplicates[0].orderId).toBe(first);
    expect(db.prepare('SELECT cod_confirmed_at FROM orders WHERE id = ?').get(second).cod_confirmed_at).toBeNull();

    const asked = await post(a, `orders/${second}/duplicate-approval`, { note: 'Same customer, second pair of shoes' });
    expect(asked.status).toBe(201);
    expect(asked.body.approval.status).toBe('pending');
    expect((await post(a, `orders/${second}/duplicate-approval`)).status).toBe(200);           // idempotent while open
    expect((await post(a, `orders/${second}/confirm`)).body.error.code).toBe('DUPLICATE_PHONE');   // pending is not approval

    // the agent cannot approve their own request, a manager can; it appears in the ordinary approvals list
    const list = await request(app).get('/api/v1/approvals?status=pending').set(auth(mgr));
    const item = list.body.items.find((i) => i.type === 'duplicate_order' && i.id === `duplicate_order:${asked.body.approval.id}`);
    expect(item).toBeTruthy();
    expect(item.title).toMatch(/another active order/);
    expect(item.requestedBy).toMatch(/cashier/);
    expect((await request(app).get('/api/v1/approvals?status=pending').set(auth(a))).status).toBe(403);

    const decided = await request(app).post(`/api/v1/approvals/${item.id}/approve`).set(auth(mgr)).send({});
    expect(decided.status).toBe(200);
    expect(decided.body.applied).toBe(true);
    expect((await get(a, second)).body.duplicateApproval.status).toBe('approved');

    const ok = await post(a, `orders/${second}/confirm`);
    expect(ok.status).toBe(200);
    expect(ok.body.confirmed).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'approval_decided'`).get(a.id).n).toBeGreaterThan(0);
  });

  it('a rejected request stays refused, and the manager must give a reason', async () => {
    const a = await H.makeUser('cashier', 'dup-rej-agent');
    const mgr = await H.makeUser('manager', 'dup-rej-mgr');
    const second = makeDuplicateOf(makeOrder(a), a);
    const asked = await post(a, `orders/${second}/duplicate-approval`);
    const id = `duplicate_order:${asked.body.approval.id}`;
    expect((await request(app).post(`/api/v1/approvals/${id}/reject`).set(auth(mgr)).send({})).status).toBe(400);
    const rej = await request(app).post(`/api/v1/approvals/${id}/reject`).set(auth(mgr)).send({ reason: 'Looks like the same parcel' });
    expect(rej.body.applied).toBe(true);
    expect((await post(a, `orders/${second}/confirm`)).body.error.code).toBe('DUPLICATE_PHONE');
    expect((await get(a, second)).body.duplicateApproval).toMatchObject({ status: 'rejected', reviewNote: 'Looks like the same parcel' });
  });

  it('two managers deciding at once: the second sees the first decision, not an error', async () => {
    const a = await H.makeUser('cashier', 'dup-race-agent');
    const m1 = await H.makeUser('manager', 'dup-race-1');
    const m2 = await H.makeUser('manager', 'dup-race-2');
    const second = makeDuplicateOf(makeOrder(a), a);
    const id = `duplicate_order:${(await post(a, `orders/${second}/duplicate-approval`)).body.approval.id}`;
    expect((await request(app).post(`/api/v1/approvals/${id}/approve`).set(auth(m1)).send({})).body.applied).toBe(true);
    const late = await request(app).post(`/api/v1/approvals/${id}/approve`).set(auth(m2)).send({});
    expect(late.status).toBe(200);
    expect(late.body.applied).toBe(false);
  });

  it('a request for an order with no duplicate is refused, and cancelling an order closes its open request', async () => {
    const a = await H.makeUser('cashier', 'dup-none');
    const lone = makeOrder(a);
    expect((await post(a, `orders/${lone}/duplicate-approval`)).body.error.code).toBe('NO_DUPLICATE');
    const second = makeDuplicateOf(makeOrder(a), a);
    await post(a, `orders/${second}/duplicate-approval`);
    await post(a, `orders/${second}/cancel`, { reason: 'Customer says duplicate' });
    expect(db.prepare('SELECT status FROM duplicate_order_approvals WHERE order_id = ?').get(second).status).toBe('cancelled');
  });

  it('a manager who holds the permission may confirm a duplicate directly', async () => {
    const mgr = await H.makeUser('manager', 'dup-direct');
    H.grant(mgr.id, 'telesales.work');
    const second = makeDuplicateOf(makeOrder(mgr), mgr);
    // admin/manager override: they hold orders.approve_duplicate
    expect((await post(mgr, `orders/${second}/confirm`)).status).toBe(200);
  });
});
