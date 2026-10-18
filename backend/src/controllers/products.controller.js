const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { PAGINATION } = require('../config/limits');

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

  res.json({ data: rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
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
  res.json({ data: product });
});

// GET /api/products/:id
const getById = asyncHandler(async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) throw new ApiError(404, 'Product not found.');
  res.json({ data: product });
});

// POST /api/products
const create = asyncHandler(async (req, res) => {
  const { sku, barcode, name, description, category_id, brand, cost_price, sell_price, image_url } = req.body;
  if (!sku || !name || sell_price == null) {
    throw new ApiError(400, 'sku, name, and sell_price are required.');
  }

  const result = db.prepare(`
    INSERT INTO products (sku, barcode, name, description, category_id, brand, cost_price, sell_price, image_url)
    VALUES (@sku, @barcode, @name, @description, @category_id, @brand, @cost_price, @sell_price, @image_url)
  `).run({
    sku, barcode: barcode || null, name, description: description || null,
    category_id: category_id || null, brand: brand || null,
    cost_price: cost_price || 0, sell_price,
    image_url: image_url || null,
  });

  // Initialize inventory row at 0 for the requester's store so it shows up immediately
  db.prepare(`
    INSERT OR IGNORE INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 0)
  `).run(result.lastInsertRowid, req.user.storeId);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ data: product });
});

// PUT /api/products/:id
const update = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Product not found.');

  const fields = ['sku', 'barcode', 'name', 'description', 'category_id', 'brand', 'cost_price', 'sell_price', 'image_url'];
  const updates = {};
  for (const f of fields) {
    updates[f] = req.body[f] !== undefined ? req.body[f] : existing[f];
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
  res.json({ data: product });
});

// DELETE /api/products/:id  (soft delete — never hard-delete sold products, breaks sales history)
const remove = asyncHandler(async (req, res) => {
  const result = db.prepare(`UPDATE products SET is_active = 0 WHERE id = ?`).run(req.params.id);
  if (result.changes === 0) throw new ApiError(404, 'Product not found.');
  res.status(204).send();
});

module.exports = { list, getByBarcode, getById, create, update, remove };
