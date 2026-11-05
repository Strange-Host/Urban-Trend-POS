const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { PAGINATION } = require('../config/limits');
const permissionsService = require('./permissions.service');
const notifications = require('./notifications.service');
const { logStaffAction } = require('../utils/auditLog');
const stock = require('./stock.service');

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
function listProducts({ query, user }) {
  const { q, category_id } = query;
  const page = Math.max(parseInt(query.page) || 1, 1);
  const pageSize = Math.min(parseInt(query.pageSize) || PAGINATION.DEFAULT_PAGE_SIZE, PAGINATION.MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  // Two catalogues: the shop's own stocked products (default, what the till sells) and the online (Shopify/WooCommerce)
  // listings, whose stock the shop does not track. Ask for the other one with ?catalogue=online.
  const catalogue = query.catalogue === 'online' ? 'online' : 'shop';
  const where = ['p.is_active = 1', 'p.catalogue = @catalogue'];
  const params = { catalogue };
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

  const seeCost = canSeeCost(user);
  return { data: seeCost ? rows : rows.map(withoutCost), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

// GET /api/products/barcode/:code  — fast lookup for scanner input at checkout
function getProductByBarcode({ params, user }) {
  const product = db.prepare(`
    SELECT p.*, COALESCE(SUM(i.quantity), 0) AS total_stock
    FROM products p LEFT JOIN inventory i ON i.product_id = p.id
    WHERE p.barcode = ? AND p.is_active = 1 AND p.catalogue = 'shop'
    GROUP BY p.id
  `).get(params.code);
  if (!product) throw new ApiError(404, 'No product found for that barcode.');
  return { data: present(user, product) };
}

// GET /api/products/:id
function getProduct({ params, user }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  // A proposal that has not been approved is only visible to whoever proposed it and to the people who approve.
  if (product.approval_status !== 'approved'
      && product.submitted_by_staff_id !== user.id
      && !permissionsService.can(user, 'products.approve')) {
    throw new ApiError(404, 'Product not found.');
  }
  return { data: present(user, product) };
}

// POST /api/products
// Two kinds of caller reach this route. Someone who can manage products creates the product straight away.
// Someone who can only PROPOSE products (the storekeeper) creates a pending proposal: it is saved inactive, any
// buying price they typed is ignored (they are not meant to know or set it), and a manager approves it later.
function createProduct({ body, user }) {
  const { sku, barcode, name, description, category_id, brand, cost_price, sell_price, image_url } = body;
  if (!sku || !name || sell_price == null) {
    throw new ApiError(400, 'sku, name, and sell_price are required.');
  }

  const direct = permissionsService.can(user, 'products.manage');
  const proposing = !direct;
  const costToStore = canSeeCost(user) && !proposing ? (cost_price || 0) : 0;

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
    submitted_by: user.id,
  });

  // Initialize inventory row at 0 for the requester's store so it shows up immediately
  stock.ensureRow(result.lastInsertRowid, user.storeId);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  if (proposing) {
    logStaffAction({ staffId: user.id, action: 'create', entityType: 'product', entityId: product.id, after: withoutCost(product) });
    notifications.notify({
      storeId: user.storeId, roles: ['admin', 'manager'], type: 'product_proposed',
      title: 'New product waiting for approval',
      body: `${user.name} proposed "${product.name}" (${product.sku}).`,
      entityType: 'product', entityId: product.id, dedupeKey: `product_proposed:${product.id}`,
    });
  }
  return { data: present(user, product) };
}

// GET /api/products/pending/list — proposals waiting for a decision (approvers), or the caller's own proposals.
function listPendingProducts({ user }) {
  const approver = permissionsService.can(user, 'products.approve');
  const rows = db.prepare(`
    SELECT p.*, c.name AS category_name, u.name AS submitted_by_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN users u ON u.id = p.submitted_by_staff_id
    WHERE p.approval_status = 'pending' ${approver ? '' : 'AND p.submitted_by_staff_id = @me'}
    ORDER BY p.created_at ASC
  `).all({ me: user.id });
  return { data: rows.map((r) => present(user, r)) };
}

// POST /api/products/:id/approve  { cost_price?, sell_price? } — the approver may fill in the buying price here.
function approveProduct({ params, user, body }) {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');
  if (existing.approval_status !== 'pending') throw new ApiError(409, 'This product is not waiting for approval.');
  if (existing.submitted_by_staff_id === user.id && user.role !== 'admin') {
    throw new ApiError(403, 'You proposed this product, so someone else has to approve it.');
  }

  const cost = body.cost_price;
  const sell = body.sell_price;
  for (const [label, v] of [['cost_price', cost], ['sell_price', sell]]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new ApiError(400, `${label} must be a whole number of cents, zero or more.`);
  }

  db.prepare(`
    UPDATE products SET approval_status = 'approved', is_active = 1,
      cost_price = @cost, sell_price = @sell,
      reviewed_by_staff_id = @by, reviewed_at = datetime('now'), review_note = NULL, updated_at = datetime('now')
    WHERE id = @id
  `).run({ id: existing.id, by: user.id, cost: cost !== undefined && canSeeCost(user) ? cost : existing.cost_price, sell: sell !== undefined ? sell : existing.sell_price });

  // The buying price the approver just set is also the cost of the batch(es) this product was received in, which had none.
  if (cost !== undefined && canSeeCost(user)) {
    db.prepare(`
      UPDATE stock_receipt_items SET unit_cost = ?, costed_by_staff_id = ?, costed_at = datetime('now')
      WHERE product_id = ? AND unit_cost IS NULL
    `).run(cost, user.id, existing.id);
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'product', entityId: product.id, before: withoutCost(existing), after: withoutCost(product) });
  if (existing.submitted_by_staff_id) {
    notifications.notify({
      storeId: user.storeId, userIds: [existing.submitted_by_staff_id], type: 'product_approved',
      title: 'Product approved', body: `"${product.name}" is now in the catalog.`, entityType: 'product', entityId: product.id,
    });
  }
  return { data: present(user, product) };
}

// POST /api/products/:id/reject  { note } — a reason is required so the storekeeper knows what to fix.
function rejectProduct({ params, body, user }) {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');
  if (existing.approval_status !== 'pending') throw new ApiError(409, 'This product is not waiting for approval.');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) throw new ApiError(400, 'Say why you are rejecting it (note is required).');

  db.prepare(`
    UPDATE products SET approval_status = 'rejected', is_active = 0,
      reviewed_by_staff_id = ?, reviewed_at = datetime('now'), review_note = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(user.id, note, existing.id);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'product', entityId: product.id, before: withoutCost(existing), after: withoutCost(product) });
  if (existing.submitted_by_staff_id) {
    notifications.notify({
      storeId: user.storeId, userIds: [existing.submitted_by_staff_id], type: 'product_rejected', severity: 'warning',
      title: 'Product rejected', body: `"${product.name}": ${note}`, entityType: 'product', entityId: product.id,
    });
  }
  return { data: present(user, product) };
}

// PUT /api/products/:id
function updateProduct({ params, user, body }) {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');

  const fields = ['sku', 'barcode', 'name', 'description', 'category_id', 'brand', 'cost_price', 'sell_price', 'image_url'];
  // Someone allowed to edit products but not to see buying prices cannot change one either.
  const editable = canSeeCost(user) ? fields : fields.filter((f) => f !== 'cost_price');
  const updates = { cost_price: existing.cost_price };
  for (const f of fields) {
    updates[f] = editable.includes(f) && body[f] !== undefined ? body[f] : existing[f];
  }

  db.prepare(`
    UPDATE products SET
      sku=@sku, barcode=@barcode, name=@name, description=@description,
      category_id=@category_id, brand=@brand, cost_price=@cost_price,
      sell_price=@sell_price, image_url=@image_url,
      updated_at=datetime('now')
    WHERE id=@id
  `).run({ ...updates, id: params.id });

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
  require('./securityAlerts.service').priceChanged({
    storeId: user.storeId, actor: { id: user.id, name: user.name }, product: product.name, oldCents: existing.sell_price, newCents: product.sell_price,
  });
  return { data: present(user, product) };
}

// DELETE /api/products/:id  (soft delete — never hard-delete sold products, breaks sales history)
function removeProduct({ params }) {
  const result = db.prepare(`UPDATE products SET is_active = 0 WHERE id = ?`).run(params.id);
  if (result.changes === 0) throw new ApiError(404, 'Product not found.');
  return;
}


// POST /api/products/:id/catalogue  { catalogue: 'shop' | 'online', opening_stock?, clear_stock? }
// The only way a product changes catalogue (no sync ever does it).
//  -> 'shop'   puts it on the shop's shelves and at the till. opening_stock (whole units, default 0) is what the shop
//              really holds right now; it is written as a normal ledger movement.
//  -> 'online' takes it off the till and out of the shop's stock. If the shop's records still show units of it, the move
//              is refused unless clear_stock is true, which writes those units off through the ledger first, so the
//              stock history always explains where they went.
function setCatalogue({ params, body, user }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  const target = body.catalogue;
  if (!['shop', 'online'].includes(target)) throw new ApiError(400, "catalogue must be 'shop' or 'online'.");
  if (product.catalogue === target) throw new ApiError(409, `This product is already in the ${target} catalogue.`);

  const storeId = user.storeId;
  const txn = db.transaction(() => {
    if (target === 'shop') {
      const opening = body.opening_stock;
      if (opening !== undefined && opening !== null && (!Number.isInteger(opening) || opening < 0)) {
        throw new ApiError(400, 'opening_stock must be a whole number of units, zero or more.');
      }
      db.prepare(`UPDATE products SET catalogue = 'shop', updated_at = datetime('now') WHERE id = ?`).run(product.id);
      if (opening > 0) {
        stock.applyMovement({ productId: product.id, storeId, change: opening, reason: 'adjustment', referenceType: 'adjustment', referenceId: null, userId: user.id });
      }
    } else {
      const rows = db.prepare('SELECT store_id, quantity FROM inventory WHERE product_id = ? AND quantity > 0').all(product.id);
      if (rows.length && body.clear_stock !== true) {
        const units = rows.reduce((n, r) => n + r.quantity, 0);
        throw new ApiError(409, `The shop's records show ${units} unit${units === 1 ? '' : 's'} of this product. Count what is really on the shelf first, or move it with clear_stock to write them off.`, null, 'STOCK_ON_HAND');
      }
      for (const r of rows) {
        stock.applyMovement({ productId: product.id, storeId: r.store_id, change: -r.quantity, reason: 'adjustment', referenceType: 'adjustment', referenceId: null, userId: user.id });
      }
      db.prepare(`UPDATE products SET catalogue = 'online', updated_at = datetime('now') WHERE id = ?`).run(product.id);
    }
  });
  txn();

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'product', entityId: product.id, before: { catalogue: product.catalogue }, after: { catalogue: target } });
  return { data: present(user, updated) };
}

module.exports = { listProducts, getProductByBarcode, getProduct, createProduct, listPendingProducts, approveProduct, rejectProduct, updateProduct, removeProduct, setCatalogue };
