const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');
const modules = require('../src/services/modules.service');

beforeAll(async () => { await H.loginAsAdmin(); });
afterAll(() => cleanupTestDb());

const me = (u) => request(app).get('/api/v1/attendance/me').set(auth(u));
const clockIn = (u, body = { confirm: true }) => request(app).post('/api/v1/attendance/clock-in').set(auth(u)).send(body);
const clockOut = (u, body = {}) => request(app).post('/api/v1/attendance/clock-out').set(auth(u)).send(body);
const CLEAR = { confirmAllDispatched: true, confirmNairobiReconciled: true };

describe('my shift', () => {
  it('goes not_started -> clocked_in -> clocked_out, and a second clock-in or clock-out is refused', async () => {
    const u = await H.makeUser('cashier', 'att-happy');
    expect((await me(u)).body).toMatchObject({ status: 'not_started', clockInAt: null, clockOutAt: null, gate: null });

    const noConfirm = await clockIn(u, {});
    expect(noConfirm.status).toBe(400); expect(noConfirm.body.error.code).toBe('CONFIRM_REQUIRED');
    expect((await me(u)).body.status).toBe('not_started');

    const inRes = await clockIn(u);
    expect(inRes.status).toBe(201);
    expect(inRes.body).toMatchObject({ status: 'clocked_in', clockOutAt: null });
    expect(inRes.body.clockInAt).toMatch(/Z$/);
    expect(inRes.body.gate).toMatchObject({ blocked: false, canConfirmDispatched: true, undispatchedOrders: 0 });
    const dup = await clockIn(u);
    expect(dup.status).toBe(409); expect(dup.body.error.code).toBe('ALREADY_CLOCKED_IN');
    expect(db.prepare('SELECT COUNT(*) c FROM staff_attendance WHERE staff_id = ?').get(u.id).c).toBe(1);

    const out = await clockOut(u, { ...CLEAR, handoverNotes: 'All quiet' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'clocked_out', gate: null });
    expect(out.body.clockOutAt).toMatch(/Z$/);
    const again = await clockOut(u, CLEAR);
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('ALREADY_CLOCKED_OUT');
    expect((await me(u)).body.status).toBe('clocked_out');
    expect(db.prepare(`SELECT COUNT(*) c FROM shift_handovers WHERE staff_id = ?`).get(u.id).c).toBe(1);
    expect(H.lastLog('staff_attendance', db.prepare('SELECT id FROM staff_attendance WHERE staff_id = ?').get(u.id).id).changes.deviceId.to).toBe(u.sessionId);
  });

  it('cannot clock out without clocking in', async () => {
    const u = await H.makeUser('cashier', 'att-noin');
    const r = await clockOut(u, CLEAR);
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('NOT_CLOCKED_IN');
  });

  it('passes the existing clock-out gate codes through and stays clocked in on a refusal', async () => {
    const u = await H.makeUser('cashier', 'att-gate');
    await clockIn(u);
    const missing = await clockOut(u, {});
    expect(missing.status).toBe(422); expect(missing.body.error.code).toBe('CLOCKOUT_CONFIRMATION_REQUIRED');
    expect((await me(u)).body.status).toBe('clocked_in');

    // an order still waiting to be sent out, assigned to this person
    const p = H.makeProduct({ sell: 10000 });
    const customer = db.prepare(`INSERT INTO customers (name, phone, phone_normalized) VALUES ('Gate Cust', '0799000111', '799000111')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO orders (store_id, customer_id, assigned_staff_id, status, subtotal, total, product_code) VALUES (?, ?, ?, 'awaiting_dispatch', 10000, 10000, ?)`)
      .run(H.storeId(), customer, u.id, `UT${String(900000 + Math.floor(Math.random() * 99999))}`);
    const state = await me(u);
    expect(state.body.gate).toMatchObject({ undispatchedOrders: 1, canConfirmDispatched: false, reasonRequired: true });
    const lie = await clockOut(u, CLEAR);
    expect(lie.status).toBe(422); expect(lie.body.error.code).toBe('CLOCKOUT_CONFIRMATION_FALSE');
    const noReason = await clockOut(u, { confirmAllDispatched: false, confirmNairobiReconciled: true });
    expect(noReason.status).toBe(422); expect(noReason.body.error.code).toBe('CLOCKOUT_REASON_REQUIRED');
    expect((await me(u)).body.status).toBe('clocked_in');
    const ok = await clockOut(u, { confirmAllDispatched: false, confirmNairobiReconciled: true, handoverNotes: 'One order waits for the courier tomorrow' });
    expect(ok.status).toBe(200); expect(ok.body.status).toBe('clocked_out');
    void p;
  });

  it('needs a sign-in, and only ever acts on yourself', async () => {
    expect((await request(app).get('/api/v1/attendance/me')).status).toBe(401);
    const a = await H.makeUser('cashier', 'att-a'); const b = await H.makeUser('cashier', 'att-b');
    await clockIn(a);
    expect((await me(b)).body.status).toBe('not_started');
    expect(db.prepare('SELECT COUNT(*) c FROM staff_attendance WHERE staff_id = ?').get(b.id).c).toBe(0);
  });

  it('follows the HR module switch like the website', async () => {
    const u = await H.makeUser('cashier', 'att-module');
    const settings = require('../src/services/settings.service');
    settings.setMany({ module_hr_enabled: '0' }, u.id);
    try {
      const r = await me(u);
      expect(r.status).toBe(404); expect(r.body.error.code).toBe('MODULE_DISABLED');
    } finally { settings.setMany({ module_hr_enabled: '1' }, u.id); }
    expect(modules.isEnabled('hr')).toBe(true);
    expect((await me(u)).status).toBe(200);
  });
});
