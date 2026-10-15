const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(() => cleanupTestDb());

describe('request validation (zod)', () => {
  describe('POST /api/sales', () => {
    it('rejects an empty items array', async () => {
      const res = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`)
        .send({ items: [], payments: [{ method: 'cash', amount: 100 }] });
      expect(res.status).toBe(400);
    });

    it('rejects a non-integer amount (fractional cents)', async () => {
      const res = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`)
        .send({ items: [{ product_id: 1, quantity: 1 }], payments: [{ method: 'cash', amount: 99.5 }] });
      expect(res.status).toBe(400);
    });

    it('rejects an unknown payment method', async () => {
      const res = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`)
        .send({ items: [{ product_id: 1, quantity: 1 }], payments: [{ method: 'bitcoin', amount: 100 }] });
      expect(res.status).toBe(400);
    });

    it('rejects a negative quantity', async () => {
      const res = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`)
        .send({ items: [{ product_id: 1, quantity: -1 }], payments: [{ method: 'cash', amount: 100 }] });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/payments', () => {
    it('rejects an incoming payment with no sale_id', async () => {
      const res = await request(app).post('/api/payments').set('Authorization', `Bearer ${token}`)
        .send({ direction: 'incoming', method: 'cash', amount: 100 });
      expect(res.status).toBe(400);
    });

    it('rejects an outgoing payment with no supplier_name', async () => {
      const res = await request(app).post('/api/payments').set('Authorization', `Bearer ${token}`)
        .send({ direction: 'outgoing', method: 'cash', amount: 100 });
      expect(res.status).toBe(400);
    });

    it('rejects a zero or negative amount', async () => {
      const res = await request(app).post('/api/payments').set('Authorization', `Bearer ${token}`)
        .send({ direction: 'outgoing', supplier_name: 'Acme', method: 'cash', amount: 0 });
      expect(res.status).toBe(400);
    });

    it('rejects an unknown direction', async () => {
      const res = await request(app).post('/api/payments').set('Authorization', `Bearer ${token}`)
        .send({ direction: 'sideways', supplier_name: 'Acme', method: 'cash', amount: 100 });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/expenses', () => {
    it('rejects a missing expense_date', async () => {
      const res = await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`)
        .send({ category_id: 1, amount: 100 });
      expect(res.status).toBe(400);
    });

    it('rejects a negative amount', async () => {
      const res = await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`)
        .send({ category_id: 1, amount: -50, expense_date: '2026-01-01' });
      expect(res.status).toBe(400);
    });

    it('still rejects an unknown category_id (DB-state check, not a zod shape check)', async () => {
      const res = await request(app).post('/api/expenses').set('Authorization', `Bearer ${token}`)
        .send({ category_id: 999999, amount: 100, expense_date: '2026-01-01' });
      expect(res.status).toBe(400);
    });
  });
});
