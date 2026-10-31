const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { logStaffAction } = require('../utils/auditLog');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { dateParam } = require('../utils/storeTime');
const permissionsService = require('../services/permissions.service');
const notifications = require('../services/notifications.service');
const stock = require('../services/stock.service');
const { nextAutoSku } = require('../utils/autoSku');
const { createSupplier } = require('./suppliers.controller');

// Which branch's records the caller is looking at: their own, unless they can review stock and name another.
function scopeStore(req) {
  const wanted = req.query.store_id;
  if (wanted && Number(wanted) !== req.user.storeId) {
    if (!permissionsService.can(req.user, 'stock.review')) throw new ApiError(403, 'You can only look at your own branch.');
    if (!stock.getStore(Number(wanted))) throw new ApiError(404, 'Branch not found.');
    return Number(wanted);
  }
  return req.user.storeId;
}

// ---- categories ----------------------------------------------------------------------------------------------------
// A storekeeper may add a SUB-category while receiving (inside a category that already exists); a brand-new top-level
// category is for people who manage products. An existing sub-category with the same name is reused, never duplicated.
function resolveCategory(user, np, canManage) {
  if (np.category_id) {
    const c = db.prepare('SELECT id, is_archived FROM categories WHERE id = ?').get(np.category_id);
    if (!c || c.is_archived) throw new ApiError(400, 'That category does not exist (or has been archived).');
    return c.id;
  }
  const nc = np.new_category;
  if (!nc) return null;
  const name = stock.trimmed(nc.name);
  if (!name) throw new ApiError(400, 'A new category needs a name.');
  let parentId = null;
  if (nc.parent_id) {
    const parent = db.prepare('SELECT id, is_archived FROM categories WHERE id = ?').get(nc.parent_id);
    if (!parent || parent.is_archived) throw new ApiError(400, 'The category to put the sub-category in does not exist.');
    parentId = parent.id;
  } else if (!canManage) {
    throw new ApiError(403, 'You can add a sub-category inside an existing category. A new top-level category has to be added by a manager.');
  }
  const existing = db.prepare(`
    SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND COALESCE(parent_id, 0) = ? AND is_archived = 0
  `).get(name, parentId || 0);
  if (existing) return existing.id;
  const id = db.prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)').run(name, parentId).lastInsertRowid;
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'category', entityId: id, after: { name, parent_id: parentId } });
  return id;
}

// ---- reading -------------------------------------------------------------------------------------------------------
function withItems(receipts) {
  if (receipts.length === 0) return receipts;
  const ids = receipts.map((r) => r.id);
  const items = db.prepare(`
    SELECT i.id, i.receipt_id, i.product_id, i.quantity, i.sell_price, i.is_new_product,
           p.name AS product_name, p.sku, p.image_url, p.approval_status AS product_status
    FROM stock_receipt_items i JOIN products p ON p.id = i.product_id
    WHERE i.receipt_id IN (${ids.map(() => '?').join(',')}) ORDER BY i.id
  `).all(...ids);
  const byReceipt = new Map(receipts.map((r) => [r.id, []]));
  for (const it of items) byReceipt.get(it.receipt_id).push(it);
  return receipts.map((r) => {
    const its = byReceipt.get(r.id);
    return { ...r, items: its, total_units: its.reduce((n, i) => n + i.quantity, 0) };
  });
}

const RECEIPT_SELECT = `
  SELECT r.*, s.name AS supplier_name, u.name AS received_by_name, st.name AS store_name
  FROM stock_receipts r
  LEFT JOIN suppliers s ON s.id = r.supplier_id
  JOIN users u ON u.id = r.received_by_staff_id
  JOIN stores st ON st.id = r.store_id
`;

// GET /api/stock/receipts?from=&to=&supplier_id=&page=&limit=
const listReceipts = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const storeId = scopeStore(req);
  const from = dateParam(req.query.from, 'from', null);
  const to = dateParam(req.query.to, 'to', null);
  const where = ['r.store_id = @storeId'];
  const params = { storeId };
  if (from) { where.push('r.received_on >= @from'); params.from = from; }
  if (to) { where.push('r.received_on <= @to'); params.to = to; }
  if (req.query.supplier_id) { where.push('r.supplier_id = @supplierId'); params.supplierId = Number(req.query.supplier_id); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(`${RECEIPT_SELECT} ${whereSql} ORDER BY r.received_on DESC, r.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });
  const total = db.prepare(`SELECT COUNT(*) AS c FROM stock_receipts r ${whereSql}`).get(params).c;
  res.json(paginatedResponse({ rows: withItems(rows), total, page, limit }));
});

// GET /api/stock/receipts/:id
const getReceipt = asyncHandler(async (req, res) => {
  const row = db.prepare(`${RECEIPT_SELECT} WHERE r.id = ?`).get(req.params.id);
  if (!row || (row.store_id !== req.user.storeId && !permissionsService.can(req.user, 'stock.review'))) throw new ApiError(404, 'Receipt not found.');
  res.json({ data: withItems([row])[0] });
});

// ---- receiving -----------------------------------------------------------------------------------------------------
// POST /api/stock/receipts
// { supplier_id? | new_supplier?: {name,...}, reference?, note?, received_on?,
//   items: [ { product_id, quantity }  |  { quantity, new_product: { name, sell_price, image_url?, category_id? |
//             new_category?: {name, parent_id?}, sku?, barcode?, brand?, description? } } ] }
//
// Stock goes in straight away (it is physically on the shelf), one 'receipt' movement per line. A NEW product follows the
// same rule as the catalog: someone who can manage products creates it live; the storekeeper creates a pending proposal
// (inactive, so nothing can sell it yet) with NO buying price, and the approver adds the buying price when approving.
const createReceipt = asyncHandler(async (req, res) => {
  const user = req.user;
  const storeId = user.storeId;
  if (!stock.isMainStore(storeId)) {
    throw new ApiError(409, 'Shipments are received at the main store. Outlets are supplied by a transfer.', null, 'NOT_MAIN_STORE');
  }
  const body = req.body || {};
  if (!Array.isArray(body.items) || body.items.length === 0) throw new ApiError(400, 'Add at least one item to the shipment.');
  if (body.items.length > 200) throw new ApiError(400, 'A shipment can have at most 200 lines; split it into two receipts.');
  const receivedOn = stock.parseDate(body.received_on, 'received_on');
  if (receivedOn > stock.shopToday()) throw new ApiError(400, 'received_on cannot be in the future.');

  const canManage = permissionsService.can(user, 'products.manage');
  const canSeeCost = permissionsService.can(user, 'products.view_cost');
  const proposedIds = [];

  const txn = db.transaction(() => {
    let supplierId = null;
    if (body.supplier_id) {
      const s = db.prepare('SELECT id, is_active FROM suppliers WHERE id = ?').get(body.supplier_id);
      if (!s || !s.is_active) throw new ApiError(400, 'That supplier does not exist (or has been switched off).');
      supplierId = s.id;
    } else if (body.new_supplier) {
      const name = stock.trimmed(body.new_supplier.name);
      const found = name && db.prepare('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND is_active = 1').get(name);
      supplierId = found ? found.id : createSupplier(body.new_supplier, user.id).id;
    }

    const receiptId = db.prepare(`
      INSERT INTO stock_receipts (store_id, supplier_id, reference, note, received_on, received_by_staff_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(storeId, supplierId, stock.trimmed(body.reference) || null, stock.trimmed(body.note) || null, receivedOn, user.id).lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO stock_receipt_items (receipt_id, product_id, quantity, sell_price, is_new_product) VALUES (?, ?, ?, ?, ?)
    `);

    body.items.forEach((item, idx) => {
      const where = `Line ${idx + 1}`;
      let qty;
      try { qty = stock.parseQty(item.quantity); } catch (e) { throw new ApiError(400, `${where}: ${e.message}`); }

      if (item.product_id && item.new_product) throw new ApiError(400, `${where}: give either an existing product or a new one, not both.`);

      if (item.product_id) {
        const p = db.prepare('SELECT id, sell_price, approval_status FROM products WHERE id = ?').get(item.product_id);
        if (!p) throw new ApiError(404, `${where}: product not found.`);
        if (p.approval_status === 'rejected') throw new ApiError(409, `${where}: that product was rejected; it cannot receive stock.`);
        insertItem.run(receiptId, p.id, qty, p.sell_price, 0);
        stock.applyMovement({ productId: p.id, storeId, change: qty, reason: 'receipt', referenceType: 'receipt', referenceId: receiptId, userId: user.id });
        return;
      }

      const np = item.new_product;
      if (!np || typeof np !== 'object') throw new ApiError(400, `${where}: choose an existing product or describe a new one.`);
      const name = stock.trimmed(np.name);
      if (!name) throw new ApiError(400, `${where}: the new product needs a name.`);
      if (!Number.isInteger(np.sell_price) || np.sell_price < 0) throw new ApiError(400, `${where}: selling price must be a whole number of cents, zero or more.`);
      const dup = db.prepare('SELECT sku FROM products WHERE name = ? COLLATE NOCASE AND approval_status != \'rejected\'').get(name);
      if (dup) throw new ApiError(409, `${where}: "${name}" already exists (SKU ${dup.sku}). Receive it as an existing product instead.`);

      const sku = stock.trimmed(np.sku) || nextAutoSku();
      if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(sku)) throw new ApiError(409, `${where}: SKU "${sku}" is already used.`);
      const barcode = stock.trimmed(np.barcode) || null;
      if (barcode && db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(barcode)) throw new ApiError(409, `${where}: barcode "${barcode}" is already used.`);
      const categoryId = resolveCategory(user, np, canManage);

      const proposing = !canManage;
      const cost = canManage && canSeeCost && Number.isInteger(np.cost_price) && np.cost_price >= 0 ? np.cost_price : 0;
      const productId = db.prepare(`
        INSERT INTO products (sku, barcode, name, description, category_id, brand, cost_price, sell_price, image_url,
                              is_active, approval_status, submitted_by_staff_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sku, barcode, name, stock.trimmed(np.description) || null, categoryId, stock.trimmed(np.brand) || null, cost, np.sell_price,
        stock.trimmed(np.image_url) || null, proposing ? 0 : 1, proposing ? 'pending' : 'approved', user.id).lastInsertRowid;
      if (proposing) proposedIds.push(productId);

      insertItem.run(receiptId, productId, qty, np.sell_price, 1);
      stock.applyMovement({ productId, storeId, change: qty, reason: 'receipt', referenceType: 'receipt', referenceId: receiptId, userId: user.id });
    });

    return receiptId;
  });

  const receiptId = txn();
  const receipt = withItems([db.prepare(`${RECEIPT_SELECT} WHERE r.id = ?`).get(receiptId)])[0];
  logStaffAction({
    staffId: user.id, action: 'create', entityType: 'stock_receipt', entityId: receiptId,
    after: { store_id: storeId, supplier_id: receipt.supplier_id, reference: receipt.reference, received_on: receipt.received_on, lines: receipt.items.length, units: receipt.total_units },
  });
  for (const productId of proposedIds) {
    const p = db.prepare('SELECT name, sku FROM products WHERE id = ?').get(productId);
    notifications.notify({
      storeId, roles: ['admin', 'manager'], type: 'product_proposed',
      title: 'New product waiting for approval',
      body: `${user.name} received "${p.name}" (${p.sku}); it needs a buying price and approval before it can be sold.`,
      entityType: 'product', entityId: productId, dedupeKey: `product_proposed:${productId}`,
    });
  }
  res.status(201).json({ data: receipt });
});

// ---- issuing -------------------------------------------------------------------------------------------------------
const ISSUE_REASONS = ['damaged', 'expired', 'lost', 'internal_use', 'returned_to_supplier', 'other'];
const LOSS_REASONS = ['damaged', 'expired', 'lost'];

const ISSUE_SELECT = `
  SELECT i.*, p.name AS product_name, p.sku, u.name AS issued_by_name, s.name AS supplier_name
  FROM stock_issues i
  JOIN products p ON p.id = i.product_id
  JOIN users u ON u.id = i.issued_by_staff_id
  LEFT JOIN suppliers s ON s.id = i.supplier_id
`;

// GET /api/stock/issues?from=&to=&reason=&page=&limit=
const listIssues = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const storeId = scopeStore(req);
  const from = dateParam(req.query.from, 'from', null);
  const to = dateParam(req.query.to, 'to', null);
  const where = ['i.store_id = @storeId'];
  const params = { storeId };
  if (from) { where.push('i.issued_on >= @from'); params.from = from; }
  if (to) { where.push('i.issued_on <= @to'); params.to = to; }
  if (req.query.reason) { where.push('i.reason = @reason'); params.reason = String(req.query.reason); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(`${ISSUE_SELECT} ${whereSql} ORDER BY i.issued_on DESC, i.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });
  const total = db.prepare(`SELECT COUNT(*) AS c FROM stock_issues i ${whereSql}`).get(params).c;
  res.json(paginatedResponse({ rows, total, page, limit }));
});

// POST /api/stock/issues  { product_id, quantity, reason, supplier_id?, note?, issued_on? }
const createIssue = asyncHandler(async (req, res) => {
  const user = req.user;
  const b = req.body || {};
  if (!b.product_id) throw new ApiError(400, 'product_id is required.');
  const qty = stock.parseQty(b.quantity);
  if (!ISSUE_REASONS.includes(b.reason)) throw new ApiError(400, `reason must be one of ${ISSUE_REASONS.join(', ')}.`);
  const note = stock.trimmed(b.note);
  if (b.reason === 'other' && !note) throw new ApiError(400, 'Say what the stock was issued for (note is required for "other").');
  const issuedOn = stock.parseDate(b.issued_on, 'issued_on');
  if (issuedOn > stock.shopToday()) throw new ApiError(400, 'issued_on cannot be in the future.');
  const product = db.prepare('SELECT id, name, sku, approval_status FROM products WHERE id = ?').get(b.product_id);
  if (!product) throw new ApiError(404, 'Product not found.');
  if (product.approval_status !== 'approved') throw new ApiError(409, 'That product is still waiting for approval.');
  let supplierId = null;
  if (b.supplier_id) {
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(b.supplier_id)) throw new ApiError(400, 'That supplier does not exist.');
    supplierId = b.supplier_id;
  }

  const id = db.transaction(() => {
    const issueId = db.prepare(`
      INSERT INTO stock_issues (store_id, product_id, quantity, reason, supplier_id, note, issued_on, issued_by_staff_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.storeId, product.id, qty, b.reason, supplierId, note || null, issuedOn, user.id).lastInsertRowid;
    stock.applyMovement({ productId: product.id, storeId: user.storeId, change: -qty, reason: 'issue', referenceType: 'issue', referenceId: issueId, userId: user.id });
    return issueId;
  })();

  const issue = db.prepare(`${ISSUE_SELECT} WHERE i.id = ?`).get(id);
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'stock_issue', entityId: id, after: { product_id: product.id, quantity: qty, reason: b.reason, note: note || null } });
  if (LOSS_REASONS.includes(b.reason)) {
    notifications.notify({
      storeId: user.storeId, roles: ['admin', 'manager'], type: 'stock_issued_loss', severity: 'warning',
      title: 'Stock written off',
      body: `${user.name} issued ${qty} x "${product.name}" as ${b.reason.replace('_', ' ')}.`,
      entityType: 'stock_issue', entityId: id, dedupeKey: `stock_issue:${id}`,
    });
  }
  res.status(201).json({ data: issue });
});

module.exports = { listReceipts, getReceipt, createReceipt, listIssues, createIssue, scopeStore };
