const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');
const leadsService = require('../src/services/leads.service');

beforeAll(async () => { await H.loginAsAdmin(); });
afterAll(() => cleanupTestDb());

let n = 0;
const phone = () => { n += 1; return `0711${String(100000 + n * 7 + Math.floor(Math.random() * 1000)).slice(0, 6)}`; };
function makeLead(agent, over = {}) {
  const l = leadsService.create({ storeId: H.storeId(), staffId: agent.id, name: over.name || `Lead ${++n}`, phone: over.phone || phone(), source: 'whatsapp', assignedStaffId: agent.id });
  if (over.productId) db.prepare('UPDATE leads SET interested_product_id = ? WHERE id = ?').run(over.productId, l.id);
  return l.id;
}
const get = (u, id) => request(app).get(`/api/v1/leads/${id}`).set(auth(u));
const patch = (u, id, body) => request(app).patch(`/api/v1/leads/${id}`).set(auth(u)).send(body);
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

describe('leads', () => {
  it('an agent sees only their own leads; someone else\'s lead is a 404 on every action', async () => {
    const a = await H.makeUser('cashier', 'lead-a');
    const b = await H.makeUser('cashier', 'lead-b');
    const mine = makeLead(a);
    const theirs = makeLead(b);
    const list = await request(app).get('/api/v1/leads').set(auth(a));
    expect(list.status).toBe(200);
    expect(list.body.items.map((l) => l.id)).toContain(mine);
    expect(list.body.items.map((l) => l.id)).not.toContain(theirs);
    expect(list.body.items[0]).toMatchObject({ status: 'new', source: 'whatsapp' });
    expect((await get(a, theirs)).status).toBe(404);
    expect((await patch(a, theirs, { notes: 'hi' })).status).toBe(404);
    expect((await request(app).post(`/api/v1/leads/${theirs}/activities`).set(auth(a)).send({ type: 'note', content: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/v1/leads/${theirs}/convert`).set(auth(a)).send({})).status).toBe(404);
    // a manager sees them all
    const mgr = await H.makeUser('manager', 'lead-mgr');
    expect((await get(mgr, theirs)).status).toBe(200);
  });

  it('filters by status and searches by name or phone, with paging', async () => {
    const a = await H.makeUser('cashier', 'lead-filter');
    const ids = [makeLead(a, { name: 'Wanjiku Search' }), makeLead(a), makeLead(a)];
    await patch(a, ids[1], { status: 'contacted' });
    const contacted = await request(app).get('/api/v1/leads?status=contacted').set(auth(a));
    expect(contacted.body.items.map((l) => l.id)).toEqual([ids[1]]);
    expect((await request(app).get('/api/v1/leads?q=Wanjiku').set(auth(a))).body.items.map((l) => l.id)).toEqual([ids[0]]);
    const p1 = await request(app).get('/api/v1/leads?limit=2').set(auth(a));
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.total).toBe(3);
    const p2 = await request(app).get(`/api/v1/leads?limit=2&cursor=${p1.body.nextCursor}`).set(auth(a));
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
  });

  it('follows the website\'s status rules: reschedule needs a date, converted cannot be set by hand', async () => {
    const a = await H.makeUser('cashier', 'lead-status');
    const id = makeLead(a);
    expect((await patch(a, id, {})).status).toBe(400);
    expect((await patch(a, id, { status: 'rescheduled', followUpDate: tomorrow() })).status).toBe(409);  // a new lead must be contacted first
    expect((await patch(a, id, { status: 'contacted' })).status).toBe(200);
    expect((await patch(a, id, { status: 'rescheduled' })).status).toBe(400);                         // follow-up date required
    expect((await patch(a, id, { status: 'rescheduled', followUpDate: 'next week' })).status).toBe(400); // not a date
    const ok = await patch(a, id, { status: 'rescheduled', followUpDate: tomorrow() });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'rescheduled', followUpDate: tomorrow() });
    expect(ok.body.activities.some((x) => x.type === 'status_change')).toBe(true);
    expect((await patch(a, id, { status: 'converted' })).body.error.code).toBe('USE_CONVERT');
    expect((await patch(a, id, { status: 'cancelled' })).body.status).toBe('cancelled');
    expect((await patch(a, id, { status: 'contacted' })).status).toBe(409);                           // cancelled is final
    expect(H.lastLog('lead', id)).toBeTruthy();
  });

  it('notes and call outcomes are recorded by the agent and show on the lead', async () => {
    const a = await H.makeUser('cashier', 'lead-notes');
    const id = makeLead(a);
    const n1 = await patch(a, id, { notes: 'Wants the black pair' });
    expect(n1.body.notes).toBe('Wants the black pair');
    const call = await request(app).post(`/api/v1/leads/${id}/activities`).set(auth(a)).send({ type: 'call', content: 'No answer, try after 5pm' });
    expect(call.status).toBe(201);
    expect(call.body.activities[0]).toMatchObject({ type: 'call', content: 'No answer, try after 5pm' });
    expect((await request(app).post(`/api/v1/leads/${id}/activities`).set(auth(a)).send({ type: 'call', content: '' })).status).toBe(400);
    expect((await request(app).post(`/api/v1/leads/${id}/activities`).set(auth(a)).send({ type: 'status_change', content: 'sneaky' })).status).toBe(400);
  });

  it('converts to an order in one go; twice, or onto a busy phone number, is refused with what to do', async () => {
    const a = await H.makeUser('cashier', 'lead-convert');
    const product = H.makeProduct({ sell: 90000 });
    db.prepare('UPDATE inventory SET quantity = 10 WHERE product_id = ? AND store_id = ?').run(product.id, H.storeId());
    const id = makeLead(a, { productId: product.id });
    const res = await request(app).post(`/api/v1/leads/${id}/convert`).set(auth(a)).send({ city: 'Nairobi' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ merged: false });
    expect(res.body.lead).toMatchObject({ status: 'converted', convertedOrderId: res.body.orderId });
    expect(res.body.orderNumber).toBeTruthy();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.orderId);
    expect(order.status).toBe('awaiting_dispatch');
    expect(db.prepare('SELECT quantity, unit_price FROM order_items WHERE order_id = ?').get(order.id)).toMatchObject({ quantity: 1, unit_price: 90000 });

    const again = await request(app).post(`/api/v1/leads/${id}/convert`).set(auth(a)).send({});
    expect(again.status).toBe(409);

    // a second lead on the same phone: the active order is reported so the app can offer to merge
    const lead = db.prepare('SELECT phone FROM leads WHERE id = ?').get(id);
    // the website refuses two leads on one number, so give the twin another number and then point it at the busy one
    const twin = leadsService.create({ storeId: H.storeId(), staffId: a.id, name: 'Twin', phone: phone(), source: 'other', assignedStaffId: a.id, allowPossibleDuplicate: true });
    db.prepare('UPDATE leads SET phone = ?, phone_normalized = (SELECT phone_normalized FROM leads WHERE id = ?) WHERE id = ?').run(lead.phone, id, twin.id);
    const clash = await request(app).post(`/api/v1/leads/${twin.id}/convert`).set(auth(a)).send({ items: [{ productId: product.id, quantity: 2 }] });
    expect(clash.status).toBe(409);
    expect(clash.body.details).toMatchObject({ existingOrderId: order.id });
    const merged = await request(app).post(`/api/v1/leads/${twin.id}/convert`).set(auth(a)).send({ items: [{ productId: product.id, quantity: 2 }], mergeIntoOrderId: order.id });
    expect(merged.status).toBe(200);
    expect(merged.body.merged).toBe(true);
  });

  it('needs leads.work', async () => {
    const store = await H.makeUser('store', 'lead-store');
    expect((await request(app).get('/api/v1/leads').set(auth(store))).status).toBe(403);
  });
});
