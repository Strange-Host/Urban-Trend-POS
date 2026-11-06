const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');
const ordersService = require('../src/services/orders.service');

beforeAll(async () => { await H.loginAsAdmin(); });
afterAll(() => cleanupTestDb());

let n = 0;
// A parcel that already left the shop: dispatched, one unit sold, shelf stock at 4 afterwards.
function makeDispatched(agent, { status = 'dispatched_unpaid', qty = 2 } = {}) {
  n += 1;
  const product = H.makeProduct({ sell: 120000 });
  db.prepare('UPDATE inventory SET quantity = 4 WHERE product_id = ? AND store_id = ?').run(product.id, H.storeId());
  const o = ordersService.create({ storeId: H.storeId(), staffId: agent.id, name: `Returner ${n}`, phone: `0722${String(200000 + n * 13).slice(0, 6)}`, city: 'Nairobi', assignedStaffId: agent.id, channel: 'manual', items: [{ product_id: product.id, quantity: qty }], paymentType: 'cod' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, o.id);
  return { id: o.id, productId: product.id, qty };
}
const stock = (productId) => db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, H.storeId()).quantity;
const receive = (u, body) => request(app).post('/api/v1/returns').set(auth(u)).send(body);
const decide = (u, id, body) => request(app).post(`/api/v1/returns/${id}/decision`).set(auth(u)).send(body);

describe('receiving a return', () => {
  it('records reason and condition, moves the order to awaiting inspection, and touches no stock yet', async () => {
    const staff = await H.makeUser('cashier', 'ret-recv');
    const o = makeDispatched(staff);
    const res = await receive(staff, { orderId: o.id, reasonCode: 'rejected', condition: 'good', note: 'Customer refused at the door' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: o.id, status: 'returned_awaiting_inspection', reasonCode: 'rejected', condition: 'good', decision: null, itemCount: 2 });
    expect(res.body.receivedBy).toMatch(/cashier/);
    const row = db.prepare('SELECT return_reason, return_received_by, return_received_condition FROM orders WHERE id = ?').get(o.id);
    expect(row).toMatchObject({ return_reason: 'rejected', return_received_by: staff.id, return_received_condition: 'good' });
    expect(stock(o.productId)).toBe(4);
    expect(H.lastLog('order_return', o.id).changes.reasonCode.to).toBe('rejected');
    // twice is refused: it is no longer a parcel in transit
    expect((await receive(staff, { orderId: o.id, reasonCode: 'rejected', condition: 'good' })).body.error.code).toBe('NOT_RETURNABLE');
  });

  it('also finishes a return the website already started (returned in transit)', async () => {
    const staff = await H.makeUser('cashier', 'ret-transit');
    const o = makeDispatched(staff);
    ordersService.markReturnedInTransit({ orderId: o.id, storeId: H.storeId(), staffId: staff.id, reasonCode: 'wrong_item' });
    const res = await receive(staff, { orderId: o.id, reasonCode: 'wrong_item', condition: 'damaged' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('returned_awaiting_inspection');
  });

  it('refuses an order that was never dispatched, an unknown one, and a bad reason code', async () => {
    const staff = await H.makeUser('cashier', 'ret-bad');
    const fresh = makeDispatched(staff, { status: 'awaiting_dispatch' });
    expect((await receive(staff, { orderId: fresh.id, reasonCode: 'rejected', condition: 'good' })).body.error.code).toBe('NOT_RETURNABLE');
    expect((await receive(staff, { orderId: 99999999, reasonCode: 'rejected', condition: 'good' })).status).toBe(404);
    expect((await receive(staff, { orderId: fresh.id, reasonCode: 'changed_mind', condition: 'good' })).status).toBe(400);
    expect((await receive(staff, { orderId: fresh.id, reasonCode: 'rejected', condition: 'sticky' })).status).toBe(400);
  });

  it('finds a dispatched order by number, name or phone, and lists returns awaiting a decision', async () => {
    const staff = await H.makeUser('cashier', 'ret-find');
    const o = makeDispatched(staff);
    const name = db.prepare('SELECT c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(o.id).name;
    const found = await request(app).get(`/api/v1/returns/orders?q=${encodeURIComponent(name)}`).set(auth(staff));
    expect(found.body.items.map((x) => x.id)).toEqual([o.id]);
    expect((await request(app).get('/api/v1/returns/orders?q=a').set(auth(staff))).body.items).toEqual([]);   // too short to search
    await receive(staff, { orderId: o.id, reasonCode: 'damaged', condition: 'damaged' });
    expect((await request(app).get(`/api/v1/returns/orders?q=${encodeURIComponent(name)}`).set(auth(staff))).body.items).toEqual([]);   // no longer receivable
    const waiting = await request(app).get('/api/v1/returns').set(auth(staff));
    expect(waiting.body.items.map((x) => x.id)).toContain(o.id);
    expect((await request(app).get('/api/v1/returns?status=decided').set(auth(staff))).body.items.map((x) => x.id)).not.toContain(o.id);
  });

  it('needs returns.receive', async () => {
    const store = await H.makeUser('store', 'ret-store');
    expect((await request(app).get('/api/v1/returns').set(auth(store))).status).toBe(403);
  });
});

describe('the owner\'s decision', () => {
  it('restock puts the units back on sale once, and needs orders.inspect', async () => {
    const staff = await H.makeUser('cashier', 'dec-staff');
    const mgr = await H.makeUser('manager', 'dec-mgr');
    const o = makeDispatched(staff);
    await receive(staff, { orderId: o.id, reasonCode: 'rejected', condition: 'good' });
    expect((await decide(staff, o.id, { decision: 'restock' })).status).toBe(403);   // cashiers cannot decide
    expect(stock(o.productId)).toBe(4);

    const res = await decide(mgr, o.id, { decision: 'restock', note: 'Boxed and unused' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'returned_resellable', decision: 'restock' });
    expect(stock(o.productId)).toBe(6);                                              // 4 + the 2 that came back
    expect(db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE reference_id = ? AND reason = 'return_resellable'`).get(o.id).n).toBe(1);
    expect((await decide(mgr, o.id, { decision: 'restock' })).body.error.code).toBe('ALREADY_DECIDED');
    expect(stock(o.productId)).toBe(6);                                              // never twice
    expect((await request(app).get('/api/v1/returns?status=decided').set(auth(mgr))).body.items.find((x) => x.id === o.id).decision).toBe('restock');
  });

  it('write-off and disposal are the owner\'s: stock stays out, a manager is refused', async () => {
    const staff = await H.makeUser('cashier', 'wo-staff');
    const mgr = await H.makeUser('manager', 'wo-mgr');
    const owner = await H.makeAdmin();
    const o = makeDispatched(staff);
    await receive(staff, { orderId: o.id, reasonCode: 'damaged', condition: 'damaged' });
    expect((await decide(mgr, o.id, { decision: 'write_off' })).status).toBe(403);
    expect((await decide(mgr, o.id, { decision: 'dispose' })).status).toBe(403);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status).toBe('returned_awaiting_inspection');

    const res = await decide(owner, o.id, { decision: 'write_off', note: 'Water damage' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'returned_damaged', decision: 'write_off', note: 'Water damage' });
    expect(stock(o.productId)).toBe(4);
    expect(db.prepare('SELECT owner_decision, owner_decision_by FROM orders WHERE id = ?').get(o.id)).toMatchObject({ owner_decision: 'write_off', owner_decision_by: owner.id });
    expect((await decide(owner, o.id, { decision: 'dispose' })).body.error.code).toBe('ALREADY_DECIDED');
  });

  it('a parcel the website already inspected as damaged can only be written off or disposed, never restocked', async () => {
    const staff = await H.makeUser('cashier', 'web-staff');
    const owner = await H.makeAdmin();
    const o = makeDispatched(staff);
    ordersService.markReturnedInTransit({ orderId: o.id, storeId: H.storeId(), staffId: staff.id, reasonCode: 'damaged' });
    ordersService.markReturnedAwaitingInspection({ orderId: o.id, storeId: H.storeId(), staffId: staff.id });
    ordersService.inspectReturn({ orderId: o.id, storeId: H.storeId(), staffId: staff.id, result: 'damaged' });
    expect((await decide(owner, o.id, { decision: 'restock' })).body.error.code).toBe('NOT_RESTOCKABLE');
    expect((await decide(owner, o.id, { decision: 'dispose' })).status).toBe(200);
    expect(db.prepare('SELECT owner_decision FROM orders WHERE id = ?').get(o.id).owner_decision).toBe('dispose');
  });

  it('an order that has not been received cannot be decided', async () => {
    const staff = await H.makeUser('cashier', 'dec-early');
    const owner = await H.makeAdmin();
    const o = makeDispatched(staff);
    expect((await decide(owner, o.id, { decision: 'restock' })).body.error.code).toBe('NOT_RECEIVED');
    expect((await decide(owner, o.id, { decision: 'maybe' })).status).toBe(400);
    expect((await decide(owner, 99999999, { decision: 'restock' })).status).toBe(404);
  });
});
