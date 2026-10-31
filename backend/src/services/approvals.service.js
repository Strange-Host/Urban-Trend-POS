const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logStaffAction } = require('../utils/auditLog');
const permissionsService = require('./permissions.service');
const notifications = require('./notifications.service');
const salesService = require('./sales.service');
const paymentRefunds = require('./paymentRefunds.service');

// "Refund / void requires manager approval."
//
// A person who may not void a sale / refund a payment on their own (a cashier) files a REQUEST with a reason. A manager
// approves or rejects it. Approving runs the existing void / refund (sales.service voidSaleWithAlert,
// paymentRefunds.service refundPaymentRecord) inside the same transaction that marks the request approved, so a request
// can never read "approved" while the sale is still live, and the money/stock effects stay defined in exactly one place.
//
// Rules:
//  - one open request per sale / payment (a partial unique index enforces it, not just a check here);
//  - nobody approves or rejects their own request (they can cancel it);
//  - approving a void also needs sales.void, approving a refund also needs payments.refund. Holding approvals.review
//    alone is not a way round an admin having taken those rights away from someone;
//  - a request whose action can no longer run (sale already voided, payment already refunded) is closed as 'failed'
//    with the reason, so it never sits in the queue forever.

const KINDS = {
  void_sale: { requestPerm: 'sales.void_request', executePerm: 'sales.void', verb: 'void', noun: 'sale' },
  refund_payment: { requestPerm: 'payments.refund_request', executePerm: 'payments.refund', verb: 'refund', noun: 'payment' },
};

const FORBIDDEN = () => new ApiError(403, 'You do not have permission to do that.', null, 'FORBIDDEN');

function kes(cents) {
  return `KES ${((Number(cents) || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const SELECT = `
  SELECT ar.*, ru.name AS requested_by_name, vu.name AS reviewed_by_name,
         s.total AS sale_total, s.status AS sale_status, s.payment_method AS sale_payment_method,
         pr.method AS payment_method, pr.status AS payment_status, pr.sale_id AS payment_sale_id, pr.order_id AS payment_order_id
  FROM approval_requests ar
  JOIN users ru ON ru.id = ar.requested_by
  LEFT JOIN users vu ON vu.id = ar.reviewed_by
  LEFT JOIN sales s ON s.id = ar.sale_id
  LEFT JOIN payment_records pr ON pr.id = ar.payment_record_id
`;

function shape(row) {
  if (!row) return row;
  return { ...row, target_ref: row.kind === 'void_sale' ? `S-${row.sale_id}` : `Payment #${row.payment_record_id}` };
}

function load(id, storeId) {
  return shape(db.prepare(`${SELECT} WHERE ar.id = ? AND ar.store_id = ?`).get(id, storeId));
}

function describe(row) {
  const def = KINDS[row.kind];
  return `${def.verb} ${def.noun} ${row.target_ref} (${kes(row.amount)})`;
}

// Everyone who can act on a request, except the person who filed it.
function reviewerIds(storeId, exceptUserId) {
  const users = db.prepare('SELECT id, role FROM users WHERE store_id = ? AND is_active = 1').all(storeId);
  return users.filter((u) => u.id !== exceptUserId && permissionsService.can(u, 'approvals.review')).map((u) => u.id);
}

function notifyReviewers(row, requester) {
  return notifications.notify({
    storeId: row.store_id, userIds: reviewerIds(row.store_id, requester.id), type: 'approval_requested', severity: 'warning',
    title: `${requester.name} asked to ${describe(row)}`,
    body: `Reason: ${row.reason}`,
    entityType: 'approval', entityId: row.id, dedupeKey: `approval_requested:${row.id}`,
  });
}

function notifyRequester(row, outcome, note) {
  const text = { approved: 'was approved', rejected: 'was rejected', failed: 'could not be completed', cancelled: 'was closed' }[outcome];
  return notifications.notify({
    storeId: row.store_id, userIds: [row.requested_by], type: 'approval_decided', severity: outcome === 'approved' ? 'info' : 'warning',
    title: `Your request to ${describe(row)} ${text}`,
    body: note || null,
    entityType: 'approval', entityId: row.id, dedupeKey: `approval_decided:${row.id}`,
  });
}

/**
 * Files a request. user = req.user ({ id, role, storeId, name }).
 * Returns the request row. Throws 404 for another store's sale/payment, 409 if there is nothing left to void/refund
 * or a request is already open for it.
 */
function create({ user, kind, saleId, paymentId, reason }) {
  const def = KINDS[kind];
  if (!def) throw new ApiError(400, 'Unknown request type.');
  if (!permissionsService.can(user, def.requestPerm)) throw FORBIDDEN();

  const why = String(reason || '').trim();
  if (why.length < 3) throw new ApiError(400, 'Say why this is needed (a few words is enough).');

  let amount;
  if (kind === 'void_sale') {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ? AND store_id = ?').get(saleId, user.storeId);
    if (!sale) throw new ApiError(404, 'Sale not found.');
    if (sale.source_type !== 'local') {
      throw new ApiError(409, `This sale happened on ${sale.source_type} — void or refund it there.`);
    }
    if (sale.status !== 'completed') throw new ApiError(409, `Sale is already ${sale.status}.`);
    amount = sale.total;
  } else {
    const payment = db.prepare('SELECT * FROM payment_records WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(paymentId, user.storeId);
    if (!payment) throw new ApiError(404, 'Payment not found.');
    if (payment.status !== 'completed') throw new ApiError(409, `Payment is already ${payment.status}.`);
    amount = payment.amount;
  }

  const col = kind === 'void_sale' ? 'sale_id' : 'payment_record_id';
  const targetId = kind === 'void_sale' ? saleId : paymentId;
  const open = db.prepare(`SELECT id FROM approval_requests WHERE kind = ? AND ${col} = ? AND status = 'pending'`).get(kind, targetId);
  if (open) throw new ApiError(409, 'A request for this is already waiting for a manager.');

  let id;
  try {
    id = db.prepare(`
      INSERT INTO approval_requests (store_id, kind, sale_id, payment_record_id, amount, reason, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.storeId, kind, kind === 'void_sale' ? saleId : null, kind === 'refund_payment' ? paymentId : null, amount, why, user.id).lastInsertRowid;
  } catch (err) {
    // Two clicks at once: both passed the check above, the unique index stopped the second.
    if (/UNIQUE constraint failed/.test(err.message || '')) throw new ApiError(409, 'A request for this is already waiting for a manager.');
    throw err;
  }

  const row = load(id, user.storeId);
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'approval', entityId: id, after: { kind, target: row.target_ref, amount, reason: why } });
  notifyReviewers(row, user);
  return row;
}

/**
 * Requests visible to this person: a reviewer sees the whole store's, everyone else only their own.
 * status: 'pending' | 'closed' | undefined (all).
 */
function list({ user, status, mine, limit, offset }) {
  // Who is allowed to see what (the scope), kept apart from the status filter so the "waiting" count stays right
  // whichever tab is open.
  const scope = ['ar.store_id = ?'];
  const params = [user.storeId];
  if (mine || !permissionsService.can(user, 'approvals.review')) { scope.push('ar.requested_by = ?'); params.push(user.id); }
  const scopeSql = scope.join(' AND ');

  const filtered = [...scope];
  if (status === 'pending') filtered.push(`ar.status = 'pending'`);
  else if (status === 'closed') filtered.push(`ar.status != 'pending'`);
  const whereSql = `WHERE ${filtered.join(' AND ')}`;

  const rows = db.prepare(`${SELECT} ${whereSql} ORDER BY ar.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).map(shape);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM approval_requests ar ${whereSql}`).get(...params).n;
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM approval_requests ar WHERE ${scopeSql} AND ar.status = 'pending'`).get(...params).n;
  return { rows, total, pending };
}

function assertPending(row) {
  if (!row) throw new ApiError(404, 'Request not found.');
  if (row.status !== 'pending') throw new ApiError(409, `This request is already ${row.status}.`);
}

/**
 * Approves a request and carries it out. reviewer = req.user. Throws the underlying 409 (and records the request as
 * 'failed') if the void/refund can no longer happen.
 */
function approve({ id, reviewer }) {
  const row = load(id, reviewer.storeId);
  assertPending(row);
  if (row.requested_by === reviewer.id) {
    throw new ApiError(403, 'You cannot approve your own request — another manager has to. (You can cancel it instead.)');
  }
  if (!permissionsService.can(reviewer, KINDS[row.kind].executePerm)) throw FORBIDDEN();

  let alreadyHandled = false;
  try {
    db.transaction(() => {
      const claimed = db.prepare(`
        UPDATE approval_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'
      `).run(reviewer.id, id);
      if (claimed.changes !== 1) { alreadyHandled = true; throw new ApiError(409, 'This request has already been handled.'); }
      if (row.kind === 'void_sale') {
        salesService.voidSaleWithAlert(row.sale_id, row.store_id, { id: reviewer.id, name: reviewer.name });
      } else {
        paymentRefunds.refundPaymentRecord({ paymentId: row.payment_record_id, storeId: row.store_id, actor: { id: reviewer.id, name: reviewer.name } });
      }
    })();
  } catch (err) {
    // The transaction rolled back, so the request is still 'pending'. If the cause is that the sale/payment is gone or
    // already dealt with, close the request as failed so it stops waiting; any other error is left for the caller.
    if (!alreadyHandled && err instanceof ApiError && (err.statusCode === 409 || err.statusCode === 404)) {
      db.prepare(`
        UPDATE approval_requests SET status = 'failed', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND status = 'pending'
      `).run(reviewer.id, err.message, id);
      logStaffAction({ staffId: reviewer.id, action: 'update', entityType: 'approval', entityId: id, before: { status: 'pending' }, after: { status: 'failed' } });
      notifyRequester(row, 'failed', err.message);
    }
    throw err;
  }

  logStaffAction({ staffId: reviewer.id, action: 'update', entityType: 'approval', entityId: id, before: { status: 'pending' }, after: { status: 'approved' } });
  notifyRequester(row, 'approved');
  return load(id, reviewer.storeId);
}

/** Rejects a request. A reason is required so the person who asked is not left guessing. */
function reject({ id, reviewer, note }) {
  const row = load(id, reviewer.storeId);
  assertPending(row);
  if (row.requested_by === reviewer.id) {
    throw new ApiError(403, 'You cannot review your own request. You can cancel it instead.');
  }
  const why = String(note || '').trim();
  if (why.length < 3) throw new ApiError(400, 'Say why you are rejecting it, so the person who asked knows.');

  const done = db.prepare(`
    UPDATE approval_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND status = 'pending'
  `).run(reviewer.id, why, id);
  if (done.changes !== 1) throw new ApiError(409, 'This request has already been handled.');

  logStaffAction({ staffId: reviewer.id, action: 'update', entityType: 'approval', entityId: id, before: { status: 'pending' }, after: { status: 'rejected', review_note: why } });
  notifyRequester(row, 'rejected', why);
  return load(id, reviewer.storeId);
}

/** The person who filed it withdraws it. */
function cancel({ id, user }) {
  const row = load(id, user.storeId);
  assertPending(row);
  if (row.requested_by !== user.id) throw FORBIDDEN();
  const done = db.prepare(`
    UPDATE approval_requests SET status = 'cancelled', reviewed_by = ?, reviewed_at = datetime('now'), review_note = 'Withdrawn by the requester.' WHERE id = ? AND status = 'pending'
  `).run(user.id, id);
  if (done.changes !== 1) throw new ApiError(409, 'This request has already been handled.');
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'approval', entityId: id, before: { status: 'pending' }, after: { status: 'cancelled' } });
  return load(id, user.storeId);
}

/**
 * Called after someone with the right voids a sale / refunds a payment directly: any request still open for it has been
 * answered by that action, so close it as approved and tell whoever asked. Never throws — bookkeeping here must not
 * undo or hide a real void/refund.
 */
function resolveDirect({ kind, entityId, storeId, actor }) {
  try {
    const col = kind === 'void_sale' ? 'sale_id' : 'payment_record_id';
    const open = db.prepare(`SELECT id FROM approval_requests WHERE kind = ? AND ${col} = ? AND store_id = ? AND status = 'pending'`).all(kind, entityId, storeId);
    const note = `${kind === 'void_sale' ? 'Voided' : 'Refunded'} directly by ${actor.name}.`;
    for (const { id } of open) {
      db.prepare(`
        UPDATE approval_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND status = 'pending'
      `).run(actor.id, note, id);
      const row = load(id, storeId);
      if (row.requested_by !== actor.id) notifyRequester(row, 'approved', note);
    }
    return open.length;
  } catch (err) {
    logger.error('[approvals] could not close open requests after a direct action', { kind, entityId, error: err.message });
    return 0;
  }
}

module.exports = { KINDS, create, list, approve, reject, cancel, resolveDirect, load };
