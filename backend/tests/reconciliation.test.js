const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(() => cleanupTestDb());

describe('inventory reconciliation', () => {
  it('reports no drift on a freshly seeded database', async () => {
    const res = await request(app).get('/api/inventory/reconcile').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('detects drift introduced outside the normal write paths, and fixing it actually converges to clean', async () => {
    // Simulate cache corruption / direct tampering — a quantity change with
    // no corresponding inventory_movements row, which is exactly what
    // findDrift() exists to catch.
    db.prepare('UPDATE inventory SET quantity = quantity + 999 WHERE product_id = 1').run();

    const detected = await request(app).get('/api/inventory/reconcile').set('Authorization', `Bearer ${token}`);
    expect(detected.body.data.length).toBe(1);
    expect(detected.body.data[0].drift).toBe(999);

    const fixed = await request(app).post('/api/inventory/reconcile').set('Authorization', `Bearer ${token}`);
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.length).toBe(1);

    // The regression this guards against: the fix must actually converge —
    // a sign error here previously made re-checking still show drift.
    const recheck = await request(app).get('/api/inventory/reconcile').set('Authorization', `Bearer ${token}`);
    expect(recheck.body.data).toEqual([]);
  });
});
