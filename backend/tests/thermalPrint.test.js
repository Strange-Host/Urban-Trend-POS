const net = require('net');
const http = require('http');
const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { receiptToEscPos, drawerKick, ascii } = require('../src/utils/escpos');
const { createBridge } = require('../../print-bridge/bridge');

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);
const DRAWER = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
const INIT = Buffer.from([0x1b, 0x40]);

const receipt = (over = {}) => ({
  kind: 'sale', business: { name: 'Urban Trends', address: 'Moi Ave, Nairobi', phone: '0700 000000', footer: 'Thank you for shopping with us.', currency: 'KES' },
  reference: 'S-12', status: 'completed', created_at: '2026-10-31 08:00:00', cashier: 'Grace',
  items: [{ name: 'Hoodie', quantity: 2, unit_price: 150000, line_total: 300000 }],
  totals: { subtotal: 300000, discount: 0, total: 300000, paid: 300000, balance: 0 },
  payments: [{ method: 'cash', amount: 100000 }, { method: 'mobile_money', amount: 200000, reference: 'QGH7XY12AB' }],
  ...over,
});
// The printable text only: whole ESC/GS command sequences removed (their parameter bytes can look like letters).
const plain = (buf) => buf.toString('latin1')
  .replace(/\x1bp[\s\S]{3}|\x1b@|\x1b[aEd][\s\S]|\x1d![\s\S]|\x1dVB[\s\S]/g, '');
const text = (buf) => plain(buf).replace(/[\x00-\x08\x0b-\x1f]/g, '');

describe('ESC/POS encoder', () => {
  it('starts with init, ends with a feed and a cut, and prints the sale and each payment with its code', () => {
    const buf = receiptToEscPos(receipt());
    expect(buf.subarray(0, 2)).toEqual(INIT);
    expect(buf.subarray(buf.length - 4)).toEqual(CUT);
    const t = text(buf);
    expect(t).toMatch(/Urban Trends/);
    expect(t).toMatch(/S-12/);
    expect(t).toMatch(/2 x 1,500\s+3,000/);
    expect(t).toMatch(/TOTAL\s+KES 3,000/);
    expect(t).toMatch(/Cash\s+1,000/);
    expect(t).toMatch(/Mobile money\s+2,000/);
    expect(t).toMatch(/Ref: QGH7XY12AB/);
    expect(t).toMatch(/Thank you for shopping/);
  });

  it('opens the drawer only when asked, and can skip the cut', () => {
    expect(receiptToEscPos(receipt()).includes(DRAWER)).toBe(false);
    expect(receiptToEscPos(receipt(), { drawer: true }).includes(DRAWER)).toBe(true);
    expect(receiptToEscPos(receipt(), { cut: false }).includes(CUT)).toBe(false);
    expect(drawerKick()).toEqual(Buffer.concat([INIT, DRAWER]));
  });

  it('keeps every line within the paper width, wrapping long names and keeping amounts on the line', () => {
    const long = receipt({ items: [{ name: 'Extra long oversized cotton hoodie with embroidered logo and thermal lining', quantity: 1, unit_price: 123456, line_total: 123456 }] });
    for (const cols of [32, 48]) {
      const lines = plain(receiptToEscPos(long, { cols })).split('\n');
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(cols);
      expect(lines.some((l) => /1 x 1,234\.56\s+1,234\.56/.test(l))).toBe(true);
    }
  });

  it('reduces text to plain ASCII so a printer never receives bytes it cannot show', () => {
    expect(ascii('Café “quoted” – 2×')).toBe('Cafe "quoted" - 2x');
    expect(ascii('日本')).toBe('??');
    expect(ascii('a\nb\r\nc')).toBe('a b c');
    const buf = receiptToEscPos(receipt({ cashier: 'Zoë\n\u001b@' }));
    expect(buf.toString('latin1')).toMatch(/Served by: Zoe \?@/); // a control character in a name cannot inject a command
  });

  it('marks a voided sale and shows an order\'s delivery details and how to pay', () => {
    expect(text(receiptToEscPos(receipt({ status: 'voided' })))).toMatch(/\*\*\* VOIDED \*\*\*/);
    const order = receiptToEscPos({
      ...receipt({ kind: 'order', reference: 'UT-9', payments: undefined }),
      customer: { name: 'Amina', phone: '0711', city: 'Nairobi' }, delivery: { courier_type: 'boda', fee: 20000 },
      totals: { subtotal: 300000, discount: 0, total: 320000, paid: 100000, balance: 220000 }, payment: { show: true, paybill: '522522', account: 'UT-9' },
    });
    const t = text(order);
    expect(t).toMatch(/Deliver to/);
    expect(t).toMatch(/Amina/);
    expect(t).toMatch(/Courier: Boda/);
    expect(t).toMatch(/Delivery\s+200/);
    expect(t).toMatch(/BALANCE DUE\s+2,200/);
    expect(t).toMatch(/Paybill: 522522/);
  });
});

describe('ESC/POS endpoints', () => {
  let adminToken; let cashierToken; let saleId; let storeBToken;

  beforeAll(async () => {
    adminToken = await loginAsAdmin();
    const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
    db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Cashier TP', 'tp-cashier@urbantrends.com', ?, 'cashier', 1)`).run(store.id, bcrypt.hashSync('Passw0rd!Passw0rd', 10));
    cashierToken = (await request(app).post('/api/auth/login').send({ email: 'tp-cashier@urbantrends.com', password: 'Passw0rd!Passw0rd' })).body.token;
    const b = db.prepare(`INSERT INTO stores (name) VALUES ('TP Store B')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'TP B', 'tp-b@urbantrends.com', ?, 'admin', 1)`).run(b, bcrypt.hashSync('Passw0rd!Passw0rd', 10));
    storeBToken = (await request(app).post('/api/auth/login').send({ email: 'tp-b@urbantrends.com', password: 'Passw0rd!Passw0rd' })).body.token;
    const product = db.prepare(`SELECT id, sell_price FROM products WHERE is_active = 1 AND approval_status = 'approved' LIMIT 1`).get();
    db.prepare('UPDATE inventory SET quantity = quantity + 50 WHERE product_id = ? AND store_id = ?').run(product.id, store.id);
    const half = Math.floor(product.sell_price / 2);
    const sale = await request(app).post('/api/sales').set(auth(cashierToken)).send({
      items: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: half }, { method: 'mobile_money', amount: product.sell_price - half, reference: 'ABC123XYZ9' }],
    });
    saleId = sale.body.data.id;
  });
  afterAll(() => cleanupTestDb());

  it('returns raw bytes for a sale, including the split payments, with the cut and drawer options honoured', async () => {
    const res = await request(app).get(`/api/sales/${saleId}/receipt.escpos?drawer=1&cols=32`).set(auth(cashierToken)).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/octet-stream/);
    const buf = res.body;
    expect(buf.subarray(0, 2)).toEqual(INIT);
    expect(buf.includes(DRAWER)).toBe(true);
    expect(buf.subarray(buf.length - 4)).toEqual(CUT);
    expect(text(buf)).toMatch(/Ref: ABC123XYZ9/);
    expect(text(buf)).toMatch(/Mobile money/);
  });

  it('needs a sign-in, and another store cannot print this store\'s sale', async () => {
    expect((await request(app).get(`/api/sales/${saleId}/receipt.escpos`)).status).toBe(401);
    expect((await request(app).get(`/api/sales/${saleId}/receipt.escpos`).set(auth(storeBToken))).status).toBe(404);
    expect((await request(app).get('/api/sales/drawer.escpos')).status).toBe(401);
  });

  it('serves the drawer pulse before the :id route swallows it', async () => {
    const res = await request(app).get('/api/sales/drawer.escpos').set(auth(cashierToken)).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(drawerKick());
  });
});

describe('print bridge', () => {
  let printer; let printerPort; let received; let bridge; let base;

  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: 'POST', headers }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const call = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject); req.end();
  });

  beforeAll(async () => {
    received = [];
    printer = net.createServer((s) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => received.push(Buffer.concat(c))); });
    await new Promise((r) => printer.listen(0, '127.0.0.1', r));
    printerPort = printer.address().port;
    bridge = createBridge({ host: '127.0.0.1', port: printerPort, allowOrigins: ['https://pos.example.com'] });
    await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${bridge.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => bridge.close(r)); await new Promise((r) => printer.close(r)); });

  it('forwards the exact bytes to the printer for an allowed site', async () => {
    const bytes = receiptToEscPos(receipt(), { drawer: true });
    const res = await post('/print', bytes, { Origin: 'https://pos.example.com', 'Content-Type': 'application/octet-stream' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, bytes: bytes.length });
    expect(res.headers['access-control-allow-origin']).toBe('https://pos.example.com');
    await new Promise((r) => setTimeout(r, 50));
    expect(received.at(-1)).toEqual(bytes);
  });

  it('refuses any other website, without printing, and does not send it CORS permission', async () => {
    const before = received.length;
    const res = await post('/print', receiptToEscPos(receipt()), { Origin: 'https://evil.example.net' });
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(before);
  });

  it('answers the browser\'s preflight (including private-network access) only for an allowed site', async () => {
    const ok = await call('OPTIONS', '/print', { Origin: 'https://pos.example.com', 'Access-Control-Request-Method': 'POST' });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-private-network']).toBe('true');
    const no = await call('OPTIONS', '/print', { Origin: 'https://evil.example.net' });
    expect(no.status).toBe(403);
  });

  it('rejects an empty job and an oversized one, and reports a printer that is switched off', async () => {
    expect((await post('/print', Buffer.alloc(0), { Origin: 'https://pos.example.com' })).status).toBe(400);
    const big = await post('/print', Buffer.alloc(300 * 1024, 1), { Origin: 'https://pos.example.com' }).catch(() => ({ status: 413 }));
    expect(big.status).toBe(413);

    const dead = createBridge({ host: '127.0.0.1', port: 1, allowOrigins: ['https://pos.example.com'] });
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const prev = base; base = `http://127.0.0.1:${dead.address().port}`;
    const res = await post('/print', Buffer.from('x'), { Origin: 'https://pos.example.com' });
    base = prev;
    await new Promise((r) => dead.close(r));
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/Could not reach the printer/);
  });

  it('reports its status', async () => {
    const res = await call('GET', '/status', { Origin: 'https://pos.example.com' });
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });
});

describe('drawer=cash', () => {
  const { app: a, request: rq } = require('./setup');
  it('opens the drawer for a sale that took cash, not for one paid entirely by M-Pesa', async () => {
    const token = await loginAsAdmin();
    const product = db.prepare(`SELECT id, sell_price FROM products WHERE is_active = 1 AND approval_status = 'approved' LIMIT 1`).get();
    const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
    db.prepare('UPDATE inventory SET quantity = quantity + 20 WHERE product_id = ? AND store_id = ?').run(product.id, store.id);
    const sell = async (payments) => (await rq(a).post('/api/sales').set(auth(token)).send({ items: [{ product_id: product.id, quantity: 1 }], payments })).body.data.id;
    const bytes = async (id) => (await rq(a).get(`/api/sales/${id}/receipt.escpos?drawer=cash`).set(auth(token)).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); })).body;
    const mpesa = await sell([{ method: 'mobile_money', amount: product.sell_price }]);
    const cash = await sell([{ method: 'cash', amount: product.sell_price }]);
    expect((await bytes(mpesa)).includes(DRAWER)).toBe(false);
    expect((await bytes(cash)).includes(DRAWER)).toBe(true);
  });
});
