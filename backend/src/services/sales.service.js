const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { assertLineDiscount, assertSaleDiscount, assertDiscountPercent } = require('../utils/discounts');

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
      throw new ApiError(400, `Payment total (${(paymentsSum / 100).toFixed(2)}) does not match sale total (${(total / 100).toFixed(2)}).`);
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
    // "AND quantity >= ?" makes the decrement itself refuse to go below zero, so even if the
    // check above were ever bypassed the sale rolls back instead of selling stock that is not there.
    const decrementInventory = db.prepare(`
      UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now')
      WHERE product_id = ? AND store_id = ? AND quantity >= ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_id, created_by)
      VALUES (?, ?, ?, 'sale', ?, ?)
    `);

    for (const li of lineItems) {
      insertItem.run({ ...li, sale_id: saleId });
      if (decrementInventory.run(li.quantity, li.product_id, storeId, li.quantity).changes !== 1) {
        throw new ApiError(409, 'Stock changed while this sale was being processed. Please check the cart and try again.');
      }
      insertMovement.run(li.product_id, storeId, -li.quantity, saleId, cashierId);
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
    const restock = db.prepare(`
      UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now')
      WHERE product_id = ? AND store_id = ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_id, created_by)
      VALUES (?, ?, ?, 'void', ?, ?)
    `);
    for (const item of items) {
      restock.run(item.quantity, item.product_id, sale.store_id);
      insertMovement.run(item.product_id, sale.store_id, item.quantity, saleId, userId);
    }
    db.prepare(`UPDATE sales SET status = 'voided' WHERE id = ?`).run(saleId);
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  });
  return txn();
}

module.exports = { checkout, getSaleWithItems, voidSale };
