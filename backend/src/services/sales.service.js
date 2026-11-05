const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { assertLineDiscount, assertSaleDiscount, assertDiscountPercent } = require('../utils/discounts');
const costing = require('./costing.service');
const stock = require('./stock.service');
const cashSessionsService = require('./cashSessions.service');
const { PAGINATION } = require('../config/limits');
const settingsService = require('./settings.service');
const { maxPercentFor } = require('../utils/discounts');
const money = require('../utils/money');

/**
 * items: [{ product_id, quantity, discount? }]
 * payments: [{ method, amount, reference? }]
 * clientSaleId: optional client-generated UUID for idempotency (offline register queue)
 */
function checkout({ storeId, cashierId, customerId, cashSessionId, items, payments, discountTotal = 0, clientSaleId = null, discountMaxPercent = 0 }) {
  if (!items || items.length === 0) throw new ApiError(400, 'Sale must contain at least one item.');
  if (!payments || payments.length === 0) throw new ApiError(400, 'At least one payment is required.');

  // Offline register support: if this exact sale was already accepted (the
  // register queued it, sent it, and either never saw the response or is
  // retrying after a reconnect), return the sale that already exists
  // rather than creating a second one. Checked BEFORE the transaction —
  // the common case is a plain online sale with no clientSaleId, which
  // skips this entirely.
  if (clientSaleId) {
    const existing = db.prepare('SELECT * FROM sales WHERE client_sale_id = ?').get(clientSaleId);
    if (existing) return existing;
  }

  const txn = db.transaction(() => {
    const productIds = items.map((i) => i.product_id);
    const placeholders = productIds.map(() => '?').join(',');
    const products = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders}) AND is_active = 1`).all(...productIds);
    const productMap = new Map(products.map((p) => [p.id, p]));

    let subtotal = 0;
    let grossTotal = 0;
    let lineDiscountTotal = 0;
    const lineItems = [];

    // The same product can appear on more than one line (the till lets you add it twice,
    // or a client can send it twice). Stock must be checked against the TOTAL asked for
    // per product - checking each line on its own let 3 + 3 through when only 4 were there.
    const requestedByProduct = new Map();
    for (const item of items) {
      if (!(item.quantity > 0)) {
        const name = productMap.get(item.product_id)?.name || item.product_id;
        throw new ApiError(400, `Invalid quantity for product ${name}.`);
      }
      requestedByProduct.set(item.product_id, (requestedByProduct.get(item.product_id) || 0) + item.quantity);
    }
    for (const [productId, requested] of requestedByProduct) {
      const product = productMap.get(productId);
      if (!product) throw new ApiError(404, `Product ${productId} not found or inactive.`);
      const inventoryRow = db.prepare(
        'SELECT * FROM inventory WHERE product_id = ? AND store_id = ?'
      ).get(productId, storeId);
      const available = inventoryRow ? inventoryRow.quantity : 0;
      if (available < requested) {
        throw new ApiError(409, `Insufficient stock for "${product.name}". Available: ${available}, requested: ${requested}.`);
      }
    }

    for (const item of items) {
      const product = productMap.get(item.product_id);

      const unitPrice = product.sell_price;
      const discount = item.discount || 0;
      assertLineDiscount({ discount, unitPrice, quantity: item.quantity, productName: product.name });
      // Tax is no longer added to what's charged — see CHANGES.md. tax_rate
      // is still recorded as 0 on the line item (rather than the product's
      // rate) so a sale record never implies tax was applied when it wasn't.
      const lineTotal = unitPrice * item.quantity - discount;

      subtotal += lineTotal;
      grossTotal += unitPrice * item.quantity;
      lineDiscountTotal += discount;

      lineItems.push({
        product_id: product.id,
        quantity: item.quantity,
        unit_price: unitPrice,
        tax_rate: 0,
        discount,
        line_total: lineTotal,
      });
    }

    const taxTotal = 0;
    assertSaleDiscount({ discountTotal, subtotal });
    assertDiscountPercent({ lineDiscountTotal, saleDiscount: discountTotal, grossTotal, maxPercent: discountMaxPercent });
    const total = subtotal - discountTotal;
    const paymentsSum = payments.reduce((s, p) => s + p.amount, 0);
    // Amounts are integer cents now — an exact match is the correct check
    // (no more float fuzz to tolerate), which is actually a real
    // correctness improvement over the old 1-cent tolerance: that
    // tolerance existed only to paper over float drift that can no longer
    // happen. Cents are formatted back to decimal only for the message.
    if (paymentsSum !== total) {
      throw new ApiError(400, `Payment total (${money.formatMoney(paymentsSum)}) does not match sale total (${money.formatMoney(total)}).`);
    }

    const paymentMethod = payments.length > 1 ? 'split' : payments[0].method;

    const saleResult = db.prepare(`
      INSERT INTO sales (store_id, cashier_id, customer_id, cash_session_id, subtotal, tax_total, discount_total, total, payment_method, status, client_sale_id)
      VALUES (@storeId, @cashierId, @customerId, @cashSessionId, @subtotal, @taxTotal, @discountTotal, @total, @paymentMethod, 'completed', @clientSaleId)
    `).run({
      storeId, cashierId, customerId: customerId || null, cashSessionId: cashSessionId || null,
      subtotal, taxTotal, discountTotal, total, paymentMethod, clientSaleId,
    });
    const saleId = saleResult.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, tax_rate, discount, line_total)
      VALUES (@sale_id, @product_id, @quantity, @unit_price, @tax_rate, @discount, @line_total)
    `);
    // stock.applyMovement refuses to go below zero, so even if the check above were ever bypassed the sale rolls
    // back instead of selling stock that is not there.
    const setLineCost = db.prepare('UPDATE sale_items SET cost_total = ? WHERE id = ?');
    for (const li of lineItems) {
      const itemId = insertItem.run({ ...li, sale_id: saleId }).lastInsertRowid;
      // What these units cost us, fixed now (oldest batch first, or the moving average - see costing.service.js).
      // Worked out BEFORE the movement below, so it prices the stock that is about to leave.
      setLineCost.run(costing.costOfNextUnits(li.product_id, storeId, li.quantity).cost, itemId);
      stock.applyMovement({
        productId: li.product_id, storeId, change: -li.quantity, reason: 'sale', referenceType: null, referenceId: saleId, userId: cashierId,
        shortfall: () => new ApiError(409, 'Stock changed while this sale was being processed. Please check the cart and try again.'),
      });
    }

    const insertPayment = db.prepare(`
      INSERT INTO payments (sale_id, method, amount, reference) VALUES (?, ?, ?, ?)
    `);
    for (const p of payments) {
      insertPayment.run(saleId, p.method, p.amount, p.reference || null);
    }

    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });

  try {
    return txn(); // better-sqlite3 auto-commits on success, auto-rolls-back on thrown error
  } catch (err) {
    // A genuine race: two retries of the same queued sale landed at once
    // and both got past the pre-transaction check above before either
    // inserted. idx_sales_client_sale_id is what actually stops the
    // duplicate; the loser of that race just returns the sale the winner
    // created, which is exactly the same outcome the caller wanted.
    if (clientSaleId && /UNIQUE constraint failed: sales\.client_sale_id/.test(err.message || '')) {
      const existing = db.prepare('SELECT * FROM sales WHERE client_sale_id = ?').get(clientSaleId);
      if (existing) return existing;
    }
    throw err;
  }
}

// 1.1 — scoped by storeId: without this, any authenticated user (of ANY
// store) who knows or guesses a sale id from a DIFFERENT store could view
// its full details here. storeId is required, not optional, specifically
// so a future caller can't accidentally omit it and silently reintroduce
// the same hole.
function getSaleWithItems(saleId, storeId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ? AND store_id = ?').get(saleId, storeId);
  if (!sale) return null;
  const items = db.prepare(`
    SELECT si.*, p.name AS product_name, p.sku
    FROM sale_items si JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ?
  `).all(saleId);
  const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(saleId);
  return { ...sale, items, payments };
}

// 1.1 — same reasoning as getSaleWithItems above: without store scoping, a
// manager/admin from Store B could void Store A's sale (and restock Store
// A's inventory) just by guessing/enumerating a sale id.
function voidSale(saleId, storeId, userId) {
  const txn = db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ? AND store_id = ?').get(saleId, storeId);
    if (!sale) throw new ApiError(404, 'Sale not found.');
    if (sale.status !== 'completed') throw new ApiError(409, `Sale is already ${sale.status}.`);
    if (sale.source_type !== 'local') {
      throw new ApiError(409, `This sale happened on ${sale.source_type} — void or refund it there. Restocking locally would add stock that was never subtracted in the first place.`);
    }

    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    for (const item of items) {
      stock.applyMovement({ productId: item.product_id, storeId: sale.store_id, change: item.quantity, reason: 'void', referenceType: null, referenceId: saleId, userId });
    }
    db.prepare(`UPDATE sales SET status = 'voided' WHERE id = ?`).run(saleId);
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });
  return txn();
}

// Void plus the large-void security alert. Shared by POST /api/sales/:id/void (someone holding sales.void) and the
// approval flow (a manager approving a request), so a void always does the same thing however it was authorised.
// actor: { id, name } — whose action this is on the record.
function voidSaleWithAlert(saleId, storeId, actor) {
  const sale = voidSale(saleId, storeId, actor.id);
  require('./securityAlerts.service').largeMoney({
    storeId, actor: { id: actor.id, name: actor.name }, kind: 'void', amountCents: sale?.total || 0, reference: `#${sale?.id ?? saleId}`,
  });
  return sale;
}

// POST /api/sales  — checkout

function checkoutSale({ body, user }) {
  const { items, payments, customerId, discountTotal, clientSaleId } = body;
  // Resolved from the logged-in cashier's own open session, never trusted
  // from the client — otherwise a sale could be attributed to someone
  // else's shift. A cashier with no open session just checks out with
  // cash_session_id NULL, same as before this feature existed.
  const openSession = cashSessionsService.getCurrentOpen(user.id, user.storeId);
  const sale = checkout({
    storeId: user.storeId,
    cashierId: user.id,
    customerId,
    cashSessionId: openSession?.id || null,
    items,
    payments,
    discountTotal: discountTotal || 0,
    clientSaleId: clientSaleId || null,
    discountMaxPercent: maxPercentFor(user.role, settingsService.getAll()),
  });
  return { data: getSaleWithItems(sale.id, user.storeId) };
}

// GET /api/sales?from=&to=&cashier_id=&page=&pageSize=
function listSales({ query: reqQuery, user: reqUser }) {
  const page = Math.max(parseInt(reqQuery.page) || 1, 1);
  const pageSize = Math.min(parseInt(reqQuery.pageSize) || PAGINATION.DEFAULT_PAGE_SIZE, PAGINATION.MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  // 1.2 — always scoped to the caller's own store. There used to be an
  // `includeAllChannels=1` flag here that swapped the store filter for
  // `1=1`, letting ANY authenticated user (not just admins — any role, any
  // store) see every other store's sales just by passing that query
  // param. "Channels" here means local register vs. Shopify vs. WooCommerce
  // (source_type, filterable below) — it never meant "other stores'
  // physical branches," so removing the store-boundary bypass doesn't
  // remove any real capability, just the accidental leak. If a genuine
  // cross-store rollup view is wanted later, that needs its own
  // deliberately-scoped role/permission — not a client-supplied boolean.
  const where = ['s.store_id = ?'];
  const params = [reqUser.storeId];
  if (reqQuery.from) { where.push('s.created_at >= ?'); params.push(reqQuery.from); }
  if (reqQuery.to) { where.push('s.created_at <= ?'); params.push(reqQuery.to); }
  if (reqQuery.cashier_id) { where.push('s.cashier_id = ?'); params.push(reqQuery.cashier_id); }
  if (reqQuery.source_type) { where.push('s.source_type = ?'); params.push(reqQuery.source_type); }
  if (reqQuery.income_source_id) { where.push('s.income_source_id = ?'); params.push(reqQuery.income_source_id); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT s.*, u.name AS cashier_name, st.name AS store_name, iso.name AS income_source_name, iso.platform AS income_source_platform,
           (SELECT ar.id FROM approval_requests ar WHERE ar.sale_id = s.id AND ar.kind = 'void_sale' AND ar.status = 'pending') AS pending_void_request_id
    FROM sales s
    JOIN users u ON u.id = s.cashier_id
    LEFT JOIN stores st ON st.id = s.store_id
    LEFT JOIN income_sources iso ON iso.id = s.income_source_id
    ${whereSql}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) c FROM sales s ${whereSql}`).get(...params).c;

  return { data: rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

// GET /api/sales/:id
function getSale({ params, user }) {
  const sale = getSaleWithItems(params.id, user.storeId);
  if (!sale) throw new ApiError(404, 'Sale not found.');
  return { data: sale };
}

// POST /api/sales/:id/void  — for someone holding sales.void, restocks items. Anyone else files a request
// (POST /api/approvals) and a manager approves it; both end up in salesService.voidSaleWithAlert.
function voidSaleAndResolve({ user, params }) {
  const actor = { id: user.id, name: user.name };
  const sale = voidSaleWithAlert(params.id, user.storeId, actor);
  // A request someone had open for this sale has just been answered.
  // Required here, not at the top: approvals.service requires this file, and a top-level require would be circular.
  require('./approvals.service').resolveDirect({ kind: 'void_sale', entityId: sale.id, storeId: user.storeId, actor });
  return { data: sale };
}

module.exports = { checkout, getSaleWithItems, voidSale, voidSaleWithAlert, checkoutSale, listSales, getSale, voidSaleAndResolve };
