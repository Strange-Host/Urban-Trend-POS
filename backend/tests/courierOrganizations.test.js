const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const orgs = require('../src/services/courierOrganizations.service');
const { localDate } = require('../src/utils/storeTime');

// Ported from the update branch's server/tests/organizations.test.ts. No ledger here, so "the books
// balance" is checked as: outstanding = collected - remitted - fees netted, read from the tables.

let token; let product; let storeId; let staffId; let phoneSeq = 0;
const auth = (r) => r.set('Authorization', `Bearer ${token}`);
const ago = (days) => localDate(days);
const today = () => localDate(0);

beforeAll(async () => {
  token = await loginAsAdmin();
  const me = db.prepare(`SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'`).get();
  staffId = me.id; storeId = me.store_id;
  product = (await auth(request(app).get('/api/products?pageSize=25'))).body.data.find((p) => p.sell_price < 500000);
});
afterAll(() => cleanupTestDb());

async function newCourier(body) {
  const res = await auth(request(app).post('/api/couriers')).send({ name: `C${Date.now()}${Math.random()}`, ...body });
  expect(res.status).toBe(201);
  return res.body.data;
}
const newOrg = (extra = {}) => newCourier({ kind: 'organization', collects_payment: true, ...extra });
const newRider = () => newCourier({ kind: 'rider', courier_type: 'boda' });

// An order assigned to `courierId`, confirmed and dispatched. `fee` is the package fee we owe the organization.
async function dispatched(courierId, opts = {}) {
  const fee = 'fee' in opts ? opts.fee : 20_000;          // pass fee: undefined to send none
  const { zeroReason } = opts;
  const phone = `07550${String(++phoneSeq).padStart(5, '0')}`;
  const created = await auth(request(app).post('/api/orders')).send({ name: `Org Cust ${phoneSeq}`, phone, city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  expect((await auth(request(app).post(`/api/orders/${id}/courier`)).send({ courier_id: courierId })).status).toBe(200);
  expect((await auth(request(app).post(`/api/orders/${id}/confirm-cod`))).status).toBe(200);
  const body = {};
  if (fee !== undefined) body.package_fee = fee;
  if (zeroReason) body.package_fee_zero_reason = zeroReason;
  const res = await auth(request(app).post(`/api/orders/${id}/dispatch`)).send(body);
  return { res, id, total: created.body.data.total };
}
const order = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const base = (courierId, o, extra = {}) => ({ storeId, staffId, courierId, orderId: o.id, amount: o.total, ...extra });
const collect = (courierId, o, extra = {}) => orgs.recordCollection(base(courierId, o, extra));
const code = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };

describe('dispatching with an organization records the package fee we owe it', () => {
  it('writes one package_fees row, and a rider is unaffected', async () => {
    const org = await newOrg();
    const o = await dispatched(org.id, { fee: 20_000 });
    expect(o.res.status).toBe(200);
    expect(db.prepare('SELECT courier_id, amount FROM package_fees WHERE order_id = ?').get(o.id)).toEqual({ courier_id: org.id, amount: 20_000 });

    const rider = await newRider();
    const r = await dispatched(rider.id, { fee: undefined });
    expect(r.res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM package_fees WHERE order_id = ?').get(r.id).n).toBe(0);
  });

  it('refuses to dispatch without a fee; a zero fee needs a reason; nothing is left half-done', async () => {
    const org = await newOrg();
    const missing = await dispatched(org.id, { fee: undefined });
    expect(missing.res.status).toBe(422);
    expect(missing.res.body.error.code).toBe('PACKAGE_FEE_REQUIRED');
    expect(order(missing.id).status).toBe('awaiting_dispatch');            // rolled back, stock untouched

    const noReason = await dispatched(org.id, { fee: 0 });
    expect(noReason.res.body.error.code).toBe('PACKAGE_FEE_ZERO_NEEDS_REASON');
    const withReason = await dispatched(org.id, { fee: 0, zeroReason: 'Promotional free delivery' });
    expect(withReason.res.status).toBe(200);
    const negative = await dispatched(org.id, { fee: -5 });
    expect(negative.res.body.error.code).toBe('PACKAGE_FEE_BAD_AMOUNT');
  });
});

describe('an organization collects the customer\'s payment', () => {
  it('the order counts as paid, but the money is the organization\'s, not the shop\'s', async () => {
    const org = await newOrg();
    const o = await dispatched(org.id);
    const paymentsBefore = db.prepare('SELECT COUNT(*) AS n FROM payment_records WHERE order_id = ?').get(o.id).n;
    const c = await collect(org.id, o);
    expect(c).toMatchObject({ courier_id: org.id, order_id: o.id, amount: o.total, collected_on: today() });
    expect(order(o.id)).toMatchObject({ amount_paid: o.total, status: 'dispatched_paid' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payment_records WHERE order_id = ?').get(o.id).n).toBe(paymentsBefore); // not shop cash
    expect(orgs.organizationStanding({ storeId, courierId: org.id }).outstanding).toBe(o.total);
  });

  it('allows a part collection, then the rest, but never more than is owed', async () => {
    const org = await newOrg();
    const o = await dispatched(org.id);
    const part = Math.floor(o.total * 0.6);
    await collect(org.id, o, { amount: part });
    expect(order(o.id).status).toBe('dispatched_partial');
    expect(await code(() => collect(org.id, o, { amount: o.total - part + 1 }))).toBe('COLLECTION_EXCEEDS_BALANCE');
    await collect(org.id, o, { amount: o.total - part });
    expect(order(o.id).status).toBe('dispatched_paid');
  });

  it('only an organization that collects can collect; riders never handle customer money', async () => {
    const rider = await newRider();
    const nonCollecting = await newOrg({ collects_payment: false });
    const a = await dispatched(rider.id, { fee: undefined });
    const b = await dispatched(nonCollecting.id);
    expect(await code(() => collect(rider.id, a, { amount: 1 }))).toBe('COLLECTION_NOT_A_COLLECTOR');
    expect(await code(() => collect(nonCollecting.id, b, { amount: 1 }))).toBe('COLLECTION_NOT_A_COLLECTOR');
  });

  it('must be the organization the order went out with, and the order must be out for delivery', async () => {
    const org = await newOrg();
    const other = await newOrg();
    const o = await dispatched(org.id);
    expect(await code(() => collect(other.id, o, { amount: 1 }))).toBe('COLLECTION_WRONG_COURIER');
    const notYet = (await auth(request(app).post('/api/orders')).send({ name: 'Not Yet', phone: '0755999001', city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] })).body.data;
    expect(await code(() => collect(org.id, notYet, { amount: 1 }))).toBe('COLLECTION_WRONG_STATE');
    expect(await code(() => collect(org.id, { id: 999_999, total: 1 }, { amount: 1 }))).toBe('ORDER_NOT_FOUND');
    expect(await code(() => collect(999_999, o, { amount: 1 }))).toBe('COURIER_NOT_FOUND');
  });

  it('validates the amount, the date and who recorded it; records cannot be edited or deleted', async () => {
    const org = await newOrg();
    const o = await dispatched(org.id);
    expect(await code(() => collect(org.id, o, { amount: 0 }))).toBe('COLLECTION_BAD_AMOUNT');
    expect(await code(() => collect(org.id, o, { amount: 1.5 }))).toBe('COLLECTION_BAD_AMOUNT');
    expect(await code(() => collect(org.id, o, { amount: 1000, collectedOn: '1/2/2026' }))).toBe('COLLECTION_BAD_DATE');
    expect(await code(() => collect(org.id, o, { amount: 1000, staffId: null }))).toBe('COLLECTION_NO_ACTOR');
    await collect(org.id, o, { amount: 1000 });
    expect(() => db.prepare('UPDATE org_collections SET amount = 1').run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM org_collections').run()).toThrow(/immutable/);
  });
});

describe('statements: the organization remits, and the fees we owe it are netted off', () => {
  async function threeParcels(org) {
    const orders = [await dispatched(org.id, { fee: 20_000 }), await dispatched(org.id, { fee: 20_000 }), await dispatched(org.id, { fee: 20_000 })];
    const cols = [];
    for (const o of orders) cols.push(await collect(org.id, o, { collectedOn: today() }));
    return { orders, cols, collected: cols.reduce((s, c) => s + c.amount, 0) };
  }
  const statement = (org, cols, extra = {}) => orgs.createStatement({
    storeId, staffId, courierId: org.id, periodStart: ago(7), periodEnd: today(), collectionIds: cols.map((c) => c.id), chargeEntered: 60_000, remitted: 0, ...extra,
  });

  it('closes correctly: collected - fees = remitted leaves nothing owing either way', async () => {
    const org = await newOrg();
    const { cols, collected } = await threeParcels(org);
    expect(orgs.organizationStanding({ storeId, courierId: org.id }).outstanding).toBe(collected);

    const st = statement(org, cols, { chargeEntered: 60_000, remitted: collected - 60_000, remittanceRef: 'EFT-5521' });
    expect(st).toMatchObject({ collections: collected, charge_entered: 60_000, fees: 60_000, remitted: collected - 60_000, charge_variance: 0, cash_variance: 0 });
    expect(orgs.organizationStanding({ storeId, courierId: org.id }).outstanding).toBe(0);
    expect(db.prepare('SELECT method, total FROM courier_payouts WHERE courier_id = ?').get(org.id)).toEqual({ method: 'netted_on_remittance', total: 60_000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payout_items WHERE payout_id = ?').get(st.payout_id).n).toBe(3);
    expect(orgs.listOpenCollections({ storeId, courierId: org.id })).toEqual([]);
    expect(() => db.prepare('UPDATE org_statements SET remitted = 1').run()).toThrow(/immutable/);
  });

  it('a short remittance is not hidden: the shortfall stays owing and shows as variance', async () => {
    const org = await newOrg();
    const { cols, collected } = await threeParcels(org);
    const st = statement(org, cols, { remitted: collected - 60_000 - 70_000 });
    expect(st.cash_variance).toBe(70_000);
    expect(orgs.organizationStanding({ storeId, courierId: org.id }).outstanding).toBe(70_000);
  });

  it('an organization charging more than our own fee records shows as charge variance, and we net OUR figure', async () => {
    const org = await newOrg();
    const { cols, collected } = await threeParcels(org);
    const st = statement(org, cols, { chargeEntered: 75_000, remitted: collected - 60_000 });
    expect(st).toMatchObject({ fees: 60_000, charge_entered: 75_000, charge_variance: 15_000, cash_variance: 0 });
  });

  it('secures parcels oldest first: a parcel is fully secure only when covered in full', async () => {
    const org = await newOrg();
    const { cols, collected } = await threeParcels(org);
    const st = statement(org, cols, { remitted: 100_000 - 60_000 });          // settles 100,000 in total
    const lines = db.prepare('SELECT collection_id, secured FROM org_statement_lines WHERE statement_id = ? ORDER BY collection_id').all(st.id);
    const amounts = cols.map((c) => c.amount);
    expect(lines[0].secured).toBe(Math.min(amounts[0], 100_000));
    expect(lines.reduce((s, l) => s + l.secured, 0)).toBe(100_000);
    expect(collected).toBeGreaterThan(100_000);
  });

  it('a fee is netted once: a second statement cannot net it again', async () => {
    const org = await newOrg();
    const o = await dispatched(org.id, { fee: 20_000 });
    const c = await collect(org.id, o, { collectedOn: today() });
    statement(org, [c], { chargeEntered: 20_000, remitted: c.amount - 20_000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM payout_items').get().n).toBeGreaterThan(0);
    expect(await code(() => statement(org, [c], { remitted: 1 }))).toBe('STATEMENT_PARCEL_ALREADY_LISTED');
  });

  it('refuses statements that do not add up, list the wrong parcels, or settle nothing', async () => {
    const org = await newOrg();
    const other = await newOrg();
    const { cols, collected } = await threeParcels(org);
    expect(await code(() => statement(org, cols, { remitted: collected }))).toBe('STATEMENT_EXCEEDS_COLLECTIONS'); // remitted + fees > collected
    expect(await code(() => statement(other, cols, { remitted: 1 }))).toBe('STATEMENT_WRONG_ORGANIZATION');
    expect(await code(() => statement(org, [cols[0], cols[0]], { remitted: 1 }))).toBe('STATEMENT_DUPLICATE_PARCEL');
    expect(await code(() => statement(org, [{ id: 999_999 }], { remitted: 1 }))).toBe('COLLECTION_NOT_FOUND');
    expect(await code(() => statement(org, [], { remitted: 1 }))).toBe('STATEMENT_NO_PARCELS');
    expect(await code(() => statement(org, cols, { remitted: -1 }))).toBe('STATEMENT_BAD_AMOUNT');
    expect(await code(() => statement(org, cols, { periodStart: today(), periodEnd: ago(3) }))).toBe('STATEMENT_BAD_PERIOD');
    expect(await code(() => statement(org, cols, { periodStart: ago(30), periodEnd: ago(10), remitted: 1 }))).toBe('STATEMENT_PARCEL_OUTSIDE_PERIOD');
    expect(await code(() => statement(org, cols, { staffId: null, remitted: 1 }))).toBe('STATEMENT_NO_ACTOR');
    const rider = await newRider();
    expect(await code(() => statement(rider, cols, { remitted: 1 }))).toBe('STATEMENT_NOT_AN_ORGANIZATION');

    // Nothing remitted and no fees owed (a zero-fee parcel) means nothing to settle.
    const z = await dispatched(org.id, { fee: 0, zeroReason: 'Free delivery' });
    const zc = await collect(org.id, z, { collectedOn: today() });
    expect(await code(() => statement(org, [zc], { chargeEntered: 0, remitted: 0 }))).toBe('STATEMENT_NOTHING_SETTLED');
    // A failed statement leaves nothing behind.
    expect(orgs.listOpenCollections({ storeId, courierId: org.id }).map((k) => k.id)).toEqual(expect.arrayContaining(cols.map((c) => c.id)));
  });
});

describe('ageing and the overdue limit', () => {
  it('ages what is still held from the newest collections back, and pauses new COD parcels past the limit', async () => {
    const org = await newOrg({ overdue_after_days: 14, overdue_limit: 1_000 });
    const old = await dispatched(org.id); const recent = await dispatched(org.id);
    await collect(org.id, old, { collectedOn: ago(40) });
    await collect(org.id, recent, { collectedOn: ago(2) });

    const s = orgs.organizationStanding({ storeId, courierId: org.id });
    expect(s.outstanding).toBe(old.total + recent.total);
    expect(Object.fromEntries(s.buckets.map((b) => [b.label, b.cents]))).toEqual({ '0-7': recent.total, '8-14': 0, '15-30': 0, '30+': old.total });
    expect(s.overdue).toBe(old.total);
    expect(s.paused).toBe(true);

    const blocked = await dispatched(org.id);
    expect(blocked.res.status).toBe(409);
    expect(blocked.res.body.error.code).toBe('ORGANIZATION_PAUSED');
    expect(order(blocked.id).status).toBe('awaiting_dispatch');
  });

  it('remittances settle the oldest first, so paying the old parcel clears the overdue amount and unpauses', async () => {
    const org = await newOrg({ overdue_after_days: 14, overdue_limit: 1_000 });
    const old = await dispatched(org.id, { fee: 20_000 }); const recent = await dispatched(org.id, { fee: 20_000 });
    const oc = await collect(org.id, old, { collectedOn: ago(40) });
    await collect(org.id, recent, { collectedOn: ago(2) });
    orgs.createStatement({ storeId, staffId, courierId: org.id, periodStart: ago(45), periodEnd: ago(1), collectionIds: [oc.id], chargeEntered: 20_000, remitted: oc.amount - 20_000 });
    const s = orgs.organizationStanding({ storeId, courierId: org.id });
    expect(s).toMatchObject({ outstanding: recent.total, overdue: 0, paused: false });
  });

  it('no limit set means never paused; a rider has no standing', async () => {
    const org = await newOrg();
    const o = await dispatched(org.id);
    await collect(org.id, o, { collectedOn: ago(60) });
    expect(orgs.organizationStanding({ storeId, courierId: org.id })).toMatchObject({ overdue: o.total, limit: null, paused: false });
    expect(() => orgs.organizationStanding({ storeId, courierId: (db.prepare(`SELECT id FROM couriers WHERE kind='rider' LIMIT 1`).get()).id })).toThrow(/not found/i);
  });
});

describe('the HTTP surface', () => {
  it('records a collection, lists it as open, settles it, and shows the standing', async () => {
    const org = await newOrg();
    const o = await dispatched(org.id, { fee: 20_000 });
    const c = await auth(request(app).post(`/api/couriers/${org.id}/collections`)).send({ order_id: o.id, amount: o.total });
    expect(c.status).toBe(201);
    expect((await auth(request(app).get(`/api/couriers/${org.id}/collections`))).body.data.map((k) => k.id)).toEqual([c.body.data.id]);
    expect((await auth(request(app).get(`/api/couriers/${org.id}/standing`))).body.data.outstanding).toBe(o.total);

    const st = await auth(request(app).post(`/api/couriers/${org.id}/statements`)).send({
      period_start: ago(7), period_end: today(), collection_ids: [c.body.data.id], charge_entered: 20_000, remitted: o.total - 20_000, remittance_ref: 'EFT-1',
    });
    expect(st.status).toBe(201);
    expect(st.body.data).toMatchObject({ fees: 20_000, cash_variance: 0 });
    expect((await auth(request(app).get(`/api/couriers/${org.id}/statements`))).body.data).toHaveLength(1);
    expect((await auth(request(app).get(`/api/couriers/${org.id}/standing`))).body.data.outstanding).toBe(0);
  });

  it('reports business-rule failures with their code, and rejects malformed bodies and anonymous callers', async () => {
    const org = await newOrg();
    const bad = await auth(request(app).post(`/api/couriers/${org.id}/collections`)).send({ order_id: 999_999, amount: 100 });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('ORDER_NOT_FOUND');
    expect((await auth(request(app).post(`/api/couriers/${org.id}/statements`)).send({ period_start: 'x' })).status).toBe(400);
    expect((await request(app).get(`/api/couriers/${org.id}/standing`)).status).toBe(401);
  });

  it('riders cannot be given organization fields, and an organization defaults to the g4s type', async () => {
    const bad = await auth(request(app).post('/api/couriers')).send({ name: 'Rider X', kind: 'rider', courier_type: 'boda', collects_payment: true });
    expect(bad.status).toBe(422);
    const org = await newOrg({ contact_person: 'Jane', overdue_limit: 500_000 });
    expect(org).toMatchObject({ kind: 'organization', courier_type: 'g4s', collects_payment: 1, contact_person: 'Jane', overdue_limit: 500_000, overdue_after_days: 14 });
  });
});
