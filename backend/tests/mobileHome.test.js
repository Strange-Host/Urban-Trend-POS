const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const homeFeed = require('../src/services/homeFeed.service');
const courierOrganizations = require('../src/services/courierOrganizations.service');

// The mobile home screen's endpoints: app/version (public), home/attention (routed by permission) and home/summary.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
let ipN = 0;
const ip = () => { ipN += 1; return `10.88.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };

let admin; let manager; let cashier; let cashier2; let storeId; let product;

async function makeUser(role, email) {
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `${role} ${email.split('@')[0]}`, email, bcrypt.hashSync(PASSWORD, 4), role);
  const login = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { id: r.lastInsertRowid, token: login.body.token, name: login.body.user.name };
}
const revoke = (userId, key) => db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, 0)`).run(userId, key);
const grant = (userId, key) => db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, 1)`).run(userId, key);

const attention = async (u) => (await request(app).get('/api/v1/home/attention').set(auth(u.token))).body;
const summary = async (u) => (await request(app).get('/api/v1/home/summary').set(auth(u.token))).body;
const ofKind = (body, kind) => body.items.filter((i) => i.kind === kind);

async function ringUp(u) {
  const res = await request(app).post('/api/sales').set(auth(u.token))
    .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
  expect(res.status).toBe(201);
  return res.body.data;
}
const addExpense = (by, status = 'pending', amount = 150000) => {
  const cat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get().id;
  return db.prepare(`INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id, status)
    VALUES (?, ?, ?, 'Test expense', date('now'), ?, ?)`).run(storeId, cat, amount, by.id, status).lastInsertRowid;
};
const addUnmatched = (minutesAgo, amount = 250000) => db.prepare(`
  INSERT INTO payment_notifications (store_id, source, method, amount, status, payer_name, external_reference, created_at)
  VALUES (?, 'mpesa', 'mobile_money', ?, 'unmatched', 'Jane Wanjiku', ?, datetime('now', ?))`)
  .run(storeId, amount, `QX${Math.random().toString(36).slice(2, 8).toUpperCase()}`, `-${minutesAgo} minutes`).lastInsertRowid;

beforeAll(async () => {
  admin = { token: await loginAsAdmin() };
  admin.id = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  storeId = db.prepare('SELECT store_id FROM users WHERE id = ?').get(admin.id).store_id;
  manager = await makeUser('manager', 'home-manager@urbantrends.com');
  cashier = await makeUser('cashier', 'home-cashier@urbantrends.com');
  cashier2 = await makeUser('cashier', 'home-cashier2@urbantrends.com');
  product = db.prepare(`SELECT p.id, p.sell_price FROM products p WHERE p.is_active = 1 AND p.approval_status = 'approved' LIMIT 1`).get();
  db.prepare('UPDATE inventory SET quantity = quantity + 200 WHERE product_id = ? AND store_id = ?').run(product.id, storeId);
});
beforeEach(() => homeFeed.clearCache());
afterAll(() => cleanupTestDb());

describe('GET /api/v1/app/version', () => {
  const get = (q = '') => request(app).get(`/api/v1/app/version${q}`);
  const setSettings = (body) => request(app).put('/api/settings').set(auth(admin.token)).send(body);

  it('is public and answers with the release gate', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ minimumVersion: '1.0.0', latestVersion: '1.0.0', downloadUrl: null, updateRequired: false, updateAvailable: false });
  });

  it('tells an app what to do about its own version', async () => {
    expect((await setSettings({ app_min_version: '1.2.0', app_latest_version: '1.4.1', app_download_url: 'https://example.com/urban-trends.apk' })).status).toBe(200);
    const old = (await get('?current=1.1.9')).body;
    expect(old).toMatchObject({ minimumVersion: '1.2.0', latestVersion: '1.4.1', downloadUrl: 'https://example.com/urban-trends.apk', updateRequired: true, updateAvailable: true });
    expect((await get('?current=1.3.0')).body).toMatchObject({ updateRequired: false, updateAvailable: true });
    expect((await get('?current=1.4.1')).body).toMatchObject({ updateRequired: false, updateAvailable: false });
    expect((await get('?current=1.10.0')).body).toMatchObject({ updateRequired: false, updateAvailable: false });   // numeric, not alphabetical
    expect((await get('?current=v1.2')).body).toMatchObject({ updateRequired: false, updateAvailable: true });
  });

  it('never blocks an app it cannot place', async () => {
    expect((await get('?current=banana')).body).toMatchObject({ updateRequired: false, updateAvailable: false });
    expect((await get()).body).toMatchObject({ updateRequired: false, updateAvailable: false });
  });

  it('refuses nonsense release settings so one typo cannot lock every phone out', async () => {
    expect((await setSettings({ app_min_version: 'latest' })).status).toBe(400);
    expect((await setSettings({ app_min_version: '2.0.0' })).status).toBe(400);                 // above the latest (1.4.1)
    expect((await setSettings({ app_latest_version: '1.0.0' })).status).toBe(400);              // below the minimum (1.2.0)
    expect((await setSettings({ app_download_url: 'http://example.com/a.apk' })).status).toBe(400);
    expect((await setSettings({ attention_cash_variance_kes: 'lots' })).status).toBe(400);
    expect((await get()).body.minimumVersion).toBe('1.2.0');                                    // none of that was saved
    await setSettings({ app_min_version: '1.0.0', app_latest_version: '1.0.0', app_download_url: '' });
  });
});

describe('GET /api/v1/home/attention', () => {
  it('needs a signed-in user', async () => {
    expect((await request(app).get('/api/v1/home/attention')).status).toBe(401);
    expect((await request(app).get('/api/v1/home/summary')).status).toBe(401);
  });

  it('routes void requests to people who can review them, never to the cashier, never to the requester', async () => {
    const sale = await ringUp(cashier);
    const filed = await request(app).post('/api/approvals').set(auth(cashier.token)).send({ kind: 'void_sale', sale_id: sale.id, reason: 'Wrong item rung up' });
    expect(filed.status).toBe(201);
    const reqId = filed.body.data.id;

    for (const who of [manager, admin]) {
      const mine = ofKind(await attention(who), 'approval_request').find((i) => i.link.id === reqId);
      expect(mine).toMatchObject({ id: `approval_request:${reqId}`, severity: 'warning', amountCents: expect.any(Number), link: { type: 'approval', id: reqId } });
      expect(mine.title).toContain(cashier.name);
      expect(mine.detail).toBe('Wrong item rung up');
      expect(Date.parse(mine.since)).not.toBeNaN();
    }
    const theirs = await attention(cashier);                    // the requester is a cashier: no approvals.review, nothing to decide
    expect(theirs).toMatchObject({ total: 0, items: [], counts: {} });
    expect((await attention(cashier2)).items).toEqual([]);

    // A manager who files one is not asked to approve it themselves.
    const sale2 = await ringUp(manager);
    const own = await request(app).post('/api/approvals').set(auth(manager.token)).send({ kind: 'void_sale', sale_id: sale2.id, reason: 'Duplicate' });
    homeFeed.clearCache();
    expect(ofKind(await attention(manager), 'approval_request').some((i) => i.link.id === own.body.data.id)).toBe(false);
    expect(ofKind(await attention(admin), 'approval_request').some((i) => i.link.id === own.body.data.id)).toBe(true);
  });

  it('follows permissions, not roles: revoke it from a manager, grant it to a cashier', async () => {
    const eid = addExpense(cashier2);
    expect(ofKind(await attention(manager), 'expense_pending').some((i) => i.link.id === eid)).toBe(true);
    expect(ofKind(await attention(cashier), 'expense_pending')).toEqual([]);

    revoke(manager.id, 'expenses.approve');
    grant(cashier.id, 'expenses.approve');
    homeFeed.clearCache();
    expect(ofKind(await attention(manager), 'expense_pending')).toEqual([]);
    const granted = ofKind(await attention(cashier), 'expense_pending').find((i) => i.link.id === eid);
    expect(granted).toMatchObject({ kind: 'expense_pending', amountCents: 150000, link: { type: 'expense', id: eid } });
    expect(ofKind(await attention(cashier2), 'expense_pending')).toEqual([]);   // still no right, still nothing (and it is their own)

    db.prepare('DELETE FROM user_permissions WHERE user_id IN (?, ?) AND permission = ?').run(manager.id, cashier.id, 'expenses.approve');
  });

  it('does not show approved or rejected expenses, or the approver\'s own', async () => {
    const done = addExpense(cashier2, 'approved');
    const mineOwn = addExpense(manager, 'pending');
    homeFeed.clearCache();
    const ids = ofKind(await attention(manager), 'expense_pending').map((i) => i.link.id);
    expect(ids).not.toContain(done);
    expect(ids).not.toContain(mineOwn);
  });

  it('lists unmatched payments only once they are older than an hour, and escalates after a day', async () => {
    const fresh = addUnmatched(10);
    const stale = addUnmatched(120);
    const ancient = addUnmatched(30 * 60);
    const body = await attention(manager);
    const ids = ofKind(body, 'unmatched_payment').map((i) => i.link.id);
    expect(ids).toContain(stale);
    expect(ids).toContain(ancient);
    expect(ids).not.toContain(fresh);
    expect(ofKind(body, 'unmatched_payment').find((i) => i.link.id === ancient).severity).toBe('urgent');
    expect(ofKind(body, 'unmatched_payment').find((i) => i.link.id === stale).severity).toBe('warning');
    expect(ofKind(body, 'unmatched_payment').find((i) => i.link.id === stale).title).toBe('KES 2,500 MPESA payment matched no order');
    expect((await attention(cashier)).items).toEqual([]);
  });

  it('puts the most urgent first, then the oldest', async () => {
    const body = await attention(manager);
    const ranks = body.items.map((i) => ({ urgent: 0, warning: 1, info: 2 })[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(body.items[0].severity).toBe('urgent');
    const warnings = body.items.filter((i) => i.severity === 'warning').map((i) => Date.parse(i.since));
    expect(warnings).toEqual([...warnings].sort((a, b) => a - b));
  });

  it('flags a till that closed far off its expected cash, and ignores small differences', async () => {
    const short = db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount, closing_amount, expected_amount, closed_at)
      VALUES (?, ?, 0, 400000, 500000, datetime('now', '-1 hour'))`).run(storeId, cashier.id).lastInsertRowid;
    const fine = db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount, closing_amount, expected_amount, closed_at)
      VALUES (?, ?, 0, 499000, 500000, datetime('now', '-1 hour'))`).run(storeId, cashier.id).lastInsertRowid;
    const old = db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount, closing_amount, expected_amount, closed_at)
      VALUES (?, ?, 0, 100000, 500000, datetime('now', '-5 days'))`).run(storeId, cashier.id).lastInsertRowid;
    const found = ofKind(await attention(manager), 'cash_variance');
    const row = found.find((i) => i.link.id === short);
    expect(row).toMatchObject({ amountCents: 100000, link: { type: 'cash_session', id: short } });
    expect(row.title).toBe(`${cashier.name}'s till was short by KES 1,000`);
    expect(found.some((i) => i.link.id === fine)).toBe(false);
    expect(found.some((i) => i.link.id === old)).toBe(false);

    // The threshold is the owner's to set.
    await request(app).put('/api/settings').set(auth(admin.token)).send({ attention_cash_variance_kes: '5' });
    homeFeed.clearCache();
    expect(ofKind(await attention(manager), 'cash_variance').some((i) => i.link.id === fine)).toBe(true);
    await request(app).put('/api/settings').set(auth(admin.token)).send({ attention_cash_variance_kes: '500' });
  });

  it('flags a courier organization that is overdue with the money it collected', async () => {
    const orgId = db.prepare(`INSERT INTO couriers (store_id, name, kind, collects_payment, overdue_limit) VALUES (?, 'Test Cargo Co', 'organization', 1, 100000)`)
      .run(storeId).lastInsertRowid;
    const spy = vi.spyOn(courierOrganizations, 'organizationStanding').mockImplementation(({ courierId }) => (
      courierId === orgId ? { overdue: 480000, paused: true } : { overdue: 0, paused: false }));
    try {
      const row = ofKind(await attention(manager), 'courier_remittance_overdue').find((i) => i.link.id === orgId);
      expect(row).toMatchObject({ severity: 'urgent', amountCents: 480000, title: 'Test Cargo Co owes KES 4,800 past its due date' });
      expect(row.detail).toMatch(/Paused/);
      expect(ofKind(await attention(cashier), 'courier_remittance_overdue')).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('shows proposed products and requisitions to the people who approve them (requisitions only while HR is on)', async () => {
    const pid = db.prepare(`INSERT INTO products (sku, name, sell_price, approval_status, submitted_by_staff_id) VALUES ('HOME-PEND-1', 'Pending Hat', 150000, 'pending', ?)`).run(cashier.id).lastInsertRowid;
    const rid = db.prepare(`INSERT INTO requisitions (store_id, requested_by_staff_id, notes) VALUES (?, ?, 'Need cleaning supplies')`).run(storeId, cashier.id).lastInsertRowid;
    let body = await attention(manager);
    expect(ofKind(body, 'product_pending').find((i) => i.link.id === pid)).toMatchObject({ severity: 'info', title: `${cashier.name} proposed a new product: Pending Hat` });
    expect(ofKind(body, 'requisition_pending').find((i) => i.link.id === rid)).toMatchObject({ detail: 'Need cleaning supplies' });

    db.prepare(`UPDATE settings SET value = '0' WHERE key = 'module_hr_enabled'`).run();
    homeFeed.clearCache();
    body = await attention(manager);
    expect(ofKind(body, 'requisition_pending')).toEqual([]);
    expect(ofKind(body, 'product_pending').length).toBeGreaterThan(0);
    db.prepare(`UPDATE settings SET value = '1' WHERE key = 'module_hr_enabled'`).run();
  });

  it('counts everything but sends at most 50 items', async () => {
    const expenseIds = Array.from({ length: 30 }, () => addExpense(cashier2));
    const paymentIds = Array.from({ length: 30 }, (_, i) => addUnmatched(90 + i));
    const body = await attention(manager);
    expect(body.items.length).toBeLessThanOrEqual(50);
    expect(body.total).toBeGreaterThanOrEqual(60);
    expect(body.counts.expense_pending).toBeGreaterThanOrEqual(31);
    expect(ofKind(body, 'expense_pending').length).toBeLessThanOrEqual(25);
    expect(body.items[0].severity).toBe('urgent');                 // when the list is full, urgent items are what stays

    // Put the database back so the tests after this one see an ordinary shop.
    db.prepare(`DELETE FROM expenses WHERE id IN (${expenseIds.join(',')})`).run();
    db.prepare(`DELETE FROM payment_notifications WHERE id IN (${paymentIds.join(',')})`).run();
  });

  it('is cached per person for a short time, and rebuilt after it', async () => {
    const first = await attention(manager);
    const pid = db.prepare(`INSERT INTO products (sku, name, sell_price, approval_status, submitted_by_staff_id) VALUES ('HOME-CACHE-1', 'Cache Cap', 100000, 'pending', ?)`).run(cashier2.id).lastInsertRowid;
    const second = await attention(manager);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(ofKind(second, 'product_pending').some((i) => i.link.id === pid)).toBe(false);

    homeFeed.clearCache();
    expect(ofKind(await attention(manager), 'product_pending').some((i) => i.link.id === pid)).toBe(true);

    // One person's cached list is never handed to another.
    expect((await attention(cashier)).items).toEqual([]);
  });

  it('a revoked phone gets nothing', async () => {
    const u = await makeUser('manager', 'home-revoked@urbantrends.com');
    const sid = db.prepare(`SELECT id FROM auth_sessions WHERE user_id = ? AND client = 'mobile'`).get(u.id).id;
    expect((await request(app).get('/api/v1/home/attention').set(auth(u.token))).status).toBe(200);
    await request(app).delete(`/api/v1/devices/${sid}`).set(auth(admin.token));
    expect((await request(app).get('/api/v1/home/attention').set(auth(u.token))).status).toBe(401);
  });
});

describe('GET /api/v1/home/summary', () => {
  it('gives a cashier only their own sales today, with no shop figures and no cost', async () => {
    const before = await summary(cashier);
    expect(before.scope).toBe('mine');
    await ringUp(cashier);
    await ringUp(cashier2);
    homeFeed.clearCache();
    const after = await summary(cashier);
    expect(after.mySalesCount).toBe(before.mySalesCount + 1);
    expect(after.mySalesCents).toBe(before.mySalesCents + product.sell_price);
    for (const k of ['posSalesCents', 'totalSalesCents', 'cashCollectedCents', 'lowStockCount', 'attentionCount']) expect(after[k]).toBeUndefined();
    expect(JSON.stringify(after).toLowerCase()).not.toMatch(/cost|profit|margin/);
  });

  it('gives a manager the whole shop for today, from the same definition the web dashboard uses', async () => {
    const before = await summary(manager);
    expect(before).toMatchObject({ scope: 'shop', currency: 'KES' });
    await ringUp(cashier);
    homeFeed.clearCache();
    const after = await summary(manager);
    expect(after.posSalesCount).toBe(before.posSalesCount + 1);
    expect(after.posSalesCents).toBe(before.posSalesCents + product.sell_price);
    expect(after.totalSalesCents).toBe(after.posSalesCents + after.onlineSalesCents);
    expect(after.cashCollectedCents).toBe(before.cashCollectedCents + product.sell_price);
    expect(after.attentionCount).toBe((await attention(manager)).total);
    expect(JSON.stringify(after).toLowerCase()).not.toMatch(/cost|profit|margin/);

    const web = (await request(app).get('/api/reports/dashboard-overview').set(auth(admin.token))).body.data;
    const adminSummary = await summary(admin);
    expect(adminSummary.posSalesCents).toBe(web.salesToday.posRevenue);
    expect(adminSummary.onlineSalesCents).toBe(web.salesToday.onlineRevenue);
    expect(adminSummary.date).toBe(web.date);
  });

  it('follows reports.view: granting it to a cashier opens the shop figures, revoking it from a manager closes them', async () => {
    grant(cashier2.id, 'reports.view');
    revoke(manager.id, 'reports.view');
    homeFeed.clearCache();
    expect((await summary(cashier2)).scope).toBe('shop');
    expect((await summary(manager)).scope).toBe('mine');
    db.prepare('DELETE FROM user_permissions WHERE user_id IN (?, ?) AND permission = ?').run(cashier2.id, manager.id, 'reports.view');
  });

  it('is cached for a short time', async () => {
    homeFeed.clearCache();
    const first = await summary(manager);
    await ringUp(cashier);
    expect((await summary(manager)).generatedAt).toBe(first.generatedAt);
  });
});
