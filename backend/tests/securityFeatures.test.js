const bcrypt = require('bcryptjs');
const { app, request, extractRefreshCookie, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const securityAlerts = require('../src/services/securityAlerts.service');

afterAll(() => cleanupTestDb());

const PW = 'Sturdy-Pelican-47';
let ipN = 100;
const ip = () => { ipN += 1; return `10.30.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const store = () => db.prepare('SELECT id FROM stores LIMIT 1').get().id;
let n = 0;

function makeUser({ role = 'cashier', active = 1 } = {}) {
  n += 1;
  const id = db.prepare(`INSERT INTO users (store_id, name, email, phone, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(store(), `Feature Person ${n}`, `feat${n}@example.com`, `07220000${String(n).padStart(2, '0')}`, bcrypt.hashSync(PW, 4), role, active).lastInsertRowid;
  return { id, name: `Feature Person ${n}`, email: `feat${n}@example.com` };
}
async function signIn(email, password = PW) {
  const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email, password });
  return { token: res.body.token, sid: res.body.session?.id, cookie: extractRefreshCookie(res), res };
}
const adminLogin = () => signIn('admin@urbantrends.com', 'ChangeMe123!');
const stale = (sid, ms = 10 * 60 * 1000) => db.prepare('UPDATE auth_sessions SET reauth_at = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), sid);

describe('confirm-it-is-you before risky actions', () => {
  it('asks for the password again when the last confirmation is old, then lets the action through', async () => {
    const admin = await adminLogin();
    const body = { name: 'Needs Confirm', email: 'needs-confirm@example.com', phone: '0733000001', password: 'Teal-Harbour-5521', role: 'cashier' };
    expect((await request(app).post('/api/staff').set(auth(admin.token)).send(body)).status).toBe(201);   // fresh sign-in counts

    stale(admin.sid);
    const blocked = await request(app).post('/api/staff').set(auth(admin.token)).send({ ...body, email: 'needs-confirm-2@example.com', phone: '0733000002' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('REAUTH_REQUIRED');

    const wrong = await request(app).post('/api/auth/unlock').set('X-Forwarded-For', ip()).set(auth(admin.token)).send({ password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    const ok = await request(app).post('/api/auth/unlock').set('X-Forwarded-For', ip()).set(auth(admin.token)).send({ password: 'ChangeMe123!' });
    expect(ok.status).toBe(200);
    expect((await request(app).post('/api/staff').set(auth(admin.token)).send({ ...body, email: 'needs-confirm-2@example.com', phone: '0733000002' })).status).toBe(201);
  });

  it('does not ask for reads, only for changes', async () => {
    const admin = await adminLogin();
    stale(admin.sid);
    expect((await request(app).get('/api/staff').set(auth(admin.token))).status).toBe(200);
  });

  it('guards settings, integrations and the security policy too', async () => {
    const admin = await adminLogin();
    stale(admin.sid);
    for (const [method, url] of [['put', '/api/settings'], ['put', '/api/security/policy'], ['put', '/api/system/config'], ['put', '/api/sms/credentials'], ['post', '/api/income-sources']]) {
      const r = await request(app)[method](url).set(auth(admin.token)).send({});
      expect([url, r.status, r.body.error?.code]).toEqual([url, 403, 'REAUTH_REQUIRED']);
    }
  });
});

describe('staff: reactivate, delete unused, erase personal data', () => {
  it('rejects a weak password when creating staff and gives temporary passwords that must be changed', async () => {
    const admin = await adminLogin();
    const weak = await request(app).post('/api/staff').set(auth(admin.token)).send({ name: 'Weak One', email: 'weak-one@example.com', phone: '0733000010', password: 'Password123!', role: 'manager' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');

    const u = makeUser();
    const reset = await request(app).post(`/api/staff/${u.id}/reset-password`).set(auth(admin.token)).send({});
    expect(reset.status).toBe(200);
    expect(reset.body.data.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    expect(db.prepare('SELECT must_change_password m FROM users WHERE id = ?').get(u.id).m).toBe(1);
  });

  it('deactivates and reactivates an account', async () => {
    const admin = await adminLogin();
    const u = makeUser();
    expect((await request(app).delete(`/api/staff/${u.id}`).set(auth(admin.token))).status).toBe(204);
    expect((await signIn(u.email)).res.status).toBe(401);
    const back = await request(app).post(`/api/staff/${u.id}/reactivate`).set(auth(admin.token)).send({});
    expect(back.status).toBe(200);
    expect(back.body.data.status).toBe('active');
    expect((await signIn(u.email)).res.status).toBe(200);
  });

  it('permanently deletes an account that never did anything, but only after typing the name', async () => {
    const admin = await adminLogin();
    const u = makeUser();
    await signIn(u.email);                                                  // sessions and tokens exist: they go with the account
    const check = await request(app).get(`/api/staff/${u.id}/removal-check`).set(auth(admin.token));
    expect(check.body.data.canDeletePermanently).toBe(true);

    const noConfirm = await request(app).post(`/api/staff/${u.id}/permanent-delete`).set(auth(admin.token)).send({ confirmName: 'someone else' });
    expect(noConfirm.status).toBe(400);
    const done = await request(app).post(`/api/staff/${u.id}/permanent-delete`).set(auth(admin.token)).send({ confirmName: u.name });
    expect(done.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id)).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM security_events WHERE type = 'staff_deleted'`).get()).toBeTruthy();
  });

  it('refuses to delete an account with history and says what the history is', async () => {
    const admin = await adminLogin();
    const u = makeUser();
    db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount) VALUES (?, ?, 0)`).run(store(), u.id);
    const check = await request(app).get(`/api/staff/${u.id}/removal-check`).set(auth(admin.token));
    expect(check.body.data.canDeletePermanently).toBe(false);
    expect(check.body.data.activity['cash sessions']).toBe(1);
    const del = await request(app).post(`/api/staff/${u.id}/permanent-delete`).set(auth(admin.token)).send({ confirmName: u.name });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('CANNOT_DELETE_ACCOUNT');
  });

  it('erases a former staff member\'s personal data but keeps their records', async () => {
    const admin = await adminLogin();
    const u = makeUser();
    db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount) VALUES (?, ?, 0)`).run(store(), u.id);
    db.prepare(`INSERT INTO employee_documents (staff_id, doc_type, file_reference, uploaded_by) VALUES (?, 'national_id', 'scan-123.pdf', ?)`).run(u.id, 1);
    await request(app).patch(`/api/staff/${u.id}`).set(auth(admin.token)).send({ phone: '0733999888' });   // leaves an audit entry holding old details

    const early = await request(app).post(`/api/staff/${u.id}/erase-personal-data`).set(auth(admin.token)).send({ confirmName: u.name });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('DEACTIVATE_FIRST');
    await request(app).delete(`/api/staff/${u.id}`).set(auth(admin.token));

    const bad = await request(app).post(`/api/staff/${u.id}/erase-personal-data`).set(auth(admin.token)).send({ confirmName: 'wrong' });
    expect(bad.status).toBe(400);
    const done = await request(app).post(`/api/staff/${u.id}/erase-personal-data`).set(auth(admin.token)).send({ confirmName: u.name });
    expect(done.status).toBe(200);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    expect(row.name).toBe(`Former staff #${u.id}`);
    expect(row.email).toMatch(/removed\.invalid$/);
    expect(row.erased_at).toBeTruthy();
    expect(row.pin_code_hash).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM cash_sessions WHERE user_id = ?').get(u.id).c).toBe(1);          // records stay
    expect(db.prepare('SELECT COUNT(*) c FROM employee_documents WHERE staff_id = ?').get(u.id).c).toBe(0);    // personal documents go
    const logs = db.prepare(`SELECT changes FROM staff_logs WHERE entity_type = 'staff' AND entity_id = ?`).all(u.id).map((l) => l.changes);
    expect(logs.some((c) => c.includes(u.email) || c.includes('0733999888') || c.includes(u.name))).toBe(false);
    expect((await signIn(u.email)).res.status).toBe(401);

    const again = await request(app).post(`/api/staff/${u.id}/reactivate`).set(auth(admin.token)).send({});
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('ACCOUNT_ERASED');
    expect((await request(app).patch(`/api/staff/${u.id}`).set(auth(admin.token)).send({ name: 'Back Again' })).status).toBe(400);
  });

  it('will not remove yourself or the only active admin', async () => {
    const admin = await adminLogin();
    const me = db.prepare(`SELECT id, name FROM users WHERE email = 'admin@urbantrends.com'`).get();
    const check = await request(app).get(`/api/staff/${me.id}/removal-check`).set(auth(admin.token));
    expect(check.body.data.canDeletePermanently).toBe(false);
    expect(check.body.data.canErase).toBe(false);
    expect((await request(app).post(`/api/staff/${me.id}/permanent-delete`).set(auth(admin.token)).send({ confirmName: me.name })).status).toBe(409);
  });

  it('lets an admin lift a lockout and sign someone out everywhere', async () => {
    const admin = await adminLogin();
    const u = makeUser();
    for (let i = 0; i < 5; i += 1) await signIn(u.email, 'wrong-wrong-wrong');
    expect((await signIn(u.email)).res.status).toBe(429);
    expect((await request(app).post(`/api/staff/${u.id}/unlock-account`).set(auth(admin.token)).send({})).status).toBe(200);
    const s = await signIn(u.email);
    expect(s.res.status).toBe(200);

    const list = await request(app).get(`/api/staff/${u.id}/sessions`).set(auth(admin.token));
    expect(list.body.data.length).toBe(1);
    const out = await request(app).post(`/api/staff/${u.id}/sign-out-everywhere`).set(auth(admin.token)).send({});
    expect(out.body.data.ended).toBe(1);
    expect((await request(app).get('/api/products').set(auth(s.token))).status).toBe(401);
  });
});

describe('categories: delete with move, archive and restore', () => {
  const cat = (name) => db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid;
  const product = (categoryId, active = 1) => { n += 1; return db.prepare(`INSERT INTO products (sku, name, category_id, cost_price, sell_price, is_active) VALUES (?, ?, ?, 100, 200, ?)`).run(`CAT-${n}-${Date.now()}`, `Cat Product ${n}`, categoryId, active).lastInsertRowid; };

  it('reports what a category holds, refuses to delete it while in use, and moves everything in one step', async () => {
    const admin = await adminLogin();
    const from = cat('From Cat'); const to = cat('To Cat');
    const child = db.prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)').run('Child Cat', from).lastInsertRowid;
    const a = product(from, 1); const b = product(from, 0);                                  // one active, one switched off

    const usage = await request(app).get(`/api/categories/${from}/usage`).set(auth(admin.token));
    expect(usage.body.data).toMatchObject({ products: 2, activeProducts: 1, inactiveProducts: 1, subcategories: 1, inUse: true });

    const refused = await request(app).delete(`/api/categories/${from}`).set(auth(admin.token));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CATEGORY_IN_USE');

    const sameTarget = await request(app).delete(`/api/categories/${from}?move_to=${from}`).set(auth(admin.token));
    expect(sameTarget.status).toBe(400);

    const done = await request(app).delete(`/api/categories/${from}?move_to=${to}`).set(auth(admin.token));
    expect(done.status).toBe(200);
    expect(done.body.data.moved.products).toBe(2);
    expect(db.prepare('SELECT category_id c FROM products WHERE id = ?').get(a).c).toBe(to);
    expect(db.prepare('SELECT category_id c FROM products WHERE id = ?').get(b).c).toBe(to);    // even the switched-off one
    expect(db.prepare('SELECT parent_id p FROM categories WHERE id = ?').get(child).p).toBeNull(); // moved up a level
    expect(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(from)).toBeUndefined();
  });

  it('deletes an unused category straight away', async () => {
    const admin = await adminLogin();
    const id = cat('Unused Cat');
    expect((await request(app).delete(`/api/categories/${id}`).set(auth(admin.token))).status).toBe(200);
  });

  it('archives (hidden from pickers, kept on its products) and restores', async () => {
    const admin = await adminLogin();
    const id = cat('Archive Me'); const p = product(id);
    const arch = await request(app).post(`/api/categories/${id}/archive`).set(auth(admin.token)).send({});
    expect(arch.body.data.is_archived).toBe(1);
    const visible = (await request(app).get('/api/categories').set(auth(admin.token))).body.data.map((c) => c.id);
    expect(visible).not.toContain(id);
    const all = (await request(app).get('/api/categories?include_archived=1').set(auth(admin.token))).body.data.map((c) => c.id);
    expect(all).toContain(id);
    expect(db.prepare('SELECT category_id c FROM products WHERE id = ?').get(p).c).toBe(id);   // still filed there

    const target = cat('Target');
    await request(app).post(`/api/categories/${target}/archive`).set(auth(admin.token)).send({});
    const refuse = await request(app).delete(`/api/categories/${id}?move_to=${target}`).set(auth(admin.token));
    expect(refuse.status).toBe(400);                                                            // can't move into an archived one

    const back = await request(app).post(`/api/categories/${id}/restore`).set(auth(admin.token)).send({});
    expect(back.body.data.is_archived).toBe(0);
  });
});

describe('security alerts', () => {
  it('alerts the other admins (not the person who did it) and records the event', () => {
    const second = makeUser({ role: 'admin' });
    const actor = db.prepare(`SELECT id, name FROM users WHERE email = 'admin@urbantrends.com'`).get();
    securityAlerts.credentialsChanged({ storeId: store(), actor, what: 'Test connection' });
    const to = db.prepare(`SELECT user_id FROM notifications WHERE type = 'security' AND title LIKE '%Test connection%'`).all().map((r) => r.user_id);
    expect(to).toContain(second.id);
    expect(to).not.toContain(actor.id);
    expect(db.prepare(`SELECT 1 FROM security_events WHERE type = 'credentials_changed'`).get()).toBeTruthy();
  });

  it('only alerts on big refunds, voids, stock changes and price changes', () => {
    const actor = { id: 1, name: 'Admin' };
    const before = () => db.prepare('SELECT COUNT(*) c FROM security_events').get().c;
    let c = before();
    securityAlerts.largeMoney({ storeId: store(), actor, kind: 'refund', amountCents: 100000, reference: '#1' });          // KES 1,000: under the 3,000 limit
    securityAlerts.stockAdjusted({ storeId: store(), actor, product: 'X', qty: 5, reason: 'adjustment' });                 // 5 units
    securityAlerts.priceChanged({ storeId: store(), actor, product: 'X', oldCents: 10000, newCents: 10500 });              // 5%
    expect(before()).toBe(c);

    securityAlerts.largeMoney({ storeId: store(), actor, kind: 'refund', amountCents: 500000, reference: '#2' });
    securityAlerts.largeMoney({ storeId: store(), actor, kind: 'void', amountCents: 400000, reference: '#3' });
    securityAlerts.stockAdjusted({ storeId: store(), actor, product: 'X', qty: -30, reason: 'adjustment' });
    securityAlerts.priceChanged({ storeId: store(), actor, product: 'X', oldCents: 10000, newCents: 7000 });
    expect(before()).toBe(c + 4);
  });

  it('raises an alert when a big stock adjustment is made through the app', async () => {
    const admin = await adminLogin();
    const cid = db.prepare('INSERT INTO categories (name) VALUES (?)').run('Alert Cat').lastInsertRowid;
    const pid = db.prepare(`INSERT INTO products (sku, name, category_id, cost_price, sell_price) VALUES ('ALERT-1', 'Alert Product', ?, 100, 200)`).run(cid).lastInsertRowid;
    await request(app).post('/api/inventory/adjust').set(auth(admin.token)).send({ product_id: pid, change_qty: 60, reason: 'restock' });
    expect(db.prepare(`SELECT 1 FROM security_events WHERE type = 'stock_adjusted' AND title LIKE '%60%'`).get()).toBeTruthy();
  });
});

describe('security policy', () => {
  it('shows the defaults and rejects a lock time that is not before the sign-out time', async () => {
    const admin = await adminLogin();
    const get = await request(app).get('/api/security/policy').set(auth(admin.token));
    expect(get.body.data.roles.cashier).toEqual({ lockMinutes: 5, idleSignOutMinutes: 30, maxHours: 12 });
    expect(get.body.data.lockout).toEqual({ attempts: 5, minutes: 15 });

    const bad = await request(app).put('/api/security/policy').set(auth(admin.token)).send({ roles: { cashier: { lockMinutes: 40, idleSignOutMinutes: 30 } } });
    expect(bad.status).toBe(400);
    const tooLow = await request(app).put('/api/security/policy').set(auth(admin.token)).send({ lockout: { attempts: 1 } });
    expect(tooLow.status).toBe(400);
  });

  it('saves changes, applies them to new sessions, and keeps other settings routes away from security keys', async () => {
    const admin = await adminLogin();
    const ok = await request(app).put('/api/security/policy').set(auth(admin.token)).send({ roles: { cashier: { lockMinutes: 3, idleSignOutMinutes: 20, maxHours: 10 } } });
    expect(ok.status).toBe(200);
    const u = makeUser();
    expect((await signIn(u.email)).res.body.session.lockAfterSeconds).toBe(180);
    expect((await request(app).put('/api/settings').set(auth(admin.token)).send({ security_lock_minutes_cashier: '1' })).status).toBe(400);
    await request(app).put('/api/security/policy').set(auth(admin.token)).send({ roles: { cashier: { lockMinutes: 5, idleSignOutMinutes: 30, maxHours: 12 } } });   // restore

    const events = await request(app).get('/api/security/events?limit=5').set(auth(admin.token));
    expect(events.status).toBe(200);
    expect(events.body.data.length).toBeGreaterThan(0);
  });

  it('is for admins only', async () => {
    const m = makeUser({ role: 'manager' });
    const s = await signIn(m.email);
    expect((await request(app).get('/api/security/policy').set(auth(s.token))).status).toBe(403);
  });
});
