const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let adminToken;

beforeAll(async () => {
  adminToken = await loginAsAdmin();
});

afterAll(() => cleanupTestDb());

describe('employee onboarding (Phase 7)', () => {
  it('creates a new hire inactive and pending_documents', async () => {
    const res = await request(app).post('/api/employees/onboard').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'New Hire', email: 'newhire@urbantrends.com', phone: '0744900001', password: 'HirePass123!', role: 'cashier' });
    expect(res.status).toBe(201);
    expect(res.body.data.is_active).toBe(0);
    expect(res.body.data.onboarding_status).toBe('pending_documents');
  });

  it('cannot sign the agreement before all documents are uploaded', async () => {
    const onboardRes = await request(app).post('/api/employees/onboard').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Hire Two', email: 'hire2@urbantrends.com', phone: '0744900002', password: 'HirePass123!', role: 'cashier' });
    const employeeId = onboardRes.body.data.id;

    const signRes = await request(app).post(`/api/employees/${employeeId}/sign-agreement`).set('Authorization', `Bearer ${adminToken}`)
      .send({ signed_name: 'Hire Two' });
    expect(signRes.status).toBe(409);
  });

  it('advances to pending_signature once all three documents are uploaded, then activates on signature', async () => {
    const onboardRes = await request(app).post('/api/employees/onboard').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Hire Three', email: 'hire3@urbantrends.com', phone: '0744900003', password: 'HirePass123!', role: 'cashier' });
    const employeeId = onboardRes.body.data.id;

    for (const docType of ['national_id', 'cv']) {
      const res = await request(app).post(`/api/employees/${employeeId}/documents`).set('Authorization', `Bearer ${adminToken}`)
        .send({ doc_type: docType, file_reference: `https://files.example.com/${docType}.pdf` });
      expect(res.status).toBe(201);
      expect(res.body.data.onboarding_status).toBe('pending_documents'); // not all 3 yet
    }

    const lastDocRes = await request(app).post(`/api/employees/${employeeId}/documents`).set('Authorization', `Bearer ${adminToken}`)
      .send({ doc_type: 'contract', file_reference: 'https://files.example.com/contract.pdf' });
    expect(lastDocRes.body.data.onboarding_status).toBe('pending_signature');
    expect(lastDocRes.body.data.missingDocs).toEqual([]);

    const signRes = await request(app).post(`/api/employees/${employeeId}/sign-agreement`).set('Authorization', `Bearer ${adminToken}`)
      .send({ signed_name: 'Hire Three' });
    expect(signRes.status).toBe(200);
    expect(signRes.body.data.onboarding_status).toBe('active');
    expect(signRes.body.data.is_active).toBe(1);

    // The now-active new hire can actually log in.
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'hire3@urbantrends.com', password: 'HirePass123!' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeTruthy();
  });

  it('rejects an invalid doc_type', async () => {
    const onboardRes = await request(app).post('/api/employees/onboard').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Hire Four', email: 'hire4@urbantrends.com', phone: '0744900004', password: 'HirePass123!', role: 'cashier' });
    const res = await request(app).post(`/api/employees/${onboardRes.body.data.id}/documents`).set('Authorization', `Bearer ${adminToken}`)
      .send({ doc_type: 'passport', file_reference: 'https://files.example.com/x.pdf' });
    expect(res.status).toBe(400);
  });

  it('does not affect the plain POST /api/staff endpoint (still immediately active)', async () => {
    const res = await request(app).post('/api/staff').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Quick Admin Hire', email: 'quickhire@urbantrends.com', phone: '0744900005', password: 'QuickPass123!', role: 'cashier' });
    expect(res.status).toBe(201);
    // The plain staff endpoint's response shape doesn't even carry onboarding_status/is_active
    // as a gate — it's the same immediately-usable account creation as before this phase.
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'quickhire@urbantrends.com', password: 'QuickPass123!' });
    expect(loginRes.status).toBe(200);
  });
});
