const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin } = require('./setup');
const db = require('../src/config/db');

// Shared by the mobile v1.1 tests: sign people in through the real /api/v1 mobile login so every request carries a real
// phone session (which is what the audit trail's device id comes from).
const PASSWORD = 'Passw0rd!Passw0rd';
let ipN = 0;
const ip = () => { ipN += 1; return `10.77.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

function storeId() { return db.prepare('SELECT id FROM stores ORDER BY id LIMIT 1').get().id; }

async function makeUser(role, tag) {
  const email = `v11-${tag || role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const id = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId(), `${role} ${tag || ''}`.trim(), email, bcrypt.hashSync(PASSWORD, 4), role).lastInsertRowid;
  const login = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip())
    .send({ email, password: PASSWORD, device: { deviceId: `v11-${id}`, name: 'Test phone', platform: 'android 13', appVersion: '1.1.0' } });
  if (login.status !== 200) throw new Error(`mobile login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { id: Number(id), token: login.body.token, sessionId: login.body.session.id, email, role };
}

async function makeAdmin() {
  const admin = db.prepare(`SELECT id, email FROM users WHERE email = 'admin@urbantrends.com'`).get();
  const login = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip())
    .send({ email: admin.email, password: 'ChangeMe123!', device: { deviceId: 'v11-admin', name: 'Admin phone', platform: 'android 13', appVersion: '1.1.0' } });
  if (login.status !== 200) throw new Error(`admin mobile login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { id: admin.id, token: login.body.token, sessionId: login.body.session.id, role: 'admin' };
}

const grant = (userId, key) => db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, 1)`).run(userId, key);
const revoke = (userId, key) => db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, ?, 0)`).run(userId, key);

let n = 0;
function makeCategory(name) {
  n += 1;
  return Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(`${name || 'Cat'} ${Date.now()}-${n}`).lastInsertRowid);
}
function makeProduct({ categoryId = null, sell = 100000, cost = 60000, active = 1, catalogue = 'shop' } = {}) {
  n += 1;
  const sku = `V11-${Date.now()}-${n}`;
  const id = Number(db.prepare(`INSERT INTO products (sku, barcode, name, category_id, cost_price, sell_price, is_active, catalogue) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sku, `BC${Date.now()}${n}`, `Product ${n}`, categoryId, cost, sell, active, catalogue).lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 0)').run(id, storeId());
  return { id, sku };
}
const priceOf = (id) => db.prepare('SELECT sell_price FROM products WHERE id = ?').get(id).sell_price;
const lastLog = (entityType, entityId) => {
  const row = db.prepare(`SELECT * FROM staff_logs WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1`).get(entityType, entityId);
  return row ? { ...row, changes: JSON.parse(row.changes) } : null;
};

module.exports = { app, request, loginAsAdmin, auth, makeUser, makeAdmin, grant, revoke, makeCategory, makeProduct, priceOf, lastLog, storeId, PASSWORD };
