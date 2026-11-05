const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');
const orgs = require('../src/services/courierOrganizations.service');
const { localDate } = require('../src/utils/storeTime');

let webToken; let adminRow; let manager; let cashier; let seq = 0;
beforeAll(async () => {
  webToken = await H.loginAsAdmin();
  adminRow = db.prepare(`SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'`).get();
  manager = await H.makeUser('manager', 'cour-mgr');
  cashier = await H.makeUser('cashier', 'cour-cashier');
});
afterAll(() => cleanupTestDb());

const web = (r) => r.set('Authorization', `Bearer ${webToken}`);
async function newOrg(extra = {}) {
  const res = await web(request(app).post('/api/couriers')).send({ name: `Org ${Date.now()}${Math.random()}`, kind: 'organization', collects_payment: true, ...extra });
  expect(res.status).toBe(201);
  return res.body.data;
}
// An order dispatched through the organization, whose collection the organization has then recorded.
async function collected(courier, { price = 200000, fee = 20000, daysAgo = 3 } = {}) {
  seq += 1;
  const p = H.makeProduct({ sell: price });
  db.prepare('UPDATE inventory SET quantity = 100 WHERE product_id = ? AND store_id = ?').run(p.id, H.storeId());
  const o = await web(request(app).post('/api/orders')).send({ name: `Cour Cust ${seq}`, phone: `0788${String(seq).padStart(6, '0')}`, city: 'Nairobi', items: [{ product_id: p.id, quantity: 1 }] });
  expect(o.status).toBe(201);
  const id = o.body.data.id;
  expect((await web(request(app).post(`/api/orders/${id}/courier`)).send({ courier_id: courier.id })).status).toBe(200);
  expect((await web(request(app).post(`/api/orders/${id}/confirm-cod`))).status).toBe(200);
  expect((await web(request(app).post(`/api/orders/${id}/dispatch`)).send({ delivery_fee_paid: false, package_fee: fee })).status).toBe(200);
  const col = orgs.recordCollection({ storeId: adminRow.store_id, staffId: adminRow.id, courierId: courier.id, orderId: id, amount: o.body.data.total, collectedOn: localDate(daysAgo) });
  return { orderId: id, total: o.body.data.total, collectionId: col.id, fee };
}
const remit = (u, courierId, body) => request(app).post(`/api/v1/couriers/${courierId}/remittances`).set(auth(u)).send(body);

describe('permission', () => {
  it('needs couriers.settle: a cashier is refused everywhere, a manager is not', async () => {
    const org = await newOrg();
    for (const [m, path, body] of [['get', '/couriers/balances'], ['get', `/couriers/${org.id}/collections`], ['get', `/couriers/${org.id}/remittances`], ['post', `/couriers/${org.id}/remittances`, { collectionIds: [1], remittedCents: 1 }]]) {
      const r = await request(app)[m](`/api/v1${path}`).set(auth(cashier)).send(body);
      expect(r.status).toBe(403);
    }
    expect((await request(app).get('/api/v1/couriers/balances').set(auth(manager))).status).toBe(200);
    expect((await request(app).get('/api/v1/couriers/balances')).status).toBe(401);
  });
});

describe('balances', () => {
  it('shows what an organization owes (collected minus remitted minus fees), biggest first, only organizations that collect', async () => {
    const small = await newOrg(); const big = await newOrg();
    const rider = (await web(request(app).post('/api/couriers')).send({ name: `Rider ${Date.now()}`, kind: 'rider', courier_type: 'boda' })).body.data;
    const noCollect = await newOrg({ collects_payment: false });
    await collected(small, { price: 100000 });
    const b1 = await collected(big, { price: 300000 }); const b2 = await collected(big, { price: 200000, daysAgo: 20 });
    const r = await request(app).get('/api/v1/couriers/balances').set(auth(manager));
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i) => i.courierId);
    expect(ids).not.toContain(rider.id); expect(ids).not.toContain(noCollect.id);
    expect(ids.indexOf(big.id)).toBeLessThan(ids.indexOf(small.id));
    const row = r.body.items.find((i) => i.courierId === big.id);
    const st = orgs.organizationStanding({ storeId: adminRow.store_id, courierId: big.id });
    expect(row).toMatchObject({ outstandingCents: st.outstanding, overdueCents: st.overdue, openCollections: 2, paused: false });
    expect(row.outstandingCents).toBe(b1.total + b2.total);      // nothing remitted or netted yet, so it is everything collected
    expect(row.buckets.map((b) => b.label)).toEqual(['0-7', '8-14', '15-30', '30+']);
    expect(row.oldestCollectionOn).toBe(localDate(20));
  });
});

describe('open collections and remittance', () => {
  it('lists open collections, then a remittance settles them once and updates the balance', async () => {
    const org = await newOrg();
    const a = await collected(org, { price: 200000, fee: 20000 }); const b = await collected(org, { price: 100000, fee: 10000 });
    const open = await request(app).get(`/api/v1/couriers/${org.id}/collections`).set(auth(manager));
    expect(open.body.items.map((i) => i.collectionId)).toEqual([a.collectionId, b.collectionId]);
    expect(open.body.items[0]).toMatchObject({ orderId: a.orderId, amountCents: a.total, customerName: expect.stringContaining('Cour Cust') });

    const expected = a.total + b.total - a.fee - b.fee;
    const r = await remit(manager, org.id, { collectionIds: [a.collectionId, b.collectionId], remittedCents: expected, reference: 'MPESA-ABC', note: 'Handed over at the shop' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ remittedCents: expected, expectedCents: expected, cashVarianceCents: 0, settledCount: 2 });
    const stmt = db.prepare('SELECT * FROM org_statements WHERE id = ?').get(r.body.id);
    expect(stmt).toMatchObject({ courier_id: org.id, remitted: expected, fees: a.fee + b.fee, remittance_ref: 'MPESA-ABC', created_by: manager.id, charge_variance: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM org_statements WHERE courier_id = ?').get(org.id).c).toBe(1);

    expect(orgs.organizationStanding({ storeId: adminRow.store_id, courierId: org.id }).outstanding).toBe(0);
    expect((await request(app).get(`/api/v1/couriers/${org.id}/collections`).set(auth(manager))).body.items).toEqual([]);
    const hist = await request(app).get(`/api/v1/couriers/${org.id}/remittances`).set(auth(manager));
    expect(hist.body.items[0]).toMatchObject({ id: r.body.id, remittedCents: expected, feesCents: a.fee + b.fee, reference: 'MPESA-ABC', createdBy: { id: manager.id } });
    const log = H.lastLog('org_statement_note', r.body.id);
    expect(log.staff_id).toBe(manager.id); expect(log.changes.reason.to).toBe('Handed over at the shop'); expect(log.changes.deviceId.to).toBe(manager.sessionId);
  });

  it('settling the same parcel twice is refused and changes nothing; a short payment shows as a variance', async () => {
    const org = await newOrg();
    const a = await collected(org, { price: 200000, fee: 20000 });
    const short = await remit(manager, org.id, { collectionIds: [a.collectionId], remittedCents: a.total - a.fee - 5000 });
    expect(short.status).toBe(201);
    expect(short.body.cashVarianceCents).toBe(5000);
    const again = await remit(manager, org.id, { collectionIds: [a.collectionId], remittedCents: 1000 });
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('ALREADY_SETTLED');
    expect(db.prepare('SELECT COUNT(*) c FROM org_statements WHERE courier_id = ?').get(org.id).c).toBe(1);
  });

  it('refuses amounts that do not add up, parcels of another courier, and unknown ones', async () => {
    const org = await newOrg(); const other = await newOrg();
    const a = await collected(org, { price: 100000, fee: 10000 });
    const o = await collected(other, { price: 100000 });
    const over = await remit(manager, org.id, { collectionIds: [a.collectionId], remittedCents: a.total + 1 });
    expect(over.status).toBe(422); expect(over.body.error.code).toBe('STATEMENT_EXCEEDS_COLLECTIONS');
    expect((await remit(manager, org.id, { collectionIds: [o.collectionId], remittedCents: 1000 })).body.error.code).toBe('STATEMENT_WRONG_ORGANIZATION');
    expect((await remit(manager, org.id, { collectionIds: [99999999], remittedCents: 1000 })).status).toBe(404);
    expect((await remit(manager, org.id, { collectionIds: [], remittedCents: 1000 })).status).toBe(400);
    expect((await remit(manager, org.id, { collectionIds: [a.collectionId], remittedCents: -5 })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM org_statements WHERE courier_id = ?').get(org.id).c).toBe(0);
    expect((await request(app).get('/api/v1/couriers/999999/collections').set(auth(manager))).status).toBe(404);
  });

  it('a remittance is immutable', async () => {
    const org = await newOrg(); const a = await collected(org, { price: 100000, fee: 10000 });
    const r = await remit(manager, org.id, { collectionIds: [a.collectionId], remittedCents: a.total - a.fee });
    expect(() => db.prepare('UPDATE org_statements SET remitted = 1 WHERE id = ?').run(r.body.id)).toThrow();
    expect(() => db.prepare('DELETE FROM org_statements WHERE id = ?').run(r.body.id)).toThrow();
  });
});
