const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { normalizePhone } = require('../utils/phone');
const { logStaffAction } = require('../utils/auditLog');
const customersService = require('./customers.service');
const settingsService = require('./settings.service');
const smsService = require('./sms.service');
const couriersService = require('./couriers.service');
const courierOrganizations = require('./courierOrganizations.service');
const courierPayablesService = require('./courierPayables.service');
const notificationsService = require('./notifications.service');
const { determineDeliveryZone, suggestCourier } = require('../utils/delivery');
const deliveryAreas = require('./deliveryAreas.service');
const telesalesDistribution = require('./telesalesDistribution.service');
const { assertLineDiscount, assertSaleDiscount, assertDiscountPercent } = require('../utils/discounts');
const commissionReversal = require('./commissionReversal.service');

// State machine — see schema.sql's CHECK on orders.status for the full
// list. Stock deduction happens on the ONE transition into
// 'dispatched_unpaid' (never on creation); stock reinstatement happens on
// the ONE transition into 'returned_resellable' (never 'returned_damaged').
const TRANSITIONS = {
  awaiting_dispatch: ['dispatched_unpaid', 'cancelled'],
  dispatched_unpaid: ['dispatched_partial', 'dispatched_paid', 'returned_in_transit'],
  // Backwards moves (dispatched_partial -> unpaid, dispatched_paid -> partial/unpaid) happen only
  // when a payment is refunded - see refundPayment().
  dispatched_partial: ['dispatched_paid', 'dispatched_unpaid', 'returned_in_transit'],
  dispatched_paid: ['dispatched_partial', 'dispatched_unpaid', 'returned_in_transit'], // a paid order can still come back (customer return)
  returned_in_transit: ['returned_awaiting_inspection'],
  returned_awaiting_inspection: ['returned_resellable', 'returned_damaged'],
  returned_resellable: [],
  returned_damaged: [],
  cancelled: [],
};

// "Active" for duplicate-order prevention (§1: New/Confirmed/Dispatched/
// Pending Pickup) — only states where the SAME parcel is still pending
// resolution. Deliberately excludes the returned_* states: once a parcel
// is on its way back, that delivery attempt is over, and a repeat-rejecter
// customer needs to be ABLE to place a new order (just a prepay-required
// one, per §3) rather than being permanently blocked from ordering again.
const ACTIVE_STATUSES = ['awaiting_dispatch', 'dispatched_unpaid', 'dispatched_partial'];

const CHANNELS = ['shopify', 'wordpress', 'manual'];
const PAYMENT_TYPES = ['cod', 'prepaid', 'g4s_pickup_pay'];
const COURIER_TYPES = ['boda', 'g4s'];
const RETURN_REASONS = ['rejected', 'damaged', 'wrong_item'];
const OWNER_DECISIONS = ['write_off', 'dispose'];
const DISPUTE_OUTCOMES = ['refund', 'redelivered', 'closed'];

function assertValidTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new ApiError(
      409,
      `Cannot move an order from "${from}" to "${to}". Valid next states: ${allowed.length ? allowed.join(', ') : 'none — this status is terminal'}.`
    );
  }
}

// Writes the status column + an order_status_history row together — every
// caller below goes through this rather than touching `status` directly,
// so there's exactly one place a transition can be recorded incompletely.
function transitionTo(orderId, order, toStatus, staffId, notes = null) {
  assertValidTransition(order.status, toStatus);
  db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(toStatus, orderId);
  db.prepare(`
    INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, order.status, toStatus, notes, staffId);

  // A paid, dispatched order is the one that earns commission. If it stops being one (a payment refunded, the parcel
  // coming back), any commission already paid on it is taken back - in the same transaction as the change that
  // caused it, so the books can never show the sale gone and the commission still standing.
  if (order.status === 'dispatched_paid' && toStatus !== 'dispatched_paid') {
    commissionReversal.reverseForOrder({
      orderId, actorId: staffId,
      reason: `the order moved from paid to ${toStatus.replace(/_/g, ' ')}${notes ? ` (${notes})` : ''}`,
    });
  }
}

function findDuplicateActiveOrder({ storeId, phone }) {
  const phoneNormalized = normalizePhone(phone);
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  return db.prepare(`
    SELECT o.* FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.store_id = ? AND c.phone_normalized = ? AND o.status IN (${placeholders}) AND o.deleted_at IS NULL
  `).get(storeId, phoneNormalized, ...ACTIVE_STATUSES);
}

function findByProductCode({ storeId, productCode }) {
  return db.prepare(`
    SELECT * FROM orders WHERE store_id = ? AND product_code = ? AND deleted_at IS NULL
  `).get(storeId, productCode);
}

function computeTotals(items, discountTotal = 0, maxPercent = 0) {
  const productIds = items.map((i) => i.product_id);
  const placeholders = productIds.map(() => '?').join(',');
  const products = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders}) AND is_active = 1`).all(...productIds);
  const productMap = new Map(products.map((p) => [p.id, p]));

  let subtotal = 0;
  let grossTotal = 0;
  let lineDiscountTotal = 0;
  const lineItems = [];
  for (const item of items) {
    const product = productMap.get(item.product_id);
    if (!product) throw new ApiError(404, `Product ${item.product_id} not found or inactive.`);
    if (item.quantity <= 0) throw new ApiError(400, `Invalid quantity for product "${product.name}".`);

    const unitPrice = product.sell_price;
    const discount = item.discount || 0;
    assertLineDiscount({ discount, unitPrice, quantity: item.quantity, productName: product.name });
    const lineTotal = unitPrice * item.quantity - discount;
    subtotal += lineTotal;
    grossTotal += unitPrice * item.quantity;
    lineDiscountTotal += discount;
    lineItems.push({ product_id: product.id, quantity: item.quantity, unit_price: unitPrice, discount, line_total: lineTotal });
  }

  assertSaleDiscount({ discountTotal, subtotal });
  assertDiscountPercent({ lineDiscountTotal, saleDiscount: discountTotal, grossTotal, maxPercent });
  return { subtotal, total: subtotal - discountTotal, lineItems };
}

// Creates the order in 'awaiting_dispatch' — no stock touched yet (§1: NO
// stock deduction while awaiting dispatch). Duplicate-order check (§1) is
// by phone against any ACTIVE order for this store; a genuine duplicate
// surfaces as 409 with the existing order id so the caller can offer the
// merge-items path instead of a silent second order.
function create({ storeId, staffId, name, phone, email, city, leadId, assignedStaffId, channel, items, discountTotal, notes, paymentType, courierType, discountMaxPercent = 0 }) {
  if (!phone) throw new ApiError(400, 'phone is required.');
  if (!items || items.length === 0) throw new ApiError(400, 'Order must contain at least one item.');
  if (channel && !CHANNELS.includes(channel)) throw new ApiError(400, `channel must be one of ${CHANNELS.join(', ')}.`);
  if (paymentType && !PAYMENT_TYPES.includes(paymentType)) throw new ApiError(400, `payment_type must be one of ${PAYMENT_TYPES.join(', ')}.`);
  if (courierType && !COURIER_TYPES.includes(courierType)) throw new ApiError(400, `courier_type must be one of ${COURIER_TYPES.join(', ')}.`);

  const duplicate = findDuplicateActiveOrder({ storeId, phone });
  if (duplicate) {
    throw new ApiError(409, 'This phone number already has an active order. Merge items into it instead of creating a new one.', { existingOrderId: duplicate.id });
  }

  const txn = db.transaction(() => {
    const customer = customersService.findOrCreate({ name, phone, email, city });
    const { subtotal, total, lineItems } = computeTotals(items, discountTotal || 0, discountMaxPercent);

    // Delivery zone/courier/fee (§1/§7) — computed once at creation from
    // what's known then (customer's city); a manual courier override is
    // still accepted (e.g. staff knows better than the city string), but
    // the auto-suggestion always runs first so there's always a sane default.
    const settings = settingsService.getAll();
    const deliveryZone = determineDeliveryZone(customer.city);
    // A town on the delivery-area rate card sets the fee (and suggests its courier); anything else
    // falls back to the flat/percent rule.
    const { fee: deliveryFee, area: deliveryArea } = deliveryAreas.resolveFee({ town: customer.city, totalCents: total, settings });
    const finalCourierType = courierType || deliveryArea?.courier_type || suggestCourier(deliveryZone);
    const finalPaymentType = paymentType || 'cod';

    // §3 Equal Distribution — same reasoning as leads.service.js: an
    // explicit assignedStaffId always wins, auto-assign only fills the gap.
    const finalAssignedStaffId = assignedStaffId || telesalesDistribution.autoAssignOrder(storeId);

    // COD Confirmation Gate (§1): the clock on auto-expiry starts at
    // creation, not at some later "pending" state — an order that never
    // gets confirmed shouldn't sit forever. Only COD orders need this;
    // prepaid/G4S-pickup-and-pay orders have no unconfirmed-COD risk.
    const confirmationWindowMinutes = parseInt(settings.cod_confirmation_window_minutes, 10) || 120;
    const codConfirmationExpiresAt = finalPaymentType === 'cod'
      ? db.prepare(`SELECT datetime('now', '+' || ? || ' minutes') AS v`).get(confirmationWindowMinutes).v
      : null;

    const result = db.prepare(`
      INSERT INTO orders (
        store_id, customer_id, lead_id, assigned_staff_id, channel, subtotal, discount_total, total, notes,
        payment_type, courier_type, delivery_zone, delivery_fee, cod_confirmation_expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      storeId, customer.id, leadId || null, finalAssignedStaffId || null, channel || 'manual', subtotal, discountTotal || 0, total, notes || null,
      finalPaymentType, finalCourierType, deliveryZone, deliveryFee, codConfirmationExpiresAt
    );
    const orderId = result.lastInsertRowid;

    // Product code (§2 Payments & Reconciliation): generated right away —
    // "once a product has been keyed in as converted... it proceeds to the
    // order section where it generates a code" — so it can go out to the
    // customer immediately, before dispatch or payment. Deterministic from
    // the order id (not random), so it's collision-free by construction —
    // see idx_orders_product_code for the DB-level uniqueness guarantee.
    const productCode = `UT${String(orderId).padStart(6, '0')}`;
    db.prepare(`UPDATE orders SET product_code = ? WHERE id = ?`).run(productCode, orderId);

    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount, line_total)
      VALUES (@order_id, @product_id, @quantity, @unit_price, @discount, @line_total)
    `);
    for (const li of lineItems) insertItem.run({ ...li, order_id: orderId });

    db.prepare(`
      INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_staff_id)
      VALUES (?, NULL, 'awaiting_dispatch', ?)
    `).run(orderId, staffId);

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    logStaffAction({ staffId, action: 'create', entityType: 'order', entityId: orderId, after: order });

    // Customer SMS: only INSERTs an outbox row (no network call), so it is part
    // of this same transaction — an order that rolls back never sends a text.
    smsService.queueOrderReceived({ order, customer });
    return order;
  });

  return txn();
}

// Merge additional items into an existing order (§1) — only while it's
// still awaiting dispatch; once dispatched, the parcel is already packed
// and a merge would silently misstate what's physically in it.
function mergeItems({ orderId, storeId, staffId, items }) {
  if (!items || items.length === 0) throw new ApiError(400, 'At least one item is required to merge.');

  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.status !== 'awaiting_dispatch') {
      throw new ApiError(409, `Cannot merge items into an order that's already "${order.status}".`);
    }

    const { subtotal: addedSubtotal, lineItems } = computeTotals(items, 0);
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount, line_total)
      VALUES (@order_id, @product_id, @quantity, @unit_price, @discount, @line_total)
    `);
    for (const li of lineItems) insertItem.run({ ...li, order_id: orderId });

    const newSubtotal = order.subtotal + addedSubtotal;
    const newTotal = newSubtotal - order.discount_total;
    // The delivery fee is tiered on the order total (flat under the threshold, a percentage above it), so a
    // merge that moves the total across the threshold must move the fee too. Same rule create() applies.
    const mergeCity = db.prepare('SELECT city FROM customers WHERE id = ?').get(order.customer_id)?.city;
    const newDeliveryFee = deliveryAreas.resolveFee({ town: mergeCity, totalCents: newTotal, settings: settingsService.getAll() }).fee;
    db.prepare(`UPDATE orders SET subtotal = ?, total = ?, delivery_fee = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(newSubtotal, newTotal, newDeliveryFee, orderId);

    if (order.lead_id) {
      db.prepare(`
        INSERT INTO lead_activities (lead_id, type, content, staff_id) VALUES (?, 'note', ?, ?)
      `).run(order.lead_id, `Merged ${items.length} item(s) into order #${orderId}`, staffId);
    }

    logStaffAction({ staffId, action: 'update', entityType: 'order', entityId: orderId, before: { subtotal: order.subtotal, total: order.total, delivery_fee: order.delivery_fee }, after: { subtotal: newSubtotal, total: newTotal, delivery_fee: newDeliveryFee } });
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });

  return txn();
}

// Dispatch: awaiting_dispatch -> dispatched_unpaid. The one place stock
// actually leaves the shop (§6 Critical Inventory Rules: "Stock deduction
// happens ONLY when Dispatched is ticked").
// COD Confirmation Gate (§1): mandatory before dispatch. Not a status
// transition (the order stays 'awaiting_dispatch') — just a fact recorded
// on the order, which dispatch() below checks for. Uses a direct
// order_status_history insert (same from/to status) rather than
// transitionTo(), since assertValidTransition would otherwise reject a
// same-status "transition".
function confirmCod({ orderId, storeId, staffId }) {
  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.payment_type !== 'cod') throw new ApiError(409, `Only COD orders need confirmation (this order is "${order.payment_type}").`);
    if (order.status !== 'awaiting_dispatch') throw new ApiError(409, `Cannot confirm an order that's already "${order.status}".`);
    if (order.cod_confirmed_at) throw new ApiError(409, 'This order is already confirmed.');

    const expired = order.cod_confirmation_expires_at
      && db.prepare(`SELECT datetime('now') > ? AS v`).get(order.cod_confirmation_expires_at).v;
    if (expired) {
      transitionTo(orderId, order, 'cancelled', staffId, 'Auto-cancelled: COD confirmation window elapsed before confirmation was attempted.');
      db.prepare(`UPDATE orders SET cancelled_at = datetime('now') WHERE id = ?`).run(orderId);
      throw new ApiError(409, 'The confirmation window for this order has already elapsed — it has been cancelled.');
    }

    db.prepare(`UPDATE orders SET cod_confirmed_at = datetime('now'), cod_confirmed_by = ?, updated_at = datetime('now') WHERE id = ?`).run(staffId, orderId);
    db.prepare(`
      INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id)
      VALUES (?, ?, ?, 'COD confirmation recorded.', ?)
    `).run(orderId, order.status, order.status, staffId);

    logStaffAction({ staffId, action: 'update', entityType: 'order', entityId: orderId, before: { cod_confirmed_at: null }, after: { cod_confirmed_at: 'confirmed' } });
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  return txn();
}

// Batch job (§1: "Auto-expire unconfirmed COD orders after defined time
// window") — wired to a periodic setInterval in server.js, same pattern as
// the existing backup/reconciliation jobs. `changed_by_staff_id` is left
// NULL for these (system-initiated, not a specific staff member's action).
function expireUnconfirmedOrders() {
  const candidates = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'awaiting_dispatch' AND payment_type = 'cod' AND cod_confirmed_at IS NULL
      AND cod_confirmation_expires_at IS NOT NULL AND datetime('now') > cod_confirmation_expires_at
      AND deleted_at IS NULL
  `).all();

  const txn = db.transaction(() => {
    for (const order of candidates) {
      transitionTo(order.id, order, 'cancelled', null, 'Auto-cancelled: COD confirmation window elapsed.');
      db.prepare(`UPDATE orders SET cancelled_at = datetime('now') WHERE id = ?`).run(order.id);
    }
  });
  txn();
  return candidates.map((o) => o.id);
}

// Manual courier override (§1: auto-suggested, but staff can always
// correct it) — only while the parcel hasn't left yet.
function setCourier({ orderId, storeId, staffId, courierType, courierId }) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
  if (!order) throw new ApiError(404, 'Order not found.');
  if (order.status !== 'awaiting_dispatch') throw new ApiError(409, `Cannot change courier on an order that's already "${order.status}".`);

  // A named courier carries their own type (a rider is a boda or a G4S agent,
  // never both), so picking one sets courier_type too. Picking only a type
  // clears any previously named courier — they would no longer match.
  let finalType = courierType;
  let finalCourierId = null;
  if (courierId !== undefined && courierId !== null) {
    const courier = couriersService.assertAssignable(courierId, storeId);
    finalType = courier.courier_type;
    finalCourierId = courier.id;
  }
  if (!COURIER_TYPES.includes(finalType)) throw new ApiError(400, `courier_type must be one of ${COURIER_TYPES.join(', ')}.`);

  db.prepare(`UPDATE orders SET courier_type = ?, courier_id = ?, updated_at = datetime('now') WHERE id = ?`).run(finalType, finalCourierId, orderId);
  logStaffAction({
    staffId, action: 'update', entityType: 'order', entityId: orderId,
    before: { courier_type: order.courier_type, courier_id: order.courier_id }, after: { courier_type: finalType, courier_id: finalCourierId },
  });
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

// Dispatch: awaiting_dispatch -> dispatched_unpaid. The one place stock
// actually leaves the shop (§6 Critical Inventory Rules: "Stock deduction
// happens ONLY when Dispatched is ticked"). COD orders must be confirmed
// first (§1 Confirmation Gate) — an unconfirmed COD order that's also past
// its expiry window is auto-cancelled right here rather than dispatched.
function dispatch({ orderId, storeId, staffId, packageFee, packageFeeZeroReason }) {
  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    assertValidTransition(order.status, 'dispatched_unpaid');

    if (order.payment_type === 'cod' && !order.cod_confirmed_at) {
      const expired = order.cod_confirmation_expires_at
        && db.prepare(`SELECT datetime('now') > ? AS v`).get(order.cod_confirmation_expires_at).v;
      if (expired) {
        transitionTo(orderId, order, 'cancelled', staffId, 'Auto-cancelled: COD confirmation window elapsed.');
        db.prepare(`UPDATE orders SET cancelled_at = datetime('now') WHERE id = ?`).run(orderId);
        throw new ApiError(409, 'This COD order was never confirmed and its confirmation window has elapsed — it has been cancelled instead of dispatched.');
      }
      throw new ApiError(409, 'This COD order must be confirmed before it can be dispatched.');
    }

    // A parcel going out with a courier ORGANIZATION gets its package fee line now: the fee we will owe
    // that organization, netted off when it remits. Riders are unaffected. Rolls back with the dispatch.
    courierOrganizations.recordPackageFeeAtDispatch({ order, storeId, staffId, packageFee, zeroReason: packageFeeZeroReason });

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    const checkStock = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?');
    const decrementInventory = db.prepare(`
      UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now') WHERE product_id = ? AND store_id = ? AND quantity >= ?
    `);
    const insertMovement = db.prepare(`
      INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id, created_by)
      VALUES (?, ?, ?, 'dispatch', 'order', ?, ?)
    `);

    // Total per product first: an order can list the same product on two lines.
    const requestedByProduct = new Map();
    for (const item of items) {
      requestedByProduct.set(item.product_id, (requestedByProduct.get(item.product_id) || 0) + item.quantity);
    }
    for (const [productId, requested] of requestedByProduct) {
      const inventoryRow = checkStock.get(productId, storeId);
      const available = inventoryRow ? inventoryRow.quantity : 0;
      if (available < requested) {
        const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
        throw new ApiError(409, `Insufficient stock for "${product?.name || productId}". Available: ${available}, requested: ${requested}.`);
      }
    }
    for (const item of items) {
      if (decrementInventory.run(item.quantity, item.product_id, storeId, item.quantity).changes !== 1) {
        throw new ApiError(409, 'Stock changed while this order was being dispatched. Please try again.');
      }
      insertMovement.run(item.product_id, storeId, -item.quantity, orderId, staffId);
    }

    transitionTo(orderId, order, 'dispatched_unpaid', staffId);
    db.prepare(`UPDATE orders SET dispatched_at = datetime('now') WHERE id = ?`).run(orderId);

    // What the named courier earns for this parcel (cents), entered by staff now and owed whether or not the
    // customer collects. Same transaction as the dispatch: no fee without a dispatch, no dispatch with a refused fee.
    if (packageFee !== undefined && packageFee !== null) {
      courierPayablesService.recordPackageFee({ order, amount: packageFee, staffId });
    }

    // An order that arrived ALREADY PAID (a prepaid Shopify order) must not sit as
    // "unpaid" until someone records a payment that has in fact already happened.
    if (order.total > 0 && order.amount_paid >= order.total) {
      transitionTo(orderId, { ...order, status: 'dispatched_unpaid' }, 'dispatched_paid', staffId, 'Already paid in full before dispatch.');
    }

    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });

  return txn();
}

// Records an incoming payment against the order and moves it to
// dispatched_partial or dispatched_paid depending on how much of the total
// has now been paid. Reuses payment_records (order_id, not sale_id) rather
// than a parallel table — see schema.sql.
function recordPayment({ orderId, storeId, staffId, method, amount, reference }) {
  if (!amount || amount <= 0) throw new ApiError(400, 'amount must be a positive integer (cents).');

  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    if (!['dispatched_unpaid', 'dispatched_partial'].includes(order.status)) {
      throw new ApiError(409, `Cannot record a payment against an order that's "${order.status}".`);
    }

    const paymentInsert = db.prepare(`
      INSERT INTO payment_records (store_id, direction, order_id, method, amount, reference, recorded_by_staff_id)
      VALUES (?, 'incoming', ?, ?, ?, ?, ?)
    `).run(storeId, orderId, method, amount, reference || null, staffId);

    const newAmountPaid = order.amount_paid + amount;
    db.prepare(`UPDATE orders SET amount_paid = ?, updated_at = datetime('now') WHERE id = ?`).run(newAmountPaid, orderId);

    const toStatus = newAmountPaid >= order.total ? 'dispatched_paid' : 'dispatched_partial';
    transitionTo(orderId, { ...order, amount_paid: newAmountPaid }, toStatus, staffId, `Payment of ${amount} recorded (${method}).`);

    // Customer SMS — keyed on the payment_records row, so a redelivered
    // webhook (already de-duplicated upstream) can never text twice either.
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);
    if (customer) {
      smsService.queuePaymentReceived({
        order, customer, paymentRecordId: paymentInsert.lastInsertRowid,
        amountCents: amount, amountPaidAfterCents: newAmountPaid,
      });
    }

    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });

  return txn();
}

// A payment on this order was refunded: take it out of what the customer has paid and, while the
// parcel is still out for delivery, move the order back to the status the remaining payments justify
// (paid -> part paid -> unpaid). Before this, a refund only flipped the payment record, so the order
// kept showing "paid" and the shop's books and the order disagreed. Call inside the caller's transaction.
function refundPayment({ orderId, storeId, amount, staffId, method }) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order) return null;
  const newAmountPaid = Math.max(0, order.amount_paid - amount);
  db.prepare(`UPDATE orders SET amount_paid = ?, updated_at = datetime('now') WHERE id = ?`).run(newAmountPaid, orderId);

  if (['dispatched_paid', 'dispatched_partial'].includes(order.status)) {
    const toStatus = newAmountPaid >= order.total ? 'dispatched_paid' : newAmountPaid > 0 ? 'dispatched_partial' : 'dispatched_unpaid';
    if (toStatus !== order.status) {
      transitionTo(orderId, order, toStatus, staffId, `Payment of ${amount} refunded (${method}).`);
    }
  }
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function markReturnedInTransit({ orderId, storeId, staffId, notes, reasonCode }) {
  if (reasonCode && !RETURN_REASONS.includes(reasonCode)) {
    throw new ApiError(400, `reason_code must be one of ${RETURN_REASONS.join(', ')}.`);
  }

  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    transitionTo(orderId, order, 'returned_in_transit', staffId, notes || null);
    db.prepare(`UPDATE orders SET returned_at = datetime('now'), return_reason = ? WHERE id = ?`).run(reasonCode || null, orderId);

    // §3 Customer Risk Management — re-evaluate as soon as a return starts,
    // not only after inspection completes, since the rejection itself (not
    // its eventual condition) is the risk signal.
    customersService.evaluateRisk(order.customer_id);

    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  return txn();
}

function markReturnedAwaitingInspection({ orderId, storeId, staffId }) {
  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    transitionTo(orderId, order, 'returned_awaiting_inspection', staffId);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  return txn();
}

// Inspection is the ONE gate that decides whether stock comes back
// (§6 RMA Logic: manager approval required for resale; damaged auto-blocked).
function inspectReturn({ orderId, storeId, staffId, result, notes }) {
  if (!['good', 'damaged'].includes(result)) throw new ApiError(400, 'result must be "good" or "damaged".');

  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');

    const toStatus = result === 'good' ? 'returned_resellable' : 'returned_damaged';
    transitionTo(orderId, order, toStatus, staffId, notes || null);
    db.prepare(`
      UPDATE orders SET inspected_at = datetime('now'), inspected_by = ?, inspection_result = ? WHERE id = ?
    `).run(staffId, result, orderId);

    if (result === 'good') {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
      const restock = db.prepare(`
        UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now') WHERE product_id = ? AND store_id = ?
      `);
      const insertMovement = db.prepare(`
        INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id, created_by)
        VALUES (?, ?, ?, 'return_resellable', 'order', ?, ?)
      `);
      for (const item of items) {
        restock.run(item.quantity, item.product_id, order.store_id);
        insertMovement.run(item.product_id, order.store_id, item.quantity, orderId, staffId);
      }
    } else {
      // 'damaged' intentionally does NOT touch inventory — blocked from
      // resale until an owner decides what happens to it (§ RMA: "Owner
      // visibility and decision required for write-offs or disposal").
      // owner_notified_at IS the notification for now — there's no actual
      // SMS/email/push send here (no messaging infra exists yet, same
      // reasoning as the KCB integration gap in Phase 3) — this timestamp
      // is what makes the order show up in GET /api/orders/pending-owner-decision,
      // which is the real, buildable version of "owner gets notified" until
      // an actual notification channel exists.
      db.prepare(`UPDATE orders SET owner_notified_at = datetime('now') WHERE id = ?`).run(orderId);
      notificationsService.notifyDamagedReturn({ order }); // the real push the comment above was waiting for
    }

    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  return txn();
}

// §6 RMA: "Owner visibility and decision required for write-offs or
// disposal" — a 'damaged' inspection result doesn't resolve itself; this is
// the human decision that finally closes it out. Deliberately does NOT
// change orders.status (it's already terminal at 'returned_damaged') —
// owner_decision going from NULL to set is what "resolved" means here,
// which is also what pending-owner-decision below filters on.
function decideOwnerAction({ orderId, storeId, staffId, decision, notes }) {
  if (!OWNER_DECISIONS.includes(decision)) throw new ApiError(400, `decision must be one of ${OWNER_DECISIONS.join(', ')}.`);

  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.status !== 'returned_damaged') throw new ApiError(409, `Only a "returned_damaged" order needs an owner decision (this order is "${order.status}").`);
    if (order.owner_decision) throw new ApiError(409, `This order already has an owner decision recorded ("${order.owner_decision}").`);

    db.prepare(`
      UPDATE orders SET owner_decision = ?, owner_decision_by = ?, owner_decision_at = datetime('now'), owner_decision_notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(decision, staffId, notes || null, orderId);

    // Not a status transition (status stays 'returned_damaged') — logged
    // directly the same way confirmCod does, for the same reason: a
    // same-status "transition" would be rejected by assertValidTransition.
    db.prepare(`
      INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(orderId, order.status, order.status, `Owner decision: ${decision}.${notes ? ` ${notes}` : ''}`, staffId);

    logStaffAction({ staffId, action: 'update', entityType: 'order', entityId: orderId, before: { owner_decision: null }, after: { owner_decision: decision } });
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  return txn();
}

// The real version of "owner gets notified" (see the comment in
// inspectReturn above) — a queryable list rather than a push notification,
// since there's no messaging channel to push through yet.
function listPendingOwnerDecisions({ storeId, limit, offset }) {
  const rows = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.store_id = ? AND o.status = 'returned_damaged' AND o.owner_decision IS NULL AND o.deleted_at IS NULL
    ORDER BY o.owner_notified_at ASC
    LIMIT ? OFFSET ?
  `).all(storeId, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) c FROM orders
    WHERE store_id = ? AND status = 'returned_damaged' AND owner_decision IS NULL AND deleted_at IS NULL
  `).get(storeId).c;
  return { rows, total };
}

// §10 Dispute Management — independent of the order's lifecycle status;
// a dispute can be raised on a dispatched_paid order same as a returned
// one. dispute_status is nullable specifically so "never disputed" and
// "disputed and resolved" stay distinguishable (a resolved dispute is
// still visible history, not erased back to null).
function openDispute({ orderId, storeId, staffId, reason }) {
  if (!reason) throw new ApiError(400, 'reason is required to open a dispute.');
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
  if (!order) throw new ApiError(404, 'Order not found.');
  if (order.dispute_status === 'open') throw new ApiError(409, 'This order already has an open dispute.');

  db.prepare(`
    UPDATE orders SET dispute_status = 'open', dispute_reason = ?, dispute_opened_by = ?, dispute_opened_at = datetime('now'),
      dispute_outcome = NULL, dispute_resolved_by = NULL, dispute_resolved_at = NULL, dispute_resolution_notes = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, staffId, orderId);

  db.prepare(`
    INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, order.status, order.status, `Dispute opened: ${reason}`, staffId);

  logStaffAction({ staffId, action: 'update', entityType: 'order', entityId: orderId, before: { dispute_status: order.dispute_status }, after: { dispute_status: 'open' } });
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function resolveDispute({ orderId, storeId, staffId, outcome, notes }) {
  if (!DISPUTE_OUTCOMES.includes(outcome)) throw new ApiError(400, `outcome must be one of ${DISPUTE_OUTCOMES.join(', ')}.`);
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
  if (!order) throw new ApiError(404, 'Order not found.');
  if (order.dispute_status !== 'open') throw new ApiError(409, 'This order has no open dispute to resolve.');

  db.prepare(`
    UPDATE orders SET dispute_status = 'resolved', dispute_outcome = ?, dispute_resolved_by = ?, dispute_resolved_at = datetime('now'),
      dispute_resolution_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(outcome, staffId, notes || null, orderId);

  db.prepare(`
    INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, order.status, order.status, `Dispute resolved: ${outcome}.${notes ? ` ${notes}` : ''}`, staffId);

  logStaffAction({ staffId, action: 'update', entityType: 'order', entityId: orderId, before: { dispute_status: 'open' }, after: { dispute_status: 'resolved', dispute_outcome: outcome } });
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function cancel({ orderId, storeId, staffId, notes }) {
  const txn = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw new ApiError(404, 'Order not found.');
    transitionTo(orderId, order, 'cancelled', staffId, notes || null);
    db.prepare(`UPDATE orders SET cancelled_at = datetime('now') WHERE id = ?`).run(orderId);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });
  return txn();
}

function getOrderWithItems(id, storeId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(id, storeId);
  if (!order) return null;

  const items = db.prepare(`
    SELECT oi.*, p.name AS product_name, p.sku
    FROM order_items oi JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(id);
  const payments = db.prepare('SELECT * FROM payment_records WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at').all(id);
  const statusHistory = db.prepare(`
    SELECT h.*, u.name AS changed_by_name FROM order_status_history h
    LEFT JOIN users u ON u.id = h.changed_by_staff_id
    WHERE h.order_id = ? ORDER BY h.changed_at DESC
  `).all(id);
  const customer = customersService.getById(order.customer_id);
  const courier = order.courier_id
    ? db.prepare('SELECT id, name, phone, vehicle, courier_type FROM couriers WHERE id = ?').get(order.courier_id)
    : null;

  return { ...order, items, payments, status_history: statusHistory, customer, courier };
}

// channel: 'manual' (created in the POS / from leads), 'shopify', or 'wordpress' (WooCommerce)
const LIST_CHANNELS = ['manual', 'shopify', 'wordpress'];

function list({ storeId, status, channel, assignedStaffId, search, limit, offset }) {
  const where = ['o.deleted_at IS NULL', 'o.store_id = ?'];
  const params = [storeId];

  if (status) { where.push('o.status = ?'); params.push(status); }
  if (channel) {
    if (!LIST_CHANNELS.includes(channel)) throw new ApiError(400, `channel must be one of ${LIST_CHANNELS.join(', ')}.`);
    where.push('o.channel = ?'); params.push(channel);
  }
  if (assignedStaffId) { where.push('o.assigned_staff_id = ?'); params.push(assignedStaffId); }
  if (search) {
    where.push('(c.name LIKE ? OR c.phone LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.risk_flag AS customer_risk_flag,
      u.name AS assigned_staff_name, src.name AS income_source_name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.assigned_staff_id
    LEFT JOIN income_sources src ON src.id = o.income_source_id
    ${whereSql}
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) c FROM orders o JOIN customers c ON c.id = o.customer_id ${whereSql}
  `).get(...params).c;

  // Money still to collect across EVERY order matching the filters - not just the page on screen.
  // (The page used to add up the 25 visible rows and call that "outstanding".) Cancelled orders are
  // excluded: they were never going to be paid.
  const outstanding = db.prepare(`
    SELECT COALESCE(SUM(o.total - o.amount_paid), 0) v FROM orders o JOIN customers c ON c.id = o.customer_id
    ${whereSql} AND o.status != 'cancelled'
  `).get(...params).v;

  return { rows, total, summary: { outstanding } };
}

module.exports = {
  TRANSITIONS, ACTIVE_STATUSES, assertValidTransition, transitionTo, findDuplicateActiveOrder, findByProductCode,
  create, mergeItems, confirmCod, expireUnconfirmedOrders, setCourier, dispatch, recordPayment, refundPayment,
  markReturnedInTransit, markReturnedAwaitingInspection, inspectReturn, decideOwnerAction, listPendingOwnerDecisions,
  openDispute, resolveDispute, cancel,
  getOrderWithItems, list,
};
