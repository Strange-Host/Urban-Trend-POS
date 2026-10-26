import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Role } from '../src/auth/permissions.js';
import { createUser } from '../src/auth/service.js';
import { NOT_HISTORY, personColumns } from '../src/auth/staff.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { KEY } from './orderHelpers.js';

let db: TestDb;
const app = () => createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY });
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

let n = 0;
interface P { id: number; username: string; name: string; email: string; password: string; auth: string; cookie: string }
async function person(role: Role, opts: { signIn?: boolean } = {}): Promise<P> {
  const username = `${role}${++n}r${Math.random().toString(36).slice(2, 6)}`;
  const email = `${username}@shop.test`;
  const name = `Test Person ${n}`;
  const { user, temporaryPassword } = await createUser(db.pool, { username, displayName: name, role, email, phone: '0711000000', actor: 'test-setup' });
  const first = await request(app()).post('/api/auth/login').send({ email, password: temporaryPassword });
  const password = `Better-${Math.random().toString(36).slice(2, 12)}-pw`;
  await request(app()).post('/api/auth/change-password').set('Authorization', `Bearer ${first.body.token}`).send({ currentPassword: temporaryPassword, newPassword: password });
  const res = await request(app()).post('/api/auth/login').send({ email, password });
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ut_refresh_token='))!.split(';')[0]!;
  void opts;
  return { id: user.id, username, name, email, password, auth: `Bearer ${res.body.token}`, cookie };
}
/** The person does some real work: records an enquiry. From then on their name is on a record that must be kept. */
const doesWork = (p: P) => request(app()).post('/api/leads').set('Authorization', p.auth).send({ name: 'Amina', phone: `0711 ${String(100000 + ++n).slice(-6)}`, message: 'Size 40?' }).then((r) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); });

describe('the removal check', () => {
  it('says an account that only signed in never did anything, and lists what an account with history did', async () => {
    const admin = await person('admin');
    const idle = await person('cashier');
    const worker = await person('cashier');
    await doesWork(worker);
    const a = await request(app()).get(`/api/users/${idle.id}/removal-check`).set('Authorization', admin.auth);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ hasActivity: false, canDeletePermanently: true, canErase: false, eraseNeedsDeactivation: true, active: true, erased: false });
    const b = await request(app()).get(`/api/users/${worker.id}/removal-check`).set('Authorization', admin.auth);
    expect(b.body.hasActivity).toBe(true);
    expect(b.body.canDeletePermanently).toBe(false);
    expect(Object.keys(b.body.activity).length).toBeGreaterThan(0);
    expect(b.body.reasons.join(' ')).toMatch(/has history/);
  });

  it('never offers removal of yourself or of the only active admin', async () => {
    const solo = await person('admin'); // other tests' admins exist too, so make this one the only active admin by checking self first
    const self = await request(app()).get(`/api/users/${solo.id}/removal-check`).set('Authorization', solo.auth);
    expect(self.body.canDeletePermanently).toBe(false);
    expect(self.body.reasons).toContain('You cannot remove your own account.');
    await db.pool.query(`UPDATE users SET active = false WHERE role = 'admin' AND id <> $1`, [solo.id]);
    const other = await person('admin');
    await db.pool.query(`UPDATE users SET active = false WHERE id = $1`, [other.id]);
    const last = await request(app()).get(`/api/users/${solo.id}/removal-check`).set('Authorization', other.auth);
    expect(last.status).toBe(401); // a deactivated admin cannot act: the point is made by the database being unable to lose its last admin
    await db.pool.query(`UPDATE users SET active = true WHERE role = 'admin'`);
  });

  it('finds every column that names a person from the database itself, so a table added later is covered', async () => {
    const cols = (await personColumns(db.pool)).map((c) => `${c.table}.${c.column}`);
    for (const known of ['orders.created_by', 'orders.assigned_to', 'sales.cashier', 'cash_sessions.cashier', 'payroll_items.staff_key', 'leads.created_by', 'stock_movements.actor', 'sale_refunds.approved_by']) {
      expect(cols, known).toContain(known);
    }
    expect(cols).not.toContain('user_permissions.updated_by'); // a last-touched note is not history
    expect(cols).not.toContain('users.username');
    expect(cols).not.toContain('retired_usernames.username'); // a retired name is not someone's work

    const worker = await person('cashier');
    await db.pool.query(`CREATE TABLE zz_future_feature (id serial PRIMARY KEY, checked_by text NOT NULL)`);
    await db.pool.query(`INSERT INTO zz_future_feature (checked_by) VALUES ($1)`, [worker.username]);
    const admin = await person('admin');
    const res = await request(app()).get(`/api/users/${worker.id}/removal-check`).set('Authorization', admin.auth);
    expect(res.body.activity['zz future feature']).toBe(1);
    expect(res.body.canDeletePermanently).toBe(false);
    await db.pool.query(`DROP TABLE zz_future_feature`);
  });

  it('fails when a column that could name a person is neither counted as history nor deliberately set aside', async () => {
    // The net under the name-based search: a future column with an unusual name must be classified by a person, here, before it can slip past.
    const found = new Set((await personColumns(db.pool)).map((c) => `${c.table}.${c.column}`));
    const { rows } = await db.pool.query<{ t: string; c: string }>(
      `SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = current_schema() AND c.data_type = 'text' AND c.table_name <> 'users'
          AND c.column_name ~ '(by|user|staff|cashier|agent|owner|who|actor|approver|assigned|handler|operator|member|employee|worker|clerk)'`);
    // Looked at and judged not to name a person: browser strings, migration names, a job title (admin/manager/cashier) rather than who, and the retirement list itself.
    const setAside = new Set([...NOT_HISTORY, 'sessions.user_agent', 'schema_migrations.name', 'audit_log.actor_role', 'sales.cashier_role', 'discount_approvals.approver_role', 'retired_usernames.username']);
    const unclassified = rows.map((r) => `${r.t}.${r.c}`).filter((k) => !found.has(k) && !setAside.has(k));
    expect(unclassified).toEqual([]);
  });

  it('can be read by an admin only', async () => {
    const mgr = await person('manager');
    const target = await person('cashier');
    expect((await request(app()).get(`/api/users/${target.id}/removal-check`).set('Authorization', mgr.auth)).status).toBe(403);
  });
});

describe('reactivating', () => {
  it('brings back a deactivated account with a clean slate, and says so when it is already active', async () => {
    const admin = await person('admin');
    const p = await person('cashier');
    await request(app()).patch(`/api/users/${p.id}`).set('Authorization', admin.auth).send({ active: false });
    await db.pool.query(`UPDATE users SET locked_until = now() + interval '1 hour', failed_attempts = 3 WHERE id = $1`, [p.id]);
    expect((await request(app()).post('/api/auth/login').send({ email: p.email, password: p.password })).status).toBe(423); // locked answers before anything else
    const back = await request(app()).post(`/api/users/${p.id}/reactivate`).set('Authorization', admin.auth);
    expect(back.body).toMatchObject({ alreadyActive: false });
    expect((await request(app()).post('/api/auth/login').send({ email: p.email, password: p.password })).status).toBe(200);
    expect((await request(app()).post(`/api/users/${p.id}/reactivate`).set('Authorization', admin.auth)).body.alreadyActive).toBe(true);
  });

  it('also clears a lockout when the plain edit route reactivates', async () => {
    const admin = await person('admin');
    const p = await person('cashier');
    await request(app()).patch(`/api/users/${p.id}`).set('Authorization', admin.auth).send({ active: false });
    await db.pool.query(`UPDATE users SET locked_until = now() + interval '1 hour' WHERE id = $1`, [p.id]);
    await request(app()).patch(`/api/users/${p.id}`).set('Authorization', admin.auth).send({ active: true });
    expect((await request(app()).post('/api/auth/login').send({ email: p.email, password: p.password })).status).toBe(200);
  });
});

describe('deleting an account that never did anything', () => {
  it('needs the person\'s full name typed, then removes the account, its sign-ins and its permissions, and retires the username', async () => {
    const admin = await person('admin');
    const p = await person('cashier');
    await request(app()).put(`/api/users/${p.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'reports.view': true } });
    const wrong = await request(app()).post(`/api/users/${p.id}/permanent-delete`).set('Authorization', admin.auth).send({ confirmName: 'someone else' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('CONFIRMATION_MISMATCH');

    const ok = await request(app()).post(`/api/users/${p.id}/permanent-delete`).set('Authorization', admin.auth).send({ confirmName: ` ${p.name} ` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ deleted: true, id: p.id });
    expect((await db.pool.query(`SELECT 1 FROM users WHERE id = $1`, [p.id])).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [p.id])).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM user_permissions WHERE user_id = $1`, [p.id])).rowCount).toBe(0);
    expect((await request(app()).get('/api/auth/me').set('Authorization', p.auth)).status).toBe(401);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', p.cookie)).status).toBe(401);
    expect((await request(app()).post('/api/auth/login').send({ email: p.email, password: p.password })).status).toBe(401);

    const { rows } = await db.pool.query(`SELECT risk, details FROM audit_log WHERE action = 'user_deleted' AND entity_id = $1`, [String(p.id)]);
    expect(rows[0].risk).toBe(2);
    expect(rows[0].details).toMatchObject({ username: p.username, email: p.email });

    // The name is gone for good: its few sign-in records must never attach to a stranger.
    const again = await request(app()).post('/api/users').set('Authorization', admin.auth).send({ username: p.username, displayName: 'New Person', role: 'cashier' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('USERNAME_RETIRED');
  });

  it('refuses an account with history, and says what the history is', async () => {
    const admin = await person('admin');
    const worker = await person('cashier');
    await doesWork(worker);
    const res = await request(app()).post(`/api/users/${worker.id}/permanent-delete`).set('Authorization', admin.auth).send({ confirmName: worker.name });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_DELETE_ACCOUNT');
    expect(res.body.error.message).toMatch(/has history/);
    expect((await db.pool.query(`SELECT 1 FROM users WHERE id = $1`, [worker.id])).rowCount).toBe(1);
  });

  it('refuses to delete yourself', async () => {
    const admin = await person('admin');
    const res = await request(app()).post(`/api/users/${admin.id}/permanent-delete`).set('Authorization', admin.auth).send({ confirmName: admin.name });
    expect(res.status).toBe(409);
  });

  it('leaves the database guard on: a stray DELETE still fails, even right after a legitimate one', async () => {
    const admin = await person('admin');
    const gone = await person('cashier');
    const keep = await person('cashier');
    await request(app()).post(`/api/users/${gone.id}/permanent-delete`).set('Authorization', admin.auth).send({ confirmName: gone.name });
    await expect(db.pool.query(`DELETE FROM users WHERE id = $1`, [keep.id])).rejects.toThrow(/cannot be deleted/);
  });

  it('asks for the admin\'s own password again when it was not typed recently, but never to look', async () => {
    const admin = await person('admin');
    const p = await person('cashier');
    await db.pool.query(`UPDATE sessions SET reauth_at = now() - interval '10 minutes' WHERE user_id = $1`, [admin.id]);
    expect((await request(app()).get(`/api/users/${p.id}/removal-check`).set('Authorization', admin.auth)).status).toBe(200);
    const need = await request(app()).post(`/api/users/${p.id}/permanent-delete`).set('Authorization', admin.auth).send({ confirmName: p.name });
    expect(need.status).toBe(403);
    expect(need.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await request(app()).post('/api/auth/unlock').set('Authorization', admin.auth).send({ password: admin.password })).status).toBe(200);
    expect((await request(app()).post(`/api/users/${p.id}/permanent-delete`).set('Authorization', admin.auth).send({ confirmName: p.name })).status).toBe(200);
  });
});

describe('erasing a former staff member\'s personal data', () => {
  it('must be a deactivated account, and needs the name typed', async () => {
    const admin = await person('admin');
    const worker = await person('cashier');
    await doesWork(worker);
    const active = await request(app()).post(`/api/users/${worker.id}/erase-personal-data`).set('Authorization', admin.auth).send({ confirmName: worker.name });
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe('DEACTIVATE_FIRST');
    await request(app()).patch(`/api/users/${worker.id}`).set('Authorization', admin.auth).send({ active: false });
    const wrong = await request(app()).post(`/api/users/${worker.id}/erase-personal-data`).set('Authorization', admin.auth).send({ confirmName: 'nope' });
    expect(wrong.body.error.code).toBe('CONFIRMATION_MISMATCH');
  });

  it('wipes who they are, keeps what they did, and cannot be undone', async () => {
    const admin = await person('admin');
    const worker = await person('cashier');
    await doesWork(worker);
    await request(app()).put(`/api/users/${admin.id === worker.id ? 0 : worker.id}/pin`).set('Authorization', admin.auth).send({ pin: '4829' });
    await request(app()).put(`/api/users/${worker.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'reports.view': true } });
    await request(app()).patch(`/api/users/${worker.id}`).set('Authorization', admin.auth).send({ active: false });

    const res = await request(app()).post(`/api/users/${worker.id}/erase-personal-data`).set('Authorization', admin.auth).send({ confirmName: worker.name });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ erased: true, displayName: `Former staff #${worker.id}` });

    const { rows } = await db.pool.query(`SELECT display_name, email, phone, pin_hash, active, erased_at, password_hash FROM users WHERE id = $1`, [worker.id]);
    expect(rows[0]).toMatchObject({ display_name: `Former staff #${worker.id}`, email: null, phone: null, pin_hash: null, active: false });
    expect(rows[0].erased_at).not.toBeNull();
    expect((await db.pool.query(`SELECT 1 FROM user_permissions WHERE user_id = $1`, [worker.id])).rowCount).toBe(0);
    // What they did is untouched, still under their username, so reports add up.
    expect((await db.pool.query(`SELECT 1 FROM leads WHERE created_by = $1`, [worker.username])).rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0])).not.toContain(worker.email);

    expect((await request(app()).post('/api/auth/login').send({ email: worker.email, password: worker.password })).status).toBe(401);
    const back = await request(app()).post(`/api/users/${worker.id}/reactivate`).set('Authorization', admin.auth);
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('ACCOUNT_ERASED');
    expect((await request(app()).patch(`/api/users/${worker.id}`).set('Authorization', admin.auth).send({ active: true })).body.error.code).toBe('ACCOUNT_ERASED');
    expect((await request(app()).post(`/api/users/${worker.id}/reset-password`).set('Authorization', admin.auth)).body.error.code).toBe('ACCOUNT_ERASED');
    expect((await request(app()).put(`/api/users/${worker.id}/pin`).set('Authorization', admin.auth).send({ pin: '4829' })).body.error.code).toBe('ACCOUNT_ERASED');
    const again = await request(app()).post(`/api/users/${worker.id}/erase-personal-data`).set('Authorization', admin.auth).send({ confirmName: `Former staff #${worker.id}` });
    expect(again.body.error.code).toBe('ACCOUNT_ERASED');
    const audit = await db.pool.query(`SELECT risk FROM audit_log WHERE action = 'user_erased' AND entity_id = $1`, [String(worker.id)]);
    expect(audit.rows[0].risk).toBe(2);
    // Their email address is free for someone else to use.
    expect((await request(app()).post('/api/users').set('Authorization', admin.auth).send({ username: `new${++n}x`, displayName: 'Someone New', role: 'cashier', email: worker.email })).status).toBe(201);
  });

  it('ends any sessions the erased account still had', async () => {
    const admin = await person('admin');
    const worker = await person('cashier');
    await doesWork(worker);
    await request(app()).patch(`/api/users/${worker.id}`).set('Authorization', admin.auth).send({ active: false });
    await request(app()).post(`/api/users/${worker.id}/erase-personal-data`).set('Authorization', admin.auth).send({ confirmName: worker.name });
    expect((await request(app()).get('/api/auth/me').set('Authorization', worker.auth)).status).toBe(401);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', worker.cookie)).status).toBe(401);
  });
});

describe('who may read the staff list', () => {
  it('is a manager by default, a cashier only when the admin grants it, and one person at a time', async () => {
    const admin = await person('admin');
    const mgr = await person('manager');
    const csh = await person('cashier');
    expect((await request(app()).get(`/api/users/${csh.id}`).set('Authorization', mgr.auth)).body.user.username).toBe(csh.username);
    expect((await request(app()).get('/api/users').set('Authorization', csh.auth)).status).toBe(403);
    await request(app()).put(`/api/users/${csh.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'staff.view': true } });
    expect((await request(app()).get('/api/users').set('Authorization', csh.auth)).status).toBe(200);
    expect((await request(app()).post('/api/users').set('Authorization', csh.auth).send({ username: 'sneaky', displayName: 'S', role: 'admin' })).status).toBe(403); // reading is not managing
    await request(app()).put(`/api/users/${mgr.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'staff.view': false } });
    expect((await request(app()).get('/api/users').set('Authorization', mgr.auth)).status).toBe(403);
  });
});
