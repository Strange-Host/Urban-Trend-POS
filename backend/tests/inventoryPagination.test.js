const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let auth;
beforeAll(async () => { auth = { Authorization: `Bearer ${await loginAsAdmin()}` }; });
afterAll(() => cleanupTestDb());

describe('inventory lists', () => {
  it('still return everything (as before) when no paging is asked for, and say they were not cut off', async () => {
    const res = await request(app).get('/api/inventory').set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(2);
    expect(res.body.truncated).toBe(false);
  });

  it('page through the same rows when ?page / ?limit are given', async () => {
    const all = (await request(app).get('/api/inventory').set(auth)).body.data;
    const p1 = (await request(app).get('/api/inventory?page=1&limit=2').set(auth)).body;
    const p2 = (await request(app).get('/api/inventory?page=2&limit=2').set(auth)).body;
    expect(p1.data).toHaveLength(2);
    expect(p1.total).toBe(all.length);
    expect(p1.totalPages).toBe(Math.ceil(all.length / 2));
    expect(p1.data.map((r) => r.product_id)).toEqual(all.slice(0, 2).map((r) => r.product_id));
    expect(p2.data.map((r) => r.product_id)).toEqual(all.slice(2, 4).map((r) => r.product_id));
  });

  it('low-stock pages the same way and keeps its ordering', async () => {
    const all = (await request(app).get('/api/inventory/low-stock').set(auth)).body;
    const paged = (await request(app).get('/api/inventory/low-stock?page=1&limit=100').set(auth)).body;
    expect(paged.total).toBe(all.data.length);
    expect(paged.data.map((r) => r.id)).toEqual(all.data.map((r) => r.id));
  });
});
