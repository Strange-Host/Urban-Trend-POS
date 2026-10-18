const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(() => cleanupTestDb());

describe('leads', () => {
  it('creates a lead and detects a duplicate by phone number', async () => {
    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Duplicate Test', phone: '0722000001', source: 'walk_in' });
    expect(createRes.status).toBe(201);

    const dupRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Someone Else', phone: '0722000001', source: 'whatsapp' });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.details.existingLeadId).toBe(createRes.body.data.id);
  });

  it('rejects an unknown source', async () => {
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Source', phone: '0722000002', source: 'carrier_pigeon' });
    expect(res.status).toBe(400);
  });

  it('follows the status state machine — legal transitions succeed, illegal ones are rejected', async () => {
    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'State Machine Test', phone: '0722000003', source: 'walk_in' });
    const leadId = createRes.body.data.id;

    // new -> converted is not a legal direct transition (must go through contacted).
    const badRes = await request(app).patch(`/api/leads/${leadId}/status`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'converted' });
    expect(badRes.status).toBe(409);

    // new -> contacted is legal.
    const okRes = await request(app).patch(`/api/leads/${leadId}/status`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'contacted' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.status).toBe('contacted');

    // contacted -> converted is legal.
    const convertRes = await request(app).patch(`/api/leads/${leadId}/status`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'converted' });
    expect(convertRes.status).toBe(200);

    // converted is terminal — nothing moves out of it.
    const terminalRes = await request(app).patch(`/api/leads/${leadId}/status`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'contacted' });
    expect(terminalRes.status).toBe(409);
  });

  it('requires a follow_up_date when moving to rescheduled', async () => {
    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Reschedule Test', phone: '0722000004', source: 'walk_in' });
    const leadId = createRes.body.data.id;
    await request(app).patch(`/api/leads/${leadId}/status`).set('Authorization', `Bearer ${token}`).send({ status: 'contacted' });

    const noDateRes = await request(app).patch(`/api/leads/${leadId}/status`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'rescheduled' });
    expect(noDateRes.status).toBe(400);

    const withDateRes = await request(app).patch(`/api/leads/${leadId}/status`).set('Authorization', `Bearer ${token}`)
      .send({ status: 'rescheduled', follow_up_date: '2026-12-01' });
    expect(withDateRes.status).toBe(200);
  });

  it('logs an activity and records it in getById', async () => {
    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Activity Test', phone: '0722000005', source: 'walk_in' });
    const leadId = createRes.body.data.id;

    const activityRes = await request(app).post(`/api/leads/${leadId}/activities`).set('Authorization', `Bearer ${token}`)
      .send({ type: 'call', content: 'Left a voicemail' });
    expect(activityRes.status).toBe(201);

    const getRes = await request(app).get(`/api/leads/${leadId}`).set('Authorization', `Bearer ${token}`);
    expect(getRes.body.data.activities.some((a) => a.content === 'Left a voicemail')).toBe(true);
    // Status changes auto-log too — going new->contacted earlier tests
    // already proved that indirectly; here just confirm the shape exists.
    expect(Array.isArray(getRes.body.data.status_history)).toBe(true);
  });

  it('a cashier only sees and can only act on their own assigned leads', async () => {
    const staffRes = await request(app).post('/api/staff').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cashier Leads Test', email: 'cashier-leads@urbantrends.com', phone: '0722000006', password: 'Orchid-Summit-1930', role: 'cashier' });
    const cashierId = staffRes.body.data.id;
    const cashierLogin = await request(app).post('/api/auth/login').send({ email: 'cashier-leads@urbantrends.com', password: 'Orchid-Summit-1930' });
    const cashierToken = cashierLogin.body.token;

    // A lead assigned to someone else...
    const otherLeadRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Not This Cashiers Lead', phone: '0722000007', source: 'walk_in' });

    // ...the cashier can't see it in their list...
    const listRes = await request(app).get('/api/leads').set('Authorization', `Bearer ${cashierToken}`);
    expect(listRes.body.data.some((l) => l.id === otherLeadRes.body.data.id)).toBe(false);

    // ...nor change its status — 403, not 404, matching the original
    // controller's behavior: the lead genuinely exists, it's just not theirs.
    const statusRes = await request(app).patch(`/api/leads/${otherLeadRes.body.data.id}/status`).set('Authorization', `Bearer ${cashierToken}`)
      .send({ status: 'contacted' });
    expect(statusRes.status).toBe(403);

    // A lead actually assigned to them works fine.
    const ownLeadRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'This Cashiers Lead', phone: '0722000008', source: 'walk_in', assigned_staff_id: cashierId });
    const ownStatusRes = await request(app).patch(`/api/leads/${ownLeadRes.body.data.id}/status`).set('Authorization', `Bearer ${cashierToken}`)
      .send({ status: 'contacted' });
    expect(ownStatusRes.status).toBe(200);
  });

  it('soft-deletes a lead', async () => {
    const createRes = await request(app).post('/api/leads').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Delete Test', phone: '0722000009', source: 'walk_in' });
    const deleteRes = await request(app).delete(`/api/leads/${createRes.body.data.id}`).set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    const getRes = await request(app).get(`/api/leads/${createRes.body.data.id}`).set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(404);
  });
});
