const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { localDate } = require('../src/utils/storeTime');

// Priority 5: full P&L (category, branch, forecast vs actual), discount / VAT / branch / agent reports, exports.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
const today = localDate(0);
let adminToken; let manager; let cashier; let repId; let product;

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} p5r`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token };
}
const get = (path, token = adminToken) => request(app).get(path).set(auth(token));
const q = `from=${today}&to=${today}`;

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  manager = await makeUser('manager', 'p5r-manager@urbantrends.com');
  cashier = await makeUser('cashier', 'p5r-cashier@urbantrends.com');
  repId = cashier.id;
  const res = await get('/api/products?pageSize=1');
  product = res.body.data[0];

  // A till sale with a line discount and a sale-wide discount, rung by the manager.
  const lineDisc = Math.floor(product.sell_price * 0.1);
  const saleDisc = Math.floor(product.sell_price * 0.05);
  const sale = await request(app).post('/api/sales').set(auth(manager.token)).send({
    items: [{ product_id: product.id, quantity: 2, discount: lineDisc }], discountTotal: saleDisc,
    payments: [{ method: 'cash', amount: product.sell_price * 2 - lineDisc - saleDisc }],
  });
  expect(sale.status).toBe(201);

  // A dispatched, fully paid online order assigned to the cashier, with a line discount.
  const order = await request(app).post('/api/orders').set(auth(adminToken)).send({
    name: 'P5 Customer', phone: '0766600001', payment_type: 'prepaid', assigned_staff_id: repId,
    items: [{ product_id: product.id, quantity: 3, discount: 1000 }],
  });
  expect(order.status).toBe(201);
  await request(app).post(`/api/orders/${order.body.data.id}/dispatch`).set(auth(adminToken));
  await request(app).post(`/api/orders/${order.body.data.id}/payments`).set(auth(adminToken))
    .send({ method: 'mobile_money', amount: order.body.data.total, reference: 'P5-TXN-1' });

  // An approved expense today and a lead for the agent.
  const cat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get();
  await request(app).post('/api/expenses').set(auth(adminToken)).send({ category_id: cat.id, amount: 50000, description: 'P5 test expense', expense_date: today });
  const lead = await request(app).post('/api/leads').set(auth(adminToken)).send({ name: 'P5 Lead', phone: '0766600002', source: 'whatsapp', assigned_staff_id: repId });
  expect(lead.status).toBe(201);
});
afterAll(() => cleanupTestDb());

describe('full P&L', () => {
  it('summary equals profit-summary, and the category rows add back up to revenue and margin', async () => {
    const full = (await get(`/api/reports/pnl?${q}`)).body.data;
    const legacy = (await get(`/api/reports/profit-summary?${q}`)).body.data;
    expect(full.summary).toEqual(legacy);
    expect(full.summary.revenue).toBeGreaterThan(0);
    expect(full.byCategory.total.revenue).toBe(full.summary.revenue);
    expect(full.byCategory.total.margin).toBe(full.summary.grossMargin);
    expect(full.byCategory.rows.some((r) => /Sale-level discounts/.test(r.category))).toBe(true);
  });

  it('branch comparison: an admin sees every active branch, others only their own, and the rows add up', async () => {
    db.prepare(`INSERT INTO stores (name, address) VALUES ('Second Branch', 'Thika')`).run();
    const admin = (await get(`/api/reports/branch-comparison?${q}`)).body.data;
    expect(admin.rows.length).toBeGreaterThanOrEqual(2);
    const second = admin.rows.find((r) => r.branch === 'Second Branch');
    expect(second.revenue).toBe(0);
    const summary = (await get(`/api/reports/pnl?${q}`)).body.data.summary;
    expect(admin.total.revenue).toBe(summary.revenue);
    expect(admin.total.netProfit).toBe(summary.netProfit);

    const mgr = (await get(`/api/reports/branch-comparison?${q}`, manager.token)).body.data;
    expect(mgr.rows.length).toBe(1);
  });
});

describe('forecast vs actual', () => {
  const month = today.slice(0, 7);

  it('is set by a manager but not a cashier, and rejects bad input', async () => {
    const body = { revenue_target: 100000000, expense_budget: 20000000 };
    expect((await request(app).put(`/api/reports/forecasts/${month}`).set(auth(cashier.token)).send(body)).status).toBe(403);
    expect((await request(app).put(`/api/reports/forecasts/${month}`).set(auth(manager.token)).send(body)).status).toBe(200);
    expect((await request(app).put('/api/reports/forecasts/2026-13').set(auth(manager.token)).send(body)).status).toBe(400);
    expect((await request(app).put(`/api/reports/forecasts/${month}`).set(auth(manager.token)).send({ revenue_target: -1, expense_budget: 0 })).status).toBe(400);
  });

  it('compares the month so far with its target and budget, and updates in place', async () => {
    const { forecast } = (await get(`/api/reports/pnl?from=${month}-01&to=${today}`)).body.data;
    const row = forecast.rows.find((r) => r.month === month);
    const monthPnl = (await get(`/api/reports/profit-summary?from=${month}-01&to=${today}`)).body.data;
    expect(row.has_forecast).toBe(true);
    expect(row.revenue_actual).toBe(monthPnl.revenue);
    expect(row.revenue_variance).toBe(monthPnl.revenue - 100000000);
    expect(row.revenue_attainment_percent).toBeCloseTo((monthPnl.revenue / 100000000) * 100, 1);
    expect(row.operating_expenses_actual).toBe(monthPnl.deliveryFees + monthPnl.laborCost + monthPnl.businessExpenses);
    expect(row.in_progress).toBe(true);
    expect(row.on_pace_percent).not.toBeNull();

    await request(app).put(`/api/reports/forecasts/${month}`).set(auth(manager.token)).send({ revenue_target: 5, expense_budget: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM sales_forecasts WHERE month = ?').get(month).c).toBe(1);
    await request(app).put(`/api/reports/forecasts/${month}`).set(auth(manager.token)).send({ revenue_target: 100000000, expense_budget: 20000000 });
  });

  it('a month with no forecast still shows actuals, with no variance', async () => {
    const { forecast } = (await get('/api/reports/pnl?from=2020-03-01&to=2020-03-31')).body.data;
    expect(forecast.rows[0]).toMatchObject({ month: '2020-03', has_forecast: false, revenue_variance: null, revenue_actual: 0 });
  });
});

describe('discount report', () => {
  it('totals what was given off, as a share of list value, by staff and day', async () => {
    const r = (await get(`/api/reports/discounts?${q}`)).body.data;
    const lineDisc = Math.floor(product.sell_price * 0.1);
    const saleDisc = Math.floor(product.sell_price * 0.05);
    expect(r.summary.discounted_transactions).toBeGreaterThanOrEqual(2);
    expect(r.summary.discount_total).toBeGreaterThanOrEqual(lineDisc + saleDisc + 1000);
    expect(r.summary.discount_percent).toBeCloseTo((r.summary.discount_total / r.summary.list_value) * 100, 1);
    const mgr = r.by_staff.find((s) => s.staff === 'manager p5r');
    expect(mgr.discount).toBe(lineDisc + saleDisc);
    expect(r.by_day.reduce((t, d) => t + d.discount, 0)).toBe(r.summary.discount_total);
    expect(r.largest[0].discount).toBeGreaterThanOrEqual(r.largest[r.largest.length - 1].discount);
  });
});

describe('VAT report', () => {
  it('estimates the VAT inside collected sales at the configured rate, agreeing with the P&L', async () => {
    const pl = (await get(`/api/reports/profit-summary?${q}`)).body.data;
    const v = (await get(`/api/reports/vat?${q}`)).body.data;
    expect(v.estimated).toBe(true);
    expect(v.vat_rate_percent).toBe(16);
    expect(v.total.gross).toBe(pl.revenue);
    expect(v.total.vat).toBe(Math.round((pl.revenue * 16) / 116));
    expect(v.total.net + v.total.vat).toBe(v.total.gross);
    expect(v.daily.reduce((t, d) => t + d.gross, 0)).toBe(v.total.gross);
    expect(v.months.reduce((t, m) => t + m.gross, 0)).toBe(v.total.gross);

    db.prepare(`INSERT INTO settings (key, value) VALUES ('vat_rate_percent', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run();
    expect((await get(`/api/reports/vat?${q}`)).body.data.total.vat).toBe(0);
    db.prepare(`DELETE FROM settings WHERE key = 'vat_rate_percent'`).run();
  });
});

describe('sales-agent performance', () => {
  it('ranks agents on what they collected, with lead conversion, discounts and commission', async () => {
    const r = (await get(`/api/reports/agent-performance?${q}`)).body.data;
    const rep = r.rows.find((x) => x.staff_id === repId);
    expect(rep.orders_collected).toBe(1);
    expect(rep.online_revenue).toBeGreaterThan(0);
    expect(rep.avg_order_value).toBe(rep.online_revenue);
    expect(rep.leads_assigned).toBe(1);
    expect(rep.lead_conversion_percent).toBe(0);
    expect(rep.discounts_given).toBe(1000);
    const mgr = r.rows.find((x) => x.staff === 'manager p5r');
    expect(mgr.till_sales).toBe(1);
    expect(r.rows.map((x) => x.rank)).toEqual(r.rows.map((_, i) => i + 1));
    expect(r.rows.map((x) => x.total_revenue)).toEqual([...r.rows.map((x) => x.total_revenue)].sort((a, b) => b - a));
    expect(r.total.total_revenue).toBe(r.rows.reduce((t, x) => t + x.total_revenue, 0));
  });
});

describe('Excel and PDF export', () => {
  const REPORTS = ['pnl', 'discounts', 'vat', 'branches', 'agents'];

  it.each(REPORTS)('%s downloads as a real .xlsx and a real .pdf', async (name) => {
    const x = await get(`/api/reports/export/${name}?format=xlsx&${q}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    expect(x.headers['content-disposition']).toContain(`${name}_${today}_to_${today}.xlsx`);
    expect(x.body.slice(0, 2).toString()).toBe('PK');
    const p = await get(`/api/reports/export/${name}?format=pdf&${q}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(p.status).toBe(200);
    expect(p.body.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('puts money in the workbook as KES numbers (not cents) on named sheets', async () => {
    const pl = (await get(`/api/reports/profit-summary?${q}`)).body.data;
    const res = await get(`/api/reports/export/pnl?format=xlsx&${q}`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'By category', 'Branch comparison', 'Forecast vs actual']);
    const rows = [];
    wb.getWorksheet('Summary').eachRow((row) => rows.push(row.values.slice(1)));
    const revenueRow = rows.find((r) => String(r[0]).startsWith('Revenue'));
    expect(revenueRow[1]).toBeCloseTo(pl.revenue / 100, 2);
    const net = rows.find((r) => r[0] === 'Net profit');
    expect(net[1]).toBeCloseTo(pl.netProfit / 100, 2);
  });

  it('rejects an unknown report, a bad format and a bad date; and needs reports.view', async () => {
    expect((await get(`/api/reports/export/nope?format=pdf&${q}`)).status).toBe(404);
    expect((await get(`/api/reports/export/pnl?format=docx&${q}`)).status).toBe(400);
    expect((await get('/api/reports/export/pnl?format=pdf&from=bad')).status).toBe(400);
    expect((await get(`/api/reports/export/pnl?format=pdf&${q}`, cashier.token)).status).toBe(403);
    expect((await get(`/api/reports/discounts?${q}`, cashier.token)).status).toBe(403);
  });
});
