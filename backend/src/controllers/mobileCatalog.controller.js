const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1, deviceIdOf } = require('../utils/mobileAudit');
const { canSeeCost, forUser } = require('../utils/mobileCost');
const priceHistory = require('../services/priceHistory.service');
const settingsService = require('../services/settings.service');
const securityAlerts = require('../services/securityAlerts.service');

// The phone's quick catalog: find a product, fix a price, add a category. Not the full web catalog screen. Every write needs
// products.manage (route level); cost is only ever shown to, or accepted from, people holding products.view_cost.

const PRODUCT_SQL = `
  SELECT p.id, p.sku, p.barcode, p.name, p.category_id, c.name AS category_name, p.sell_price, p.cost_price,
         p.is_active, p.catalogue, p.approval_status, p.updated_at
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

function present(user, row) {
  return forUser(user, {
    id: row.id, sku: row.sku, barcode: row.barcode, name: row.name,
    categoryId: row.category_id, categoryName: row.category_name,
    sellPriceCents: row.sell_price,
    costPriceCents: row.cost_price,
    marginCents: row.sell_price - row.cost_price,
    isActive: row.is_active === 1, catalogue: row.catalogue, approvalStatus: row.approval_status, updatedAt: row.updated_at,
  });
}
const load = (id) => db.prepare(`${PRODUCT_SQL} WHERE p.id = ?`).get(id);

const list = asyncHandler(async (req, res) => {
  const limit = cursorUtil.pageSize(req.query.limit);
  const where = [`p.approval_status = 'approved'`, 'p.catalogue = @catalogue'];
  const params = { catalogue: req.query.catalogue === 'online' ? 'online' : 'shop' };
  // Active products by default; ?active=0 shows the switched-off ones.
  where.push('p.is_active = @active');
  params.active = req.query.active === '0' ? 0 : 1;
  if (req.query.q) {
    where.push('(p.name LIKE @q OR p.sku LIKE @q OR p.barcode LIKE @q)');
    params.q = `%${String(req.query.q).slice(0, 100)}%`;
  }
  if (req.query.categoryId) {
    where.push('p.category_id = @categoryId');
    params.categoryId = Number(req.query.categoryId) || 0;
  }
  const cur = cursorUtil.decode(req.query.cursor);
  if (cur && typeof cur.n === 'string' && Number.isInteger(cur.i)) {
    where.push('(p.name COLLATE NOCASE > @cn OR (p.name COLLATE NOCASE = @cn AND p.id > @ci))');
    params.cn = cur.n; params.ci = cur.i;
  }
  const rows = db.prepare(`${PRODUCT_SQL} WHERE ${where.join(' AND ')} ORDER BY p.name COLLATE NOCASE, p.id LIMIT @take`)
    .all({ ...params, take: limit + 1 });
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  res.json({ items: page.map((r) => present(req.user, r)), nextCursor: more && last ? cursorUtil.encode({ n: last.name, i: last.id }) : null });
});

const get = asyncHandler(async (req, res) => {
  const row = load(Number(req.params.id));
  if (!row) throw new ApiError(404, 'Product not found.', null, 'NOT_FOUND');
  res.json(present(req.user, row));
});

// A SKU or barcode already on another product gets its own code so the screen can say which field to fix.
function assertUnique({ sku, barcode, exceptId = 0 }) {
  if (sku !== undefined && db.prepare('SELECT 1 FROM products WHERE sku = ? AND id <> ?').get(sku, exceptId)) {
    throw new ApiError(409, 'Another product already uses that SKU.', null, 'DUPLICATE_SKU');
  }
  if (barcode && db.prepare('SELECT 1 FROM products WHERE barcode = ? AND id <> ?').get(barcode, exceptId)) {
    throw new ApiError(409, 'Another product already uses that barcode.', null, 'DUPLICATE_BARCODE');
  }
}
function assertCategory(categoryId) {
  if (categoryId == null) return;
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new ApiError(400, 'That category does not exist.', null, 'INVALID_CATEGORY');
}
function assertNoCostWithoutPermission(req, body) {
  if (body.costPriceCents !== undefined && !canSeeCost(req.user)) {
    throw new ApiError(403, 'You do not have permission to set buying prices.', null, 'FORBIDDEN');
  }
}

const create = asyncHandler(async (req, res) => {
  const b = req.body;
  assertNoCostWithoutPermission(req, b);
  if (b.sellPriceCents <= 0) throw new ApiError(400, 'The selling price must be more than zero.', null, 'INVALID_PRICE');
  assertUnique({ sku: b.sku, barcode: b.barcode || null });
  assertCategory(b.categoryId);

  const txn = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO products (sku, barcode, name, category_id, cost_price, sell_price, is_active, approval_status, submitted_by_staff_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?)
    `).run(b.sku, b.barcode || null, b.name, b.categoryId || null, b.costPriceCents || 0, b.sellPriceCents, b.isActive === false ? 0 : 1, req.user.id);
    // Same as the web: the new product gets a zero stock row for this shop so it appears in stock lists straight away.
    db.prepare('INSERT OR IGNORE INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 0)').run(r.lastInsertRowid, req.user.storeId);
    return Number(r.lastInsertRowid);
  });
  const id = txn();
  const row = load(id);
  auditV1(req, { action: 'create', entityType: 'product', entityId: id, after: { sku: row.sku, name: row.name, sell_price: row.sell_price, category_id: row.category_id } });
  res.status(201).json(present(req.user, row));
});

const patch = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) throw new ApiError(404, 'Product not found.', null, 'NOT_FOUND');
  const b = req.body;
  assertNoCostWithoutPermission(req, b);

  const priceChanging = b.sellPriceCents !== undefined && b.sellPriceCents !== existing.sell_price;
  if (b.sellPriceCents !== undefined && b.sellPriceCents <= 0) throw new ApiError(400, 'The selling price must be more than zero.', null, 'INVALID_PRICE');
  const reason = (b.reason || '').trim();
  if (priceChanging && reason.length < 3) throw new ApiError(400, 'Say why the price is changing.', null, 'REASON_REQUIRED');
  assertUnique({ sku: b.sku, barcode: b.barcode, exceptId: id });
  if (b.categoryId !== undefined) assertCategory(b.categoryId);

  const next = {
    sku: b.sku ?? existing.sku,
    barcode: b.barcode !== undefined ? (b.barcode || null) : existing.barcode,
    name: b.name ?? existing.name,
    category_id: b.categoryId !== undefined ? b.categoryId : existing.category_id,
    sell_price: b.sellPriceCents ?? existing.sell_price,
    cost_price: b.costPriceCents ?? existing.cost_price,
    is_active: b.isActive === undefined ? existing.is_active : (b.isActive ? 1 : 0),
  };
  db.transaction(() => {
    db.prepare(`UPDATE products SET sku=@sku, barcode=@barcode, name=@name, category_id=@category_id, sell_price=@sell_price,
                cost_price=@cost_price, is_active=@is_active, updated_at=datetime('now') WHERE id=@id`).run({ ...next, id });
    if (priceChanging) {
      priceHistory.record({ productId: id, oldCents: existing.sell_price, newCents: next.sell_price, reason, userId: req.user.id, deviceId: deviceIdOf(req), source: 'edit' });
    }
  })();

  // Audit: cost is confidential, so a cost change is logged without its figures.
  const before = { sku: existing.sku, barcode: existing.barcode, name: existing.name, category_id: existing.category_id, sell_price: existing.sell_price, is_active: existing.is_active };
  const after = { sku: next.sku, barcode: next.barcode, name: next.name, category_id: next.category_id, sell_price: next.sell_price, is_active: next.is_active };
  if (next.cost_price !== existing.cost_price) { before.cost_changed = false; after.cost_changed = true; }
  auditV1(req, { action: 'update', entityType: 'product', entityId: id, before, after, reason: reason || null });
  if (priceChanging) {
    securityAlerts.priceChanged({ storeId: req.user.storeId, actor: { id: req.user.id, name: req.user.name }, product: next.name, oldCents: existing.sell_price, newCents: next.sell_price });
  }
  res.json(present(req.user, load(id)));
});

const history = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new ApiError(404, 'Product not found.', null, 'NOT_FOUND');
  const cur = cursorUtil.decode(req.query.cursor);
  const { rows, more } = priceHistory.list(id, { afterId: cur && Number.isInteger(cur.i) ? cur.i : null, limit: cursorUtil.pageSize(req.query.limit) });
  res.json({
    items: rows.map((h) => ({
      id: h.id, oldPriceCents: h.old_price, newPriceCents: h.new_price, reason: h.reason, source: h.source, batchId: h.batch_id,
      changedBy: { id: h.changed_by, name: h.changed_by_name || 'Unknown' }, changedAt: h.changed_at,
    })),
    nextCursor: more ? cursorUtil.encode({ i: rows[rows.length - 1].id }) : null,
  });
});

const catalogSettings = asyncHandler(async (req, res) => {
  const s = settingsService.getAll();
  res.json({ priceMaster: s.price_master === 'online' ? 'online' : 'pos', pricePushOnline: s.price_push_online === '1', pushImplemented: false });
});

// ---------------------------------------------------------------- categories
const CATEGORY_SQL = `
  SELECT c.id, c.name, c.parent_id, c.is_archived, c.sort_order,
         (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1 AND p.catalogue = 'shop') AS product_count
  FROM categories c`;
const presentCategory = (c) => ({ id: c.id, name: c.name, parentId: c.parent_id, isActive: c.is_archived === 0, sortOrder: c.sort_order, productCount: c.product_count });
const allCategories = (includeInactive) => db.prepare(`${CATEGORY_SQL} ${includeInactive ? '' : 'WHERE c.is_archived = 0'} ORDER BY c.sort_order, c.name COLLATE NOCASE, c.id`).all().map(presentCategory);

function assertNameFree(name, parentId, exceptId = 0) {
  const clash = db.prepare(`SELECT 1 FROM categories WHERE is_archived = 0 AND lower(name) = lower(?) AND parent_id IS ? AND id <> ?`).get(name, parentId ?? null, exceptId);
  if (clash) throw new ApiError(409, 'There is already a category with that name.', null, 'DUPLICATE_NAME');
}

const listCategories = asyncHandler(async (req, res) => {
  res.json({ items: allCategories(req.query.includeInactive === '1' || req.query.includeInactive === 'true') });
});

const createCategory = asyncHandler(async (req, res) => {
  const { name, parentId } = req.body;
  if (parentId) assertCategory(parentId);
  assertNameFree(name, parentId);
  // New categories go to the end of the list.
  const last = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories').get().m;
  const r = db.prepare('INSERT INTO categories (name, parent_id, sort_order) VALUES (?, ?, ?)').run(name, parentId || null, last + 1);
  const id = Number(r.lastInsertRowid);
  auditV1(req, { action: 'create', entityType: 'category', entityId: id, after: { name, parent_id: parentId || null } });
  res.status(201).json(presentCategory(db.prepare(`${CATEGORY_SQL} WHERE c.id = ?`).get(id)));
});

const patchCategory = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!existing) throw new ApiError(404, 'Category not found.', null, 'NOT_FOUND');
  const { name, isActive } = req.body;
  const newName = name ?? existing.name;
  const willBeActive = isActive === undefined ? existing.is_archived === 0 : isActive;
  if (willBeActive && (name !== undefined || existing.is_archived === 1)) assertNameFree(newName, existing.parent_id, id);
  // Archiving hides the category from pickers but never touches the products filed under it (same as the web).
  db.prepare(`UPDATE categories SET name = ?, is_archived = ?, archived_at = ? WHERE id = ?`)
    .run(newName, willBeActive ? 0 : 1, willBeActive ? null : (existing.archived_at || new Date().toISOString()), id);
  auditV1(req, { action: 'update', entityType: 'category', entityId: id,
    before: { name: existing.name, is_archived: existing.is_archived }, after: { name: newName, is_archived: willBeActive ? 0 : 1 } });
  res.json(presentCategory(db.prepare(`${CATEGORY_SQL} WHERE c.id = ?`).get(id)));
});

const reorderCategories = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  if (new Set(ids).size !== ids.length) throw new ApiError(400, 'A category appears twice in the new order.', null, 'INVALID_ORDER');
  const found = db.prepare(`SELECT id FROM categories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).length;
  if (found !== ids.length) throw new ApiError(400, 'One of those categories does not exist.', null, 'INVALID_ORDER');
  db.transaction(() => {
    const set = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
    ids.forEach((cid, i) => set.run(i, cid));
  })();
  auditV1(req, { action: 'update', entityType: 'category_order', entityId: ids[0], after: { order: ids.join(',') } });
  res.json({ items: allCategories(true) });
});

module.exports = { list, get, create, patch, history, catalogSettings, listCategories, createCategory, patchCategory, reorderCategories, present };
