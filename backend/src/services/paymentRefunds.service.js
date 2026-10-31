const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const ordersService = require('./orders.service');

// The one definition of "refund a recorded payment". Used by POST /api/payments/:id/refund (a person who holds
// payments.refund) and by the approval flow (a manager approving someone else's request), so both do exactly the
// same thing and raise the same alert.
//
// actor: { id, name } — the person whose action this is on the record (for an approved request, the approver).
function refundPaymentRecord({ paymentId, storeId, actor }) {
  const existing = db.prepare('SELECT * FROM payment_records WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(paymentId, storeId);
  if (!existing) throw new ApiError(404, 'Payment not found.');
  if (existing.status !== 'completed') throw new ApiError(409, `Payment is already ${existing.status}.`);

  // Refunds reference the original record rather than deleting it — both rows
  // are needed for audit purposes even though net revenue nets to zero (§4.3).
  // If the payment was against an online order, the order's amount_paid and status must follow it
  // (same transaction), or the order would keep showing money the shop has handed back.
  db.transaction(() => {
    db.prepare(`UPDATE payment_records SET status = 'refunded', updated_at = datetime('now') WHERE id = ?`).run(paymentId);
    if (existing.order_id && existing.direction === 'incoming') {
      ordersService.refundPayment({
        orderId: existing.order_id, storeId,
        amount: existing.amount, staffId: actor.id, method: existing.method,
      });
    }
  })();

  const payment = db.prepare('SELECT * FROM payment_records WHERE id = ?').get(paymentId);
  logStaffAction({
    staffId: actor.id, action: 'update', entityType: 'payment', entityId: payment.id,
    before: { status: 'completed' }, after: { status: 'refunded' },
  });
  require('./securityAlerts.service').largeMoney({
    storeId, actor: { id: actor.id, name: actor.name }, kind: 'refund', amountCents: existing.amount, reference: `#${payment.id}`,
  });
  return payment;
}

module.exports = { refundPaymentRecord };
