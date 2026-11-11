const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { offsetMinutes, localDate, dateParam, sqlOffset } = require('../src/utils/storeTime');

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let token;
let adminId;
beforeAll(async () => {
  token = await loginAsAdmin();
  adminId = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get().id;
});

// A sale at an exact UTC moment (the database stores UTC).
function sale(utc, total, { discount = 0, status = 'completed' } = {}) {
  return db.prepare(`INSERT INTO sales (store_id, cashier_id, subtotal, tax_total, discount_total, total, payment_method, status, created_at)
    VALUES (1, ?, ?, 0, ?, ?, 'cash', ?, ?)`).run(adminId, total + discount, discount, total, status, utc).lastInsertRowid;
}

describe('the shop clock (Nairobi, UTC+3)', () => {
  it('knows the offset and the shop date', () => {
    expect(offsetMinutes()).toBe(180);
    expect(sqlOffset()).toBe("'+180 minutes'");
    expect(localDate(0, new Date('2026-10-11T22:30:00Z'))).toBe('2026-10-12'); // 1:30 am on the 12th
    expect(localDate(0, new Date('2026-10-12T20:59:59Z'))).toBe('2026-10-12');
    expect(localDate(0, new Date('2026-10-12T21:00:00Z'))).toBe('2026-10-13');
    expect(localDate(1, new Date('2026-10-12T21:00:00Z'))).toBe('2026-10-12');
  });

  it('accepts only real YYYY-MM-DD dates', () => {
    expect(dateParam(undefined, 'from', 'x')).toBe('x');
    expect(dateParam('2031-03-10', 'from', 'x')).toBe('2031-03-10');
    ['2031-3-1', '2031/03/10', 'garbage', '2031-02-30', '2031-03-10 10:00:00'].forEach((v) => {
      expect(() => dateParam(v, 'from', 'x')).toThrow(/YYYY-MM-DD/);
    });
  });
});

describe('report date ranges use whole shop days', () => {
  // 10 March 2031 at the shop = 9 Mar 21:00 UTC up to 10 Mar 20:59:59 UTC
  beforeAll(() => {
    sale('2031-03-09 20:59:59', 100);  // 23:59:59 on the 9th  -> NOT the 10th
    sale('2031-03-09 21:00:00', 200);  // 00:00:00 on the 10th -> the 10th (UTC date says the 9th)
    sale('2031-03-10 12:00:00', 400);  // mid-afternoon on the 10th
    sale('2031-03-10 20:59:59', 800);  // 23:59:59 on the 10th (last second of the day)
    sale('2031-03-10 21:00:00', 1600); // 00:00:00 on the 11th -> NOT the 10th
    sale('2031-03-10 13:00:00', 3200, { status: 'voided' }); // never counts
  });

  it('sales-summary for a single day includes the whole day, including its last hours', async () => {
    const res = await request(app).get('/api/reports/sales-summary?from=2031-03-10&to=2031-03-10').set(auth(token));
    expect(res.status).toBe(200);
    // before the fix this was 0: "created_at BETWEEN '2031-03-10' AND '2031-03-10'" matched nothing
    expect(res.body.data.transaction_count).toBe(3);
    expect(res.body.data.revenue).toBe(200 + 400 + 800);
  });

  it('a range of several days adds up with no day dropped or counted twice', async () => {
    const res = await request(app).get('/api/reports/sales-summary?from=2031-03-09&to=2031-03-11').set(auth(token));
    expect(res.body.data.revenue).toBe(100 + 200 + 400 + 800 + 1600);
  });

  it('sales-trend buckets by shop day', async () => {
    const res = await request(app).get('/api/reports/sales-trend?from=2031-03-09&to=2031-03-11').set(auth(token));
    const byDay = Object.fromEntries(res.body.data.map((r) => [r.day, r.revenue]));
    expect(byDay['2031-03-09']).toBe(100);
    expect(byDay['2031-03-10']).toBe(1400);  // the 00:00-03:00 sale is on the 10th, not the 9th
    expect(byDay['2031-03-11']).toBe(1600);
  });

  it('dashboard-overview "today" is the shop day', async () => {
    const res = await request(app).get('/api/reports/dashboard-overview?date=2031-03-10').set(auth(token));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data.salesToday)).toContain('1400');
  });

  it('rejects a malformed date instead of silently returning wrong numbers', async () => {
    for (const q of ['from=2031-3-1', 'to=garbage', 'from=2031-03-10%2010:00:00']) {
      const res = await request(app).get(`/api/reports/sales-summary?${q}`).set(auth(token));
      expect(res.status).toBe(400);
    }
  });
});

describe('profit summary', () => {
  let productId;
  beforeAll(() => {
    productId = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES ('PROFIT-T', 'Profit Test', 3000, 5000, 1)`).run().lastInsertRowid;
  });

  it('takes a sale-level discount off revenue', async () => {
    // 2 x 5000 = 10000 on the lines, 1000 sale-level discount => the customer paid 9000
    const id = sale('2031-04-10 09:00:00', 9000, { discount: 1000 });
    db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, tax_rate, discount, line_total) VALUES (?, ?, 2, 5000, 0, 0, 10000)').run(id, productId);
    const res = await request(app).get('/api/reports/pnl?from=2031-04-10&to=2031-04-10').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.summary.revenue).toBe(9000);          // was 10000
    expect(res.body.data.summary.costOfGoodsSold).toBe(6000);  // 2 x 3000
  });

  it('counts only the collected share of a part-paid online order', async () => {
    const created = await request(app).post('/api/orders').set(auth(token))
      .send({ payment_type: 'prepaid', name: 'Part Paid', phone: '0755500001', items: [{ product_id: productId, quantity: 2 }] });
    expect(created.status).toBe(201);
    const oid = created.body.data.id;
    // order worth 10000 (2 x 5000), 4000 collected, dispatched on the 20th (shop time)
    db.prepare(`UPDATE orders SET status = 'dispatched_partial', total = 10000, amount_paid = 4000, dispatched_at = '2031-04-20 09:00:00' WHERE id = ?`).run(oid);
    db.prepare('UPDATE order_items SET unit_price = 5000, quantity = 2, line_total = 10000 WHERE order_id = ?').run(oid);
    const res = await request(app).get('/api/reports/pnl?from=2031-04-20&to=2031-04-20').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.summary.revenue).toBe(4000);            // 40% of 10000 (was the full 10000)
    expect(res.body.data.summary.costOfGoodsSold).toBe(2400);    // 40% of 2 x 3000
  });
});
