const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { PAGINATION } = require('../config/limits');
const permissionsService = require('../services/permissions.service');
const notifications = require('../services/notifications.service');
const { logStaffAction } = require('../utils/auditLog');

// Buying price is confidential: it is removed from every product the API returns unless the person holds
// 'products.view_cost' (admin and manager by default). Done here, server-side, so hiding it on screen is not the
// only protection — a cashier opening the browser's network tab sees no cost either.
const canSeeCost = (user) => permissionsService.can(user, 'products.view_cost');
function withoutCost(product) {
  if (!product) return product;
  const { cost_price, ...rest } = product; // eslint-disable-line no-unused-vars
  return rest;
}
const present = (user, product) => (canSeeCost(user) ? product : withoutCost(product));

// GET /api/products?q=&category_id=&page=1&pageSize=25
const list = asyncHandler(async (req, res) => {
  const { q, category_id } = req.query;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const pageSize = Math.min(parseInt(req.query.pageSize) || PAGINATION.DEFAULT_PAGE_SIZE, PAGINATION.MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const where = ['p.is_active = 1'];
  const params = {};
  if (q) {
    where.push('(p.name LIKE @q OR p.sku LIKE @q OR p.barcode LIKE @q)');
    params.q = `%${q}%`;
  }
  if (category_id) {
    where.push('p.category_id = @category_id');
    params.category_id = category_id;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name,
           COALESCE(SUM(i.quantity), 0) AS total_stock
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory i ON i.product_id = p.id
    ${whereSql}
    GROUP BY p.id
    ORDER BY p.name ASC
    LIMIT @pageSize OFFSET @offset
  `).all({ ...params, pageSize, offset });

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM products p ${whereSql}
  `).get(params).c;

  const seeCost = canSeeCost(req.user);
  res.json({ data: seeCost ? rows : rows.map(withoutCost), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
});

// GET /api/products/barcode/:code  — fast lookup for scanner input at checkout
const getByBarcode = asyncHandler(async (req, res) => {
  const product = db.prepare(`
    SELECT p.*, COALESCE(SUM(i.quantity), 0) AS total_stock
    FROM products p LEFT JOIN inventory i ON i.product_id = p.id
    WHERE p.barcode = ? AND p.is_active = 1
    GROUP BY p.id
  `).get(req.params.code);
  if (!product) throw new ApiError(404, 'No product found for that barcode.');
  res.json({ data: present(req.user, product) });
});

// GET /api/products/:id
const getById = asyncHandler(async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  // A proposal that has not been approved is only visible to whoever proposed it and to the people who approve.
  if (product.approval_status !== 'approved'
      && product.submitted_by_staff_id !== req.user.id
      && !permissionsService.can(req.user, 'products.approve')) {
    throw new ApiError(404, 'Product not found.');
  }
  res.json({ data: present(req.user, product) });
});

// POST /api/products
// Two kinds of caller reach this route. Someone who can manage products creates the product straight away.
// Someone who can only PROPOSE products (the storekeeper) creates a pending proposal: it is saved inactive, any
// buying price they typed is ignored (they are not meant to know or set it), and a manager approves it later.
const create = asyncHandler(async (req, res) => {
  const { sku, barcode, name, description, category_id, brand, cost_price, sell_price, image_url } = req.body;
  if (!sku || !name || sell_price == null) {
    throw new ApiError(400, 'sku, name, and sell_price are required.');
  }

  const direct = permissionsService.can(req.user, 'products.manage');
  const proposing = !direct;
  const costToStore = canSeeCost(req.user) && !proposing ? (cost_price || 0) : 0;

  const result = db.prepare(`
    INSERT INTO products (sku, barcode, name, description, category_id, brand, cost_price, sell_price, image_url,
                          is_active, approval_status, submitted_by_staff_id)
    VALUES (@sku, @barcode, @name, @description, @category_id, @brand, @cost_price, @sell_price, @image_url,
            @is_active, @approval_status, @submitted_by)
  `).run({
    sku, barcode: barcode || null, name, description: description || null,
    category_id: category_id || null, brand: brand || null,
    cost_price: costToStore, sell_price,
    image_url: image_url || null,
    is_active: proposing ? 0 : 1,
    approval_status: proposing ? 'pending' : 'approved',
    submitted_by: req.user.id,
  });

  // Initialize inventory row at 0 for the requester's store so it shows up immediately
  db.prepare(`
    INSERT OR IGNORE INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 0)
  `).run(result.lastInsertRowid, req.user.storeId);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  if (proposing) {
    logStaffAction({ staffId: req.user.id, action: 'create', entityType: 'product', entityId: product.id, after: withoutCost(product) });
    notifications.notify({
      storeId: req.user.storeId, roles: ['admin', 'manager'], type: 'product_proposed',
      title: 'New product waiting for approval',
      body: `${req.user.name} proposed "${product.name}" (${product.sku}).`,
      entityType: 'product', entityId: product.id, dedupeKey: `product_proposed:${product.id}`,
    });
  }
  res.status(201).json({ data: present(req.user, product) });
});

// GET /api/products/pending/list — proposals waiting for a decision (approvers), or the caller's own proposals.
const listPending = asyncHandler(async (req, res) => {
  const approver = permissionsService.can(req.user, 'products.approve');
  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name, u.name AS submitted_by_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN users u ON u.id = p.submitted_by_staff_id
    WHERE p.approval_status = 'pending' ${approver ? '' : 'AND p.submitted_by_staff_id = @me'}
    ORDER BY p.created_at ASC
  `).all({ me: req.user.id });
  res.json({ data: rows.map((r) => present(req.user, r)) });
});

// POST /api/products/:id/approve  { cost_price?, sell_price? } — the approver may fill in the buying price here.
const approve = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');
  if (existing.approval_status !== 'pending') throw new ApiError(409, 'This product is not waiting for approval.');
  if (existing.submitted_by_staff_id === req.user.id && req.user.role !== 'admin') {
    throw new ApiError(403, 'You proposed this product, so someone else has to approve it.');
  }

  const cost = req.body.cost_price;
  const sell = req.body.sell_price;
  for (const [label, v] of [['cost_price', cost], ['sell_price', sell]]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new ApiError(400, `${label} must be a whole number of cents, zero or more.`);
  }

  db.prepare(`
    UPDATE products SET approval_status = 'approved', is_active = 1,
      cost_price = @cost, sell_price = @sell,
      reviewed_by_staff_id = @by, reviewed_at = datetime('now'), review_note = NULL, updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: existing.id, by: req.user.id, cost: cost !== undefined && canSeeCost(req.user) ? cost : existing.cost_price, sell: sell !== undefined ? sell : existing.sell_price });

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'product', entityId: product.id, before: withoutCost(existing), after: withoutCost(product) });
  if (existing.submitted_by_staff_id) {
    notifications.notify({
      storeId: req.user.storeId, userIds: [existing.submitted_by_staff_id], type: 'product_approved',
      title: 'Product approved', body: `"${product.name}" is now in the catalog.`, entityType: 'product', entityId: product.id,
    });
  }
  res.json({ data: present(req.user, product) });
});

// POST /api/products/:id/reject  { note } — a reason is required so the storekeeper knows what to fix.
const reject = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');
  if (existing.approval_status !== 'pending') throw new ApiError(409, 'This product is not waiting for approval.');
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (!note) throw new ApiError(400, 'Say why you are rejecting it (note is required).');

  db.prepare(`
    UPDATE products SET approval_status = 'rejected', is_active = 0,
      reviewed_by_staff_id = ?, reviewed_at = datetime('now'), review_note = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, note, existing.id);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'product', entityId: product.id, before: withoutCost(existing), after: withoutCost(product) });
  if (existing.submitted_by_staff_id) {
    notifications.notify({
      storeId: req.user.storeId, userIds: [existing.submitted_by_staff_id], type: 'product_rejected', severity: 'warning',
      title: 'Product rejected', body: `"${product.name}": ${note}`, entityType: 'product', entityId: product.id,
    });
  }
  res.json({ data: present(req.user, product) });
});

// PUT /api/products/:id
const update = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');

  const fields = ['sku', 'barcode', 'name', 'description', 'category_id', 'brand', 'cost_price', 'sell_price', 'image_url'];
  // Someone allowed to edit products but not to see buying prices cannot change one either.
  const editable = canSeeCost(req.user) ? fields : fields.filter((f) => f !== 'cost_price');
  const updates = { cost_price: existing.cost_price };
  for (const f of fields) {
    updates[f] = editable.includes(f) && req.body[f] !== undefined ? req.body[f] : existing[f];
  }

  db.prepare(`
    UPDATE products SET
      sku=@sku, barcode=@barcode, name=@name, description=@description,
      category_id=@category_id, brand=@brand, cost_price=@cost_price,
      sell_price=@sell_price, image_url=@image_url,
      updated_at=datetime('now')
    WHERE id=@id
  `).run({ ...updates, id: req.params.id });

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  require('../services/securityAlerts.service').priceChanged({
    storeId: req.user.storeId, actor: { id: req.user.id, name: req.user.name }, product: product.name, oldCents: existing.sell_price, newCents: product.sell_price,
  });
  res.json({ data: present(req.user, product) });
});

// DELETE /api/products/:id  (soft delete — never hard-delete sold products, breaks sales history)
const remove = asyncHandler(async (req, res) => {
  const result = db.prepare(`UPDATE products SET is_active = 0 WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) throw new ApiError(404, 'Product not found.');
  res.status(204).send();
});

module.exports = { list, getByBarcode, getById, create, listPending, approve, reject, update, remove };
