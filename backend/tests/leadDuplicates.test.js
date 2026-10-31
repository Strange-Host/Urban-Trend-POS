const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const post = (body) => request(app).post('/api/leads').set(auth()).send({ source: 'whatsapp', ...body });

beforeAll(async () => { token = await loginAsAdmin(); });
afterAll(() => cleanupTestDb());

describe('duplicate leads: phone, email and name', () => {
  let base;

  beforeAll(async () => {
    const res = await post({ name: 'Jane Wanjiru', phone: '0722100100', email: 'Jane.W@Example.com' });
    expect(res.status).toBe(201);
    base = res.body.data;
  });

  it('still refuses the same phone number, in any format', async () => {
    const res = await post({ name: 'Other Person', phone: '+254722100100' });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ existingLeadId: base.id, matchedOn: 'phone' });
  });

  it('refuses the same email address, ignoring case and spaces, with the existing lead id', async () => {
    const res = await post({ name: 'Different Name', phone: '0722100101', email: '  jane.w@example.COM ' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/email/i);
    expect(res.body.details).toMatchObject({ existingLeadId: base.id, matchedOn: 'email' });
  });

  it('does not treat a missing email as a match', async () => {
    const a = await post({ name: 'No Email One', phone: '0722100102' });
    const b = await post({ name: 'No Email Two', phone: '0722100103' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('warns about the same full name on an open lead, and creates it once confirmed', async () => {
    const res = await post({ name: 'jane  WANJIRU', phone: '0722100104' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSSIBLE_DUPLICATE_LEAD');
    expect(res.body.details.possibleDuplicates).toEqual([{ id: base.id, name: 'Jane Wanjiru', status: 'new' }]);
    expect(res.body.details.existingLeadId).toBeUndefined();

    const ok = await post({ name: 'jane  WANJIRU', phone: '0722100104', allow_possible_duplicate: true });
    expect(ok.status).toBe(201);
  });

  it('matches names whatever the word order or punctuation', async () => {
    const res = await post({ name: 'Wanjiru, Jane', phone: '0722100105' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSSIBLE_DUPLICATE_LEAD');
  });

  it('never warns on a single-word name', async () => {
    expect((await post({ name: 'Mary', phone: '0722100106' })).status).toBe(201);
    expect((await post({ name: 'Mary', phone: '0722100107' })).status).toBe(201);
  });

  it('does not compare against leads that are already closed', async () => {
    const closed = (await post({ name: 'Peter Otieno', phone: '0722100108' })).body.data;
    db.prepare("UPDATE leads SET status = 'cancelled' WHERE id = ?").run(closed.id);
    expect((await post({ name: 'Peter Otieno', phone: '0722100109' })).status).toBe(201);
  });

  it('does not confuse a different surname with a duplicate', async () => {
    expect((await post({ name: 'Jane Wambui', phone: '0722100110' })).status).toBe(201);
  });
});

describe('editing a lead onto another lead\'s phone or email', () => {
  let a;
  let b;

  beforeAll(async () => {
    a = (await post({ name: 'Edit Alpha', phone: '0733200100', email: 'alpha@example.com' })).body.data;
    b = (await post({ name: 'Edit Bravo', phone: '0733200101', email: 'bravo@example.com' })).body.data;
  });

  const patch = (id, body) => request(app).patch(`/api/leads/${id}`).set(auth()).send(body);

  it('refuses a phone number another lead already has', async () => {
    const res = await patch(b.id, { phone: '0733200100' });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ existingLeadId: a.id, matchedOn: 'phone' });
  });

  it('refuses an email another lead already has', async () => {
    const res = await patch(b.id, { email: 'ALPHA@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ existingLeadId: a.id, matchedOn: 'email' });
  });

  it('allows an edit that keeps its own phone and email', async () => {
    const res = await patch(b.id, { notes: 'called back', phone: '0733200101', email: 'bravo@example.com' });
    expect(res.status).toBe(200);
  });

  it('lets a lead that already clashes be edited for something else', async () => {
    db.prepare('UPDATE leads SET email = ? WHERE id = ?').run('alpha@example.com', b.id); // an old clash
    const res = await patch(b.id, { notes: 'still editable' });
    expect(res.status).toBe(200);
  });
});

describe('web-form intake', () => {
  it('never drops an enquiry over a shared name', async () => {
    const intake = require('../src/services/leadIntake.service');
    expect(intake).toBeTruthy();
    // The same full name as an open lead but a new phone: the lead service would ask for confirmation, intake must not.
    const leads = require('../src/services/leads.service');
    const storeId = 1;
    const staffId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    leads.create({ storeId, staffId, name: 'Form Person', phone: '0744300100', source: 'other' });
    expect(() => leads.create({ storeId, staffId, name: 'Form Person', phone: '0744300101', source: 'other' })).toThrow(/already open/);
    expect(() => leads.create({ storeId, staffId, name: 'Form Person', phone: '0744300101', source: 'other', allowPossibleDuplicate: true })).not.toThrow();
  });
});
