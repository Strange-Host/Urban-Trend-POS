const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const payroll = require('../src/services/payroll.service');
const settingsService = require('../src/services/settings.service');
const distribution = require('../src/services/telesalesDistribution.service');
const attendanceService = require('../src/services/attendance.service');

let adminToken;
let managerToken;
let n = 0;

const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });
const BOTH = { confirm_all_dispatched: true, confirm_nairobi_reconciled: true };

async function makeStaff(name, role = 'cashier') {
  n += 1;
  const email = `gate${n}@urbantrends.com`;
  const created = await request(app).post('/api/staff').set(auth())
    .send({ name, email, phone: `07230008${String(n).padStart(2, '0')}`, password: 'Marble-Thistle-4678', role });
  expect(created.status).toBe(201);
  const token = (await request(app).post('/api/auth/login').send({ email, password: 'Marble-Thistle-4678' })).body.token;
  return { id: created.body.data.id, token, name };
}

async function makeRep(name) {
  const rep = await makeStaff(name);
  await request(app).post('/api/attendance/clock-in').set(auth(rep.token));
  return rep;
}

// An order assigned to the rep. 'prepaid' stays awaiting dispatch until someone dispatches it.
async function assignedOrder(rep, { city = 'Nairobi', dispatch = false } = {}) {
  n += 1;
  const pid = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES (?, 'Gate Product', 100, 3000, 1)`).run(`GATE-${n}-${Date.now()}`).lastInsertRowid;
  db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, 50)').run(pid);
  const created = await request(app).post('/api/orders').set(auth()).send({
    name: 'Gate Customer', phone: `07450008${String(n).padStart(2, '0')}`, city, payment_type: 'prepaid',
    assigned_staff_id: rep.id, items: [{ product_id: pid, quantity: 1 }],
  });
  expect(created.status).toBe(201);
  if (dispatch) {
    const d = await request(app).post(`/api/orders/${created.body.data.id}/dispatch`).set(auth()).send({ delivery_fee_paid: false });
    expect(d.status).toBeLessThan(300);
  }
  return created.body.data;
}

const clockOut = (rep, body) => request(app).post('/api/attendance/clock-out').set(auth(rep.token)).send(body);
const handoverRows = (staffId) => db.prepare('SELECT * FROM shift_handovers WHERE staff_id = ? ORDER BY id').all(staffId);
const setGateMode = (mode) => db.prepare(`INSERT INTO settings (key, value) VALUES ('clockout_gate_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(mode);

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  managerToken = (await makeStaff('Gate Manager', 'manager')).token;
});

afterAll(() => cleanupTestDb());

describe('clock-out gate', () => {
  it('refuses a clock-out without the two confirmations, and leaves the person clocked in', async () => {
    const rep = await makeRep('Gate Rep NoTick');
    const res = await clockOut(rep, {});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CLOCKOUT_CONFIRMATION_REQUIRED');
    expect(handoverRows(rep.id)).toHaveLength(0);

    const half = await clockOut(rep, { confirm_all_dispatched: true });
    expect(half.status).toBe(422);

    // Still clocked in, so a proper clock-out works afterwards.
    expect((await clockOut(rep, BOTH)).status).toBe(200);
  });

  it('a clean clock-out stores a handover record even without a note', async () => {
    const rep = await makeRep('Gate Rep Clean');
    const res = await clockOut(rep, BOTH);
    expect(res.status).toBe(200);
    const rows = handoverRows(rep.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: 'clock_out', notes: null, dispatch_confirmed: 1, nairobi_confirmed: 1, undispatched_count: 0 });
  });

  it('refuses a false confirmation: "all dispatched" while an assigned order is still waiting', async () => {
    const rep = await makeRep('Gate Rep Liar');
    await assignedOrder(rep);
    const handover = await request(app).get('/api/shift/handover').set(auth(rep.token));
    expect(handover.body.data.undispatched_orders.count).toBe(1);
    expect(handover.body.data.gate).toMatchObject({ can_confirm_dispatched: false, can_confirm_nairobi: true, reason_required: true, blocked: false });

    const res = await clockOut(rep, { ...BOTH, handover_notes: 'Everything went out today' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CLOCKOUT_CONFIRMATION_FALSE');
    expect(handoverRows(rep.id)).toHaveLength(0);
  });

  it('with something open, a written reason lets them leave and is recorded as an exception', async () => {
    const rep = await makeRep('Gate Rep Reason');
    await assignedOrder(rep);

    const none = await clockOut(rep, { confirm_nairobi_reconciled: true });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('CLOCKOUT_REASON_REQUIRED');
    const short = await clockOut(rep, { confirm_nairobi_reconciled: true, handover_notes: 'later' });
    expect(short.status).toBe(422);

    const ok = await clockOut(rep, { confirm_nairobi_reconciled: true, handover_notes: 'Courier did not collect it before 5pm' });
    expect(ok.status).toBe(200);
    const [row] = handoverRows(rep.id);
    expect(row).toMatchObject({ dispatch_confirmed: 0, nairobi_confirmed: 1, undispatched_count: 1, notes: 'Courier did not collect it before 5pm' });
    const alerts = db.prepare(`SELECT * FROM notifications WHERE type = 'shift_handover' AND title LIKE ?`).all('%Gate Rep Reason%');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].body).toContain('1 order(s) not dispatched');
  });

  it('an unpaid dispatched Nairobi parcel stops the Nairobi confirmation', async () => {
    const rep = await makeRep('Gate Rep Nairobi');
    await assignedOrder(rep, { dispatch: true });
    const g = (await request(app).get('/api/shift/handover').set(auth(rep.token))).body.data;
    expect(g.nairobi_unpaid.count).toBe(1);
    expect(g.gate).toMatchObject({ can_confirm_dispatched: true, can_confirm_nairobi: false, reason_required: true });

    expect((await clockOut(rep, BOTH)).status).toBe(422);
    const ok = await clockOut(rep, { confirm_all_dispatched: true, handover_notes: 'Rider collects cash tomorrow morning' });
    expect(ok.status).toBe(200);
    expect(handoverRows(rep.id)[0]).toMatchObject({ dispatch_confirmed: 1, nairobi_confirmed: 0, nairobi_unpaid_count: 1 });
  });

  it('block mode keeps them in until it is cleared, reason or not', async () => {
    setGateMode('block');
    try {
      const rep = await makeRep('Gate Rep Blocked');
      await assignedOrder(rep);
      const g = (await request(app).get('/api/shift/handover').set(auth(rep.token))).body.data;
      expect(g.gate).toMatchObject({ mode: 'block', blocked: true });

      const res = await clockOut(rep, { confirm_nairobi_reconciled: true, handover_notes: 'I would like to go home now please' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CLOCKOUT_BLOCKED');
      expect(handoverRows(rep.id)).toHaveLength(0);

      // someone with nothing open is unaffected
      const clean = await makeRep('Gate Rep Block Clean');
      expect((await clockOut(clean, BOTH)).status).toBe(200);
    } finally {
      setGateMode('reason');
    }
  });

  it('answers "not clocked in" with 409 rather than gate errors', async () => {
    const rep = await makeStaff('Gate Rep Never In');
    expect((await clockOut(rep, BOTH)).status).toBe(409);
  });

  it('the gate mode setting only accepts reason or block', async () => {
    const bad = await request(app).put('/api/settings').set(auth()).send({ clockout_gate_mode: 'sometimes' });
    expect(bad.status).toBe(400);
  });
});

describe('end-of-day review', () => {
  const DAY = '2026-10-20';
  let early;
  let late;

  beforeAll(async () => {
    early = await makeStaff('EOD Early');
    late = await makeStaff('EOD Late');
    const seat = db.prepare('INSERT INTO staff_attendance (staff_id, store_id, work_date, clock_in_at, clock_out_at) VALUES (?, 1, ?, ?, ?)');
    seat.run(early.id, DAY, '2026-10-20 05:00:00', '2026-10-20 14:00:00'); // 08:00 - 17:00 on the shop clock
    seat.run(late.id, DAY, '2026-10-20 07:30:00', '2026-10-20 14:00:00'); // 10:30 on the shop clock: 3 hours late
    const sh = db.prepare(`INSERT INTO shift_handovers (store_id, staff_id, work_date, trigger, notes, dispatch_confirmed, nairobi_confirmed, undispatched_count)
                           VALUES (1, ?, ?, 'clock_out', ?, ?, ?, ?)`);
    sh.run(early.id, DAY, null, 1, 1, 0);
    sh.run(late.id, DAY, 'Two parcels waiting on the courier', 0, 1, 2);
    db.prepare(`INSERT INTO assignment_moves (store_id, entity_type, entity_id, from_staff_id, to_staff_id, reason, work_date)
                VALUES (1, 'lead', 1, ?, ?, 'not_clocked_in', ?)`).run(late.id, early.id, DAY);
  });

  it('is visible to managers, not to cashiers', async () => {
    expect((await request(app).get('/api/end-of-day').set(auth(early.token))).status).toBe(403);
    expect((await request(app).post('/api/end-of-day/approve').set(auth(early.token)).send({ date: DAY })).status).toBe(403);
    expect((await request(app).get('/api/end-of-day').set(auth(managerToken))).status).toBe(200);
  });

  it('puts attendance, reassignments and notes on one screen', async () => {
    const res = await request(app).get(`/api/end-of-day?date=${DAY}`).set(auth(managerToken));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.work_date).toBe(DAY);
    expect(d.attendance.find((r) => r.staff_id === early.id)).toMatchObject({ status: 'present', hours_late: 0 });
    expect(d.attendance.find((r) => r.staff_id === late.id)).toMatchObject({ status: 'present', hours_late: 3 });
    expect(d.attendance.some((r) => r.status === 'absent')).toBe(true); // everyone else seeded in this file never clocked in that day
    expect(d.moves).toHaveLength(1);
    expect(d.moves[0]).toMatchObject({ from_name: 'EOD Late', to_name: 'EOD Early', reason: 'not_clocked_in' });
    const note = d.handovers.find((h) => h.staff_id === late.id);
    expect(note).toMatchObject({ notes: 'Two parcels waiting on the courier', has_exception: true });
    expect(d.handovers.find((h) => h.staff_id === early.id).has_exception).toBe(false);
    expect(d.summary).toMatchObject({ reassigned: 1, handover_exceptions: 1, notes: 1, late: 1 });
    expect(d.needs_acknowledgement).toBe(true);
    expect(d.review).toBeNull();
  });

  it('flags someone who clocked out with no handover on file', async () => {
    const ghost = await makeStaff('EOD Ghost');
    db.prepare('INSERT INTO staff_attendance (staff_id, store_id, work_date, clock_in_at, clock_out_at) VALUES (?, 1, ?, ?, ?)').run(ghost.id, DAY, '2026-10-20 05:00:00', '2026-10-20 14:00:00');
    const d = (await request(app).get(`/api/end-of-day?date=${DAY}`).set(auth(managerToken))).body.data;
    expect(d.no_handover.map((x) => x.name)).toContain('EOD Ghost');
  });

  it('will not approve while someone is still clocked in', async () => {
    const stay = await makeStaff('EOD Stayer');
    const day = '2026-10-21';
    db.prepare('INSERT INTO staff_attendance (staff_id, store_id, work_date, clock_in_at) VALUES (?, 1, ?, ?)').run(stay.id, day, '2026-10-21 05:00:00');
    const res = await request(app).post('/api/end-of-day/approve').set(auth(managerToken)).send({ date: day, acknowledged: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EOD_STAFF_STILL_CLOCKED_IN');
    expect(res.body.error.message).toContain('EOD Stayer');
  });

  it('will not approve a future day', async () => {
    const res = await request(app).post('/api/end-of-day/approve').set(auth(managerToken)).send({ date: '2999-01-01', acknowledged: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EOD_FUTURE_DATE');
  });

  it('rejects a malformed date', async () => {
    expect((await request(app).get('/api/end-of-day?date=yesterday').set(auth(managerToken))).status).toBe(400);
  });

  it('needs the manager to say they reviewed it when there is something to review, then approves once', async () => {
    const without = await request(app).post('/api/end-of-day/approve').set(auth(managerToken)).send({ date: DAY });
    expect(without.status).toBe(422);
    expect(without.body.error.code).toBe('EOD_ACKNOWLEDGEMENT_REQUIRED');

    const ok = await request(app).post('/api/end-of-day/approve').set(auth(managerToken)).send({ date: DAY, acknowledged: true, note: 'Spoke to the late rep' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.review).toMatchObject({ work_date: DAY, note: 'Spoke to the late rep', reviewed_by_name: 'Gate Manager' });

    const row = db.prepare('SELECT * FROM end_of_day_reviews WHERE work_date = ?').get(DAY);
    expect(JSON.parse(row.snapshot).moves).toHaveLength(1); // what the manager was looking at is kept
    const log = db.prepare(`SELECT * FROM staff_logs WHERE entity_type = 'end_of_day_review' AND entity_id = ?`).get(row.id);
    expect(log).toBeTruthy();

    const again = await request(app).post('/api/end-of-day/approve').set(auth(adminToken)).send({ date: DAY, acknowledged: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EOD_ALREADY_APPROVED');
  });

  it('records the reassignments the automatic distribution makes', async () => {
    const absent = await makeStaff('EOD Absent Rep');         // never clocks in
    await makeRep('EOD Present Rep');                         // clocked in, so eligible to take work
    const order = await assignedOrder(absent);

    const moved = distribution.rebalanceStaleAssignments({ storeId: 1, cutoffHour: 0 });
    expect(moved.orders.map((o) => o.id)).toContain(order.id);

    // It goes to whichever clocked-in rep has the lightest load, so check the record against the order itself.
    const move = db.prepare(`SELECT * FROM assignment_moves WHERE entity_type = 'order' AND entity_id = ?`).get(order.id);
    const nowOwner = db.prepare('SELECT assigned_staff_id FROM orders WHERE id = ?').get(order.id).assigned_staff_id;
    expect(move).toMatchObject({ from_staff_id: absent.id, reason: 'not_clocked_in', work_date: attendanceService.todayDate() });
    expect(move.to_staff_id).toBe(nowOwner);
    expect(nowOwner).not.toBe(absent.id);

    const d = (await request(app).get('/api/end-of-day').set(auth(managerToken))).body.data;
    const shown = d.moves.find((m) => m.entity_id === order.id && m.entity_type === 'order');
    expect(shown).toMatchObject({ from_name: 'EOD Absent Rep', to_staff_id: nowOwner });
    expect(shown.to_name).toBeTruthy();
  });
});

describe('a missed day is charged once', () => {
  it('a no-show earns no retainer and nothing is deducted on top at the default 300 / 300', async () => {
    const rep = await makeStaff('Once Rep');
    const ins = db.prepare('INSERT INTO staff_attendance (staff_id, store_id, work_date, clock_in_at, clock_out_at) VALUES (?, 1, ?, ?, ?)');
    ins.run(rep.id, '2026-03-10', '2026-03-10 05:00:00', '2026-03-10 14:00:00'); // worked 08:00-17:00
    ins.run(rep.id, '2026-03-11', null, null);                                  // no-show row

    const settings = settingsService.getAll();
    expect(settings.attendance_absence_fee_kes).toBe('300');
    expect(settings.daily_retainer_kes).toBe('300');

    const c = payroll.calculateStaff({ staffId: rep.id, storeId: 1, periodStart: '2026-03-01', periodEnd: '2026-03-31', settings });
    expect(c.dailyRetainer).toMatchObject({ daysLoggedIn: 1, total: 30000 }); // retainer only for the day worked
    expect(c.attendance.absenceTotal).toBe(0);                                // and the missed day is not charged again
    expect(c.totalDeductions).toBe(0);
    expect(c.netPayable).toBe(30000);
  });

  it('a higher absence fee deducts only the part the lost retainer does not cover', () => {
    const rep = db.prepare(`SELECT id FROM users WHERE name = 'Once Rep'`).get();
    const base = settingsService.getAll();
    const at = (fee, retainer) => payroll.computeAttendanceDeductions({
      staffId: rep.id, periodStart: '2026-03-01', periodEnd: '2026-03-31',
      settings: { ...base, attendance_absence_fee_kes: String(fee), daily_retainer_kes: String(retainer) },
    }).absenceTotal;

    expect(at(500, 300)).toBe(20000); // 500 in total: 300 is the retainer not earned, 200 more is deducted
    expect(at(300, 300)).toBe(0);
    expect(at(100, 300)).toBe(0);     // never negative: a small fee cannot pay the person for staying away
    expect(at(0, 300)).toBe(0);
  });
});
