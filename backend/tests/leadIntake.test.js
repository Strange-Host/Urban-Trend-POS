process.env.LEAD_INTAKE_SECRET = 'intake-secret-for-tests';

const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const intakeService = require('../src/services/leadIntake.service');

let adminToken;
let rep;
let product;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const URL = '/api/integrations/leads/intake';
const post = (body, secret = 'intake-secret-for-tests') => request(app).post(URL).set('X-Intake-Secret', secret).send(body);

// The shape WPForms' webhook sends (field labels copied from the older system's controller).
function wpForm(overrides = {}) {
  return {
    formId: 12, formName: 'Leather Office Chair', wpEntryId: 501,
    fields: {
      Name: 'Grace Wanjiku', 'Phone Number': '0722 333 444', 'Alternative Phone Number': '0733 111 222',
      Location: 'Kasarani, Nairobi',
      'Additional information or any Enquiry. (e.g. exact address, number of pieces).': 'Two chairs please, near the stage',
      'Available Colors': 'Black', 'Choose size': 'Large',
    },
    ...overrides,
  };
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  rep = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Route Rep', 'rep-intake@urbantrends.com', ?, 'cashier', 1)`)
    .run(store.id, bcrypt.hashSync('Passw0rd!Passw0rd', 10)).lastInsertRowid;
  product = (await request(app).get('/api/products?pageSize=1').set(auth(adminToken))).body.data[0];
});

afterAll(() => cleanupTestDb());

describe('lead intake — authentication', () => {
  it('rejects a missing or wrong secret (the older system accepted anyone)', async () => {
    expect((await request(app).post(URL).send(wpForm())).status).toBe(401);
    expect((await post(wpForm(), 'wrong-secret')).status).toBe(401);
    expect((await post(wpForm(), '')).status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n).toBe(0);
  });

  it('fails closed when no secret is configured', async () => {
    const saved = process.env.LEAD_INTAKE_SECRET;
    delete process.env.LEAD_INTAKE_SECRET;
    expect((await post(wpForm())).status).toBe(503);
    process.env.LEAD_INTAKE_SECRET = saved;
  });

  it('the secret travels in a header, never in the URL', async () => {
    expect((await request(app).post(`${URL}/intake-secret-for-tests`).send(wpForm())).status).toBe(404);
  });
});

describe('lead intake — parsing a WPForms submission', () => {
  it('creates a lead with the customer\'s details in readable notes and the raw payload kept', async () => {
    const res = await post(wpForm());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('created');
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(res.body.leadId);
    expect(lead).toMatchObject({ name: 'Grace Wanjiku', phone: '0722 333 444', source: 'other', form_name: 'Leather Office Chair', external_id: '12-501' });
    expect(lead.notes).toContain('Web form: Leather Office Chair');
    expect(lead.notes).toContain('Location: Kasarani, Nairobi');
    expect(lead.notes).toContain('Alternative phone: 0733 111 222');
    expect(lead.notes).toContain('Available Colors: Black');
    expect(lead.notes).toContain('Choose size: Large');
    expect(lead.notes).toContain('Customer said: Two chairs please, near the stage');
    expect(JSON.parse(lead.raw_payload).fields.Name).toBe('Grace Wanjiku');
  });

  it('builds the name from First + Last, and falls back to "Website lead"', () => {
    expect(intakeService.parsePayload({ fields: { First: 'Jo', Last: 'Mwangi', 'Phone Number': '0711000111' } }).name).toBe('Jo Mwangi');
    expect(intakeService.parsePayload({ fields: { 'Phone Number': '0711000111' } }).name).toBeNull();
  });

  it('accepts a flat payload too', async () => {
    const res = await post({ name: 'Flat Person', phone: '0711 000 222', email: 'flat@example.com', message: 'Call me', form_name: 'Contact', entry_id: 9 });
    expect(res.status).toBe(201);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(res.body.leadId);
    expect(lead).toMatchObject({ name: 'Flat Person', email: 'flat@example.com', external_id: 'form-9' });
    expect(lead.notes).toContain('Customer said: Call me');
  });

  it('a Shopify-tagged payload is recorded with source "shopify"', async () => {
    const res = await post({ source: 'shopify', name: 'Shop Person', phone: '0711 000 333', entry_id: 77 });
    expect(db.prepare('SELECT source FROM leads WHERE id = ?').get(res.body.leadId).source).toBe('shopify');
  });

  it('rejects a submission with no usable phone number (400) without creating anything', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
    expect((await post({ fields: { Name: 'No Phone' } })).status).toBe(400);
    expect((await post({ fields: { Name: 'Bad Phone', 'Phone Number': '12' } })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n).toBe(before);
  });
});

describe('lead intake — idempotency and repeat customers', () => {
  it('a redelivered webhook (same form entry) is a no-op that still answers 200', async () => {
    const first = await post(wpForm({ wpEntryId: 600, fields: { Name: 'Replay Person', 'Phone Number': '0700 600 600' } }));
    const count = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
    const again = await post(wpForm({ wpEntryId: 600, fields: { Name: 'Replay Person', 'Phone Number': '0700 600 600' } }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: 'replay', leadId: first.body.leadId });
    expect(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n).toBe(count);
  });

  it('the same phone on a NEW entry never creates a second lead — it lands on the existing lead\'s timeline and tells its owner', async () => {
    await request(app).put(`/api/leads/${(await post(wpForm({ wpEntryId: 700, fields: { Name: 'Repeat Buyer', 'Phone Number': '0700 700 700' } }))).body.leadId}`)
      .set(auth(adminToken)).send({ assigned_staff_id: rep });
    const leadId = db.prepare(`SELECT id FROM leads WHERE phone_normalized = '700700700'`).get().id;
    db.prepare('UPDATE leads SET assigned_staff_id = ? WHERE id = ?').run(rep, leadId);

    const before = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
    const res = await post(wpForm({ wpEntryId: 701, formName: 'Wooden Desk', fields: { Name: 'Repeat Buyer', 'Phone Number': '+254 700 700 700', Location: 'Thika' } }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'existing_lead', leadId });
    expect(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n).toBe(before);

    const activity = db.prepare(`SELECT * FROM lead_activities WHERE lead_id = ? AND type = 'note' ORDER BY id DESC`).get(leadId);
    expect(activity.content).toContain('Submitted a web form again');
    expect(activity.content).toContain('Wooden Desk');
    expect(activity.content).toContain('Thika');

    const notice = db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND type = 'lead_resubmitted'`).get(rep);
    expect(notice.title).toContain('Repeat Buyer');
    expect(notice.entity_id).toBe(leadId);
  });

  it('the old import is not duplicated if the form entry id is reused with a different phone', async () => {
    const a = await post(wpForm({ wpEntryId: 800, fields: { Name: 'Entry Eight', 'Phone Number': '0700 800 800' } }));
    const b = await post(wpForm({ wpEntryId: 800, fields: { Name: 'Entry Eight Edited', 'Phone Number': '0700 800 801' } }));
    expect(b.body.leadId).toBe(a.body.leadId);
  });
});

describe('lead intake — form routing', () => {
  it('only managers/admins can manage routes', async () => {
    const cashierLogin = await request(app).post('/api/auth/login').send({ email: 'rep-intake@urbantrends.com', password: 'Passw0rd!Passw0rd' });
    expect((await request(app).get('/api/integrations/leads/routes').set(auth(cashierLogin.body.token))).status).toBe(403);
    expect((await request(app).get('/api/integrations/leads/routes')).status).toBe(401);
  });

  it('a route links a form to a product and a fixed rep; matching ignores case and spacing', async () => {
    const created = await request(app).post('/api/integrations/leads/routes').set(auth(adminToken))
      .send({ form_name: 'Leather Office Chair', product_id: product.id, assigned_staff_id: rep });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ product_name: product.name, staff_name: 'Route Rep' });

    const res = await post(wpForm({ wpEntryId: 900, formName: '  leather OFFICE chair ', fields: { Name: 'Routed Lead', 'Phone Number': '0700 900 900' } }));
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(res.body.leadId);
    expect(lead.assigned_staff_id).toBe(rep);
    expect(lead.interested_product_id).toBe(product.id);
    expect(lead.notes).toContain(`Interested in: ${product.name}`);
    expect(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'lead_assigned' AND entity_id = ?`).get(rep, lead.id)).toBeTruthy();
  });

  it('an unrouted form still creates a lead (equal distribution applies)', async () => {
    const res = await post(wpForm({ wpEntryId: 901, formName: 'Some Other Form', fields: { Name: 'Unrouted', 'Phone Number': '0700 901 901' } }));
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT interested_product_id FROM leads WHERE id = ?').get(res.body.leadId).interested_product_id).toBeNull();
  });

  it('an inactive route, or one pointing at a deactivated rep, falls back gracefully', async () => {
    const route = (await request(app).get('/api/integrations/leads/routes').set(auth(adminToken))).body.data[0];
    await request(app).patch(`/api/integrations/leads/routes/${route.id}`).set(auth(adminToken)).send({ is_active: false });
    const off = await post(wpForm({ wpEntryId: 902, fields: { Name: 'Inactive Route', 'Phone Number': '0700 902 902' } }));
    expect(db.prepare('SELECT interested_product_id FROM leads WHERE id = ?').get(off.body.leadId).interested_product_id).toBeNull();

    await request(app).patch(`/api/integrations/leads/routes/${route.id}`).set(auth(adminToken)).send({ is_active: true });
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(rep);
    const res = await post(wpForm({ wpEntryId: 903, fields: { Name: 'Gone Rep', 'Phone Number': '0700 903 903' } }));
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT assigned_staff_id FROM leads WHERE id = ?').get(res.body.leadId).assigned_staff_id).not.toBe(rep);
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(rep);
  });

  it('validates route input and rejects duplicates and unknown targets', async () => {
    const make = (body) => request(app).post('/api/integrations/leads/routes').set(auth(adminToken)).send(body);
    expect((await make({ form_name: '' })).status).toBe(400);
    expect((await make({ form_name: 'LEATHER OFFICE CHAIR' })).status).toBe(409);
    expect((await make({ form_name: 'Bad Product', product_id: 99999 })).status).toBe(404);
    expect((await make({ form_name: 'Bad Rep', assigned_staff_id: 99999 })).status).toBe(404);
  });

  it('deleting a route stops routing', async () => {
    const route = (await request(app).get('/api/integrations/leads/routes').set(auth(adminToken))).body.data[0];
    expect((await request(app).delete(`/api/integrations/leads/routes/${route.id}`).set(auth(adminToken))).status).toBe(200);
    expect((await request(app).get('/api/integrations/leads/routes').set(auth(adminToken))).body.data).toHaveLength(0);
    expect((await request(app).delete('/api/integrations/leads/routes/99999').set(auth(adminToken))).status).toBe(404);
  });
});
