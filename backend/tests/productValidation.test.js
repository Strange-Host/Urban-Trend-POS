const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let auth;
beforeAll(async () => { auth = { Authorization: `Bearer ${await loginAsAdmin()}` }; });
afterAll(() => cleanupTestDb());

const create = (body) => request(app).post('/api/products').set(auth).send(body);
const base = { sku: 'PV-1', name: 'Validated Tee', sell_price: 2500 };

describe('product price and field validation', () => {
  it('accepts what the product form really sends (whole cents, category id as a string, extra keys)', async () => {
    const res = await create({ ...base, sku: 'PV-OK', cost_price: 1000, category_id: '1', barcode: null, brand: 'UT', image_url: '', total_stock: 5, category_name: 'ignored' });
    expect(res.status).toBe(201);
    expect(res.body.data.sell_price).toBe(2500);
    expect(res.body.data.category_id).toBe(1);
  });

  it.each([
    ['a negative selling price', { sell_price: -100 }],
    ['a fractional selling price', { sell_price: 99.5 }],
    ['a selling price sent as text', { sell_price: '2500' }],
    ['an absurdly large price', { sell_price: 1e15 }],
    ['a negative buying price', { cost_price: -1 }],
    ['a blank name', { name: '' }],
    ['a javascript: picture address', { image_url: 'javascript:alert(1)' }],
    ['a data: picture address', { image_url: 'data:text/html;base64,PHNjcmlwdD4=' }],
    ['a non-numeric category', { category_id: 'abc' }],
  ])('rejects %s on create', async (_label, bad) => {
    const res = await create({ ...base, sku: `PV-BAD-${Math.random().toString(36).slice(2, 8)}`, ...bad });
    expect(res.status).toBe(400);
  });

  it('still requires a selling price', async () => {
    expect((await create({ sku: 'PV-NOPRICE', name: 'No price' })).status).toBe(400);
  });

  it('applies the same rules to updates, and leaves omitted fields alone', async () => {
    const made = (await create({ ...base, sku: 'PV-UPD' })).body.data;
    const put = (body) => request(app).put(`/api/products/${made.id}`).set(auth).send(body);

    expect((await put({ sell_price: -5 })).status).toBe(400);
    expect((await put({ sell_price: 12.5 })).status).toBe(400);
    const ok = await put({ name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe('Renamed');
    expect(ok.body.data.sell_price).toBe(2500);    // untouched
  });
});
