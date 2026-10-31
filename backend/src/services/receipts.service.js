const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');
const ordersService = require('./orders.service');
const salesService = require('./sales.service');
const { formatPaymentAccount } = require('../utils/paymentReference');

// Receipts are composed on the SERVER because the data a receipt needs
// (business name/phone, paybill, account prefix) lives in Settings, which only
// admins can read — a cashier printing a receipt must not need that access. The
// browser just lays the result out; everything in it is plain text and is
// rendered as text (never injected as HTML), which is where the older system's
// receipt XSS came from.

function business(settings) {
  return {
    name: settings.business_name || 'Urban Trends',
    phone: settings.business_phone || '',
    pin: settings.business_pin || '',
    address: settings.business_address || '',
    footer: settings.receipt_footer || 'Thank you for shopping with us.',
    currency: settings.business_currency || 'KES',
  };
}

function paymentInfo(settings, productCode, balanceCents) {
  const paybill = String(settings.paybill_number || '').trim();
  return {
    paybill: paybill || null,
    account: productCode ? formatPaymentAccount(productCode, settings) : null,
    show: Boolean(productCode) && balanceCents > 0,
  };
}

// Dispatch slip / customer receipt for an online (COD/prepaid) order.
function forOrder({ orderId, storeId }) {
  const order = ordersService.getOrderWithItems(orderId, storeId);
  if (!order) throw new ApiError(404, 'Order not found.');
  const settings = settingsService.getAll();
  const balance = Math.max(order.total - order.amount_paid, 0);

  return {
    kind: 'order',
    business: business(settings),
    reference: order.product_code || `#${order.id}`,
    status: order.status,
    created_at: order.created_at,
    dispatched_at: order.dispatched_at || null,
    customer: { name: order.customer?.name || '', phone: order.customer?.phone || '', city: order.customer?.city || '' },
    delivery: {
      zone: order.delivery_zone || null,
      courier_type: order.courier_type || null,
      courier_name: order.courier?.name || null,
      courier_phone: order.courier?.phone || null,
      fee: order.delivery_fee,
    },
    items: order.items.map((i) => ({ name: i.product_name, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total })),
    totals: {
      subtotal: order.subtotal, discount: order.discount_total, total: order.total,
      paid: order.amount_paid, balance,
    },
    payment: paymentInfo(settings, order.product_code, balance),
    notes: order.notes || null,
  };
}

// Till receipt for an in-store sale.
function forSale({ saleId, storeId }) {
  const sale = salesService.getSaleWithItems(saleId, storeId); // store-scoped, so another store's sale is a plain 404
  if (!sale) throw new ApiError(404, 'Sale not found.');
  const settings = settingsService.getAll();
  const cashier = db.prepare('SELECT name FROM users WHERE id = ?').get(sale.cashier_id);
  const paid = sale.payments.reduce((n, p) => n + p.amount, 0);

  return {
    kind: 'sale',
    business: business(settings),
    reference: `S-${sale.id}`,
    status: sale.status,
    created_at: sale.created_at,
    cashier: cashier?.name || '',
    items: sale.items.map((i) => ({ name: i.product_name, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total })),
    totals: { subtotal: sale.subtotal, discount: sale.discount_total, total: sale.total, paid, balance: 0 },
    payments: sale.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference || null })),
    payment_method: sale.payment_method,
    notes: null,
  };
}

module.exports = { forOrder, forSale };
