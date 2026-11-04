const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const shopify = require('../src/services/shopify.service');
const settings = require('../src/services/settings.service');

// Who sets the shop price: approving an online listing must not overwrite a SHOP product's price while price_master is
// 'pos' (the default), but still does when the owner chooses 'online', and online-catalogue products are unaffected.

let admin; let n = 0;
beforeAll(async () => { await H.loginAsAdmin(); admin = await H.makeAdmin(); });
afterAll(() => cleanupTestDb());

function stage(productId, price) {
  n += 1;
  return Number(db.prepare(`
    INSERT INTO shopify_staging_products (platform, shopify_product_id, shopify_variant_id, name, sell_price, raw_json, match_status, matched_product_id)
    VALUES ('shopify', ?, ?, 'Online name', ?, '{}', 'update', ?)
  `).run(`pm-${Date.now()}-${n}`, `pmv-${Date.now()}-${n}`, price, productId).lastInsertRowid);
}
const approve = (id) => shopify.approve(id, H.storeId(), admin.id);
const setMaster = (v) => settings.setMany({ price_master: v }, admin.id);
afterEach(() => setMaster('pos'));

it("price_master 'pos' (the default) keeps a shop product's price but still takes the other online details", () => {
  expect(settings.getAll().price_master).toBe('pos');
  const p = H.makeProduct({ sell: 100000 });
  approve(stage(p.id, 130000));
  const row = db.prepare('SELECT sell_price, name FROM products WHERE id = ?').get(p.id);
  expect(row.sell_price).toBe(100000);
  expect(row.name).toBe('Online name');
  expect(db.prepare('SELECT COUNT(*) c FROM price_history WHERE product_id = ?').get(p.id).c).toBe(0);
});

it("price_master 'online' keeps the old behaviour and records it in the price history", () => {
  setMaster('online');
  const p = H.makeProduct({ sell: 100000 });
  approve(stage(p.id, 130000));
  expect(H.priceOf(p.id)).toBe(130000);
  const h = db.prepare('SELECT * FROM price_history WHERE product_id = ?').all(p.id);
  expect(h).toHaveLength(1);
  expect(h[0]).toMatchObject({ old_price: 100000, new_price: 130000, source: 'online_sync', changed_by: admin.id });
});

it('an online-catalogue product always takes the online price, whatever the setting', () => {
  const p = H.makeProduct({ sell: 100000, catalogue: 'online' });
  approve(stage(p.id, 90000));
  expect(H.priceOf(p.id)).toBe(90000);
  expect(db.prepare(`SELECT source FROM price_history WHERE product_id = ?`).get(p.id).source).toBe('online_sync');
});

it('the phone reports the setting', async () => {
  setMaster('online');
  const r = await require('./setup').request(require('./setup').app).get('/api/v1/catalog/settings').set(H.auth(admin));
  expect(r.body.priceMaster).toBe('online');
});
