const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const permissionsService = require('./permissions.service');
const settingsService = require('./settings.service');
const notifications = require('./notifications.service');
const approvalsService = require('./approvals.service');
const expenseDecisions = require('./expenseDecisions.service');
const requisitionsService = require('./requisitions.service');
const stockAdjust = require('./stockAdjust.service');

// One list of everything waiting on a decision, for the phone: voids, refunds, expenses, requisitions and large stock
// adjustments. Each is its own table with its own rules, so this file only READS them into one shape and then hands the
// decision to the service that already owns the rules - the money / stock effects stay defined in exactly one place.
//
// An item is shown only to people who hold the permission that decides it (the same keys the website's routes use), and
// never to the person who asked for it. Nothing here includes cost or margin.
//
// Ids are "<type>:<number>" (e.g. "void:12") because the five tables count separately.

const TYPES = {
  void:             { permission: 'approvals.review' },
  refund:           { permission: 'approvals.review' },
  expense:          { permission: 'expenses.approve' },
  requisition:      { permission: 'requisitions.approve' },
  stock_adjustment: { permission: 'inventory.approve_adjust' },
  duplicate_order:  { permission: 'orders.approve_duplicate' },
};

const iso = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'}`).toISOString() : null);
const kes = (cents) => `KES ${((Number(cents) || 0) / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
const statusOf = (s) => (s === 'pending' ? 'pending' : s === 'approved' ? 'approved' : 'rejected');   // cancelled / failed read as "not approved"

function parseId(raw) {
  const m = /^([a-z_]+):(\d{1,12})$/.exec(String(raw || ''));
  if (!m || !TYPES[m[1]]) throw new ApiError(404, 'Request not found.');
  return { type: m[1], num: Number(m[2]) };
}

// ---- readers: each returns the common shape, or null ---------------------------------------------------------------------

function shape(base) {
  return { decidedBy: null, decidedAt: null, decisionNote: null, items: [], amountCents: null, ...base, requestedAt: iso(base.requestedAt), decidedAt: iso(base.decidedAt) };
}

function readVoidRefund(row) {
  const isVoid = row.kind === 'void_sale';
  const items = isVoid
    ? db.prepare(`SELECT p.name, si.quantity AS qty, si.unit_price AS priceCents FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?`).all(row.sale_id)
    : [];
  return shape({
    id: `${isVoid ? 'void' : 'refund'}:${row.id}`, type: isVoid ? 'void' : 'refund', status: statusOf(row.status), rawStatus: row.status,
    title: isVoid ? `Void sale S-${row.sale_id}` : `Refund payment #${row.payment_record_id}`,
    requestedBy: row.who, requestedByUserId: row.requested_by, requestedAt: row.requested_at, amountCents: row.amount, reason: row.reason, items,
    decidedBy: row.decider, decidedAt: row.reviewed_at, decisionNote: row.review_note,
  });
}

// WHERE clause shared by the four readers. onlyId = read exactly one row (any status, any requester).
function filters({ alias, requesterCol, user, status, onlyId, softDelete = false }) {
  const where = [`${alias}.store_id = ?`]; const params = [user.storeId];
  if (softDelete) where.push(`${alias}.deleted_at IS NULL`);
  if (onlyId) { where.push(`${alias}.id = ?`); params.push(onlyId); return { sql: where.join(' AND '), params }; }
  where.push(`${alias}.${requesterCol} != ?`); params.push(user.id);
  if (status === 'pending') where.push(`${alias}.status = 'pending'`);
  else if (status === 'closed') where.push(`${alias}.status != 'pending'`);
  else { where.push(`${alias}.status = ?`); params.push(status); }
  return { sql: where.join(' AND '), params };
}

const SOURCES = {
  void_refund: {
    permission: 'approvals.review',
    load: ({ user, status, limit, onlyId }) => {
      const f = filters({ alias: 'ar', requesterCol: 'requested_by', user, status, onlyId });
      return db.prepare(`
        SELECT ar.*, ru.name AS who, vu.name AS decider FROM approval_requests ar JOIN users ru ON ru.id = ar.requested_by LEFT JOIN users vu ON vu.id = ar.reviewed_by
        WHERE ${f.sql} ORDER BY ar.id DESC LIMIT ?`).all(...f.params, limit).map(readVoidRefund);
    },
  },
  expense: {
    permission: 'expenses.approve',
    load: ({ user, status, limit, onlyId }) => {
      const f = filters({ alias: 'e', requesterCol: 'recorded_by_staff_id', user, status, onlyId, softDelete: true });
      return db.prepare(`
        SELECT e.*, s.name AS who, c.name AS category, d.name AS decider FROM expenses e JOIN users s ON s.id = e.recorded_by_staff_id
        JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users d ON d.id = e.reviewed_by_staff_id
        WHERE ${f.sql} ORDER BY e.id DESC LIMIT ?`).all(...f.params, limit).map((r) => shape({
        id: `expense:${r.id}`, type: 'expense', status: statusOf(r.status), rawStatus: r.status, title: `Expense: ${r.category}`,
        requestedBy: r.who, requestedByUserId: r.recorded_by_staff_id, requestedAt: r.created_at, amountCents: r.amount,
        reason: r.description || r.category, decidedBy: r.decider, decidedAt: r.reviewed_at, decisionNote: r.review_note,
      }));
    },
  },
  requisition: {
    permission: 'requisitions.approve',
    load: ({ user, status, limit, onlyId }) => {
      const f = filters({ alias: 'r', requesterCol: 'requested_by_staff_id', user, status, onlyId, softDelete: true });
      return db.prepare(`
        SELECT r.*, u.name AS who, d.name AS decider FROM requisitions r JOIN users u ON u.id = r.requested_by_staff_id LEFT JOIN users d ON d.id = r.reviewed_by_staff_id
        WHERE ${f.sql} ORDER BY r.id DESC LIMIT ?`).all(...f.params, limit).map((r) => {
        const items = r.type === 'shop_operational'
          ? db.prepare(`SELECT p.name, ri.quantity_requested AS qty FROM requisition_items ri JOIN products p ON p.id = ri.product_id WHERE ri.requisition_id = ?`).all(r.id).map((i) => ({ ...i, priceCents: null }))
          : [];
        return shape({
          id: `requisition:${r.id}`, type: 'requisition', status: statusOf(r.status), rawStatus: r.status,
          title: r.type === 'salary_advance' ? 'Salary advance' : 'Stock requisition',
          requestedBy: r.who, requestedByUserId: r.requested_by_staff_id, requestedAt: r.created_at, amountCents: r.type === 'salary_advance' ? r.amount : null,
          reason: r.notes || (r.type === 'salary_advance' ? 'Salary advance' : 'Stock requisition'), items,
          decidedBy: r.decider, decidedAt: r.reviewed_at, decisionNote: r.rejection_reason,
        });
      });
    },
  },
  stock_adjustment: {
    permission: 'inventory.approve_adjust',
    load: ({ user, status, limit, onlyId }) => {
      const f = filters({ alias: 's', requesterCol: 'requested_by', user, status, onlyId });
      return db.prepare(`
        SELECT s.*, p.name AS product, u.name AS who, d.name AS decider FROM stock_adjustment_requests s JOIN products p ON p.id = s.product_id
        JOIN users u ON u.id = s.requested_by LEFT JOIN users d ON d.id = s.reviewed_by
        WHERE ${f.sql} ORDER BY s.id DESC LIMIT ?`).all(...f.params, limit).map((r) => shape({
        id: `stock_adjustment:${r.id}`, type: 'stock_adjustment', status: statusOf(r.status), rawStatus: r.status,
        title: `Stock ${r.change_qty > 0 ? '+' : ''}${r.change_qty}: ${r.product}`,
        requestedBy: r.who, requestedByUserId: r.requested_by, requestedAt: r.requested_at, amountCents: null,
        reason: `${r.reason.replace(/_/g, ' ')}${r.note ? ` - ${r.note}` : ''}`, items: [{ name: r.product, qty: r.change_qty, priceCents: null }],
        decidedBy: r.decider, decidedAt: r.reviewed_at, decisionNote: r.review_note,
      }));
    },
  },
  duplicate_order: {
    permission: 'orders.approve_duplicate',
    load: ({ user, status, limit, onlyId }) => {
      const f = filters({ alias: 'd', requesterCol: 'requested_by', user, status, onlyId });
      return db.prepare(`
        SELECT d.*, o.product_code, o.total, c.name AS customer, u.name AS who, v.name AS decider FROM duplicate_order_approvals d
        JOIN orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id JOIN users u ON u.id = d.requested_by LEFT JOIN users v ON v.id = d.reviewed_by
        WHERE ${f.sql} ORDER BY d.id DESC LIMIT ?`).all(...f.params, limit).map((r) => shape({
        id: `duplicate_order:${r.id}`, type: 'duplicate_order', status: statusOf(r.status), rawStatus: r.status,
        title: `Confirm ${r.product_code || `#${r.order_id}`}: ${r.customer} has another active order`,
        requestedBy: r.who, requestedByUserId: r.requested_by, requestedAt: r.requested_at, amountCents: r.total,
        reason: r.note || 'Same phone number as another active order', decidedBy: r.decider, decidedAt: r.reviewed_at, decisionNote: r.review_note,
      }));
    },
  },
};

const PUBLIC = (a) => { const { requestedByUserId, rawStatus, ...rest } = a; return rest; };   // eslint-disable-line no-unused-vars

/** { items, nextCursor }. status = pending | approved | rejected | closed. cursor = how many to skip (an opaque number). */
function list({ user, status = 'pending', cursor, limit = 25 }) {
  if (!['pending', 'approved', 'rejected', 'closed'].includes(status)) throw new ApiError(400, 'status must be pending, approved, rejected or closed.');
  const skip = Math.max(0, Number.parseInt(cursor, 10) || 0);
  const want = skip + limit + 1;
  let all = [];
  for (const src of Object.values(SOURCES)) {
    if (!permissionsService.can(user, src.permission)) continue;
    all = all.concat(src.load({ user, status, limit: want }));
  }
  // Waiting items: oldest first (the one that has waited longest is on top). History: newest first.
  all.sort((a, b) => (status === 'pending' ? Date.parse(a.requestedAt) - Date.parse(b.requestedAt) : Date.parse(b.decidedAt || b.requestedAt) - Date.parse(a.decidedAt || a.requestedAt)));
  const page = all.slice(skip, skip + limit);
  return { items: page.map(PUBLIC), nextCursor: all.length > skip + limit ? String(skip + limit) : null };
}

function readOne({ user, type, num }) {
  const src = type === 'void' || type === 'refund' ? SOURCES.void_refund : SOURCES[type];
  const hit = src.load({ user, status: 'closed', limit: 1, onlyId: num })[0];
  // void_refund holds two kinds in one table: make sure the id's type matches the row's.
  return hit && hit.id === `${type}:${num}` ? hit : null;
}

function thresholdCents() {
  const kesAmount = Number(settingsService.getAll().approval_biometric_above_kes);
  return Number.isFinite(kesAmount) && kesAmount > 0 ? Math.round(kesAmount * 100) : Infinity;
}

function loadForDecision({ user, rawId }) {
  const { type, num } = parseId(rawId);
  if (!permissionsService.can(user, TYPES[type].permission)) throw new ApiError(403, 'You do not have permission to do that.', null, 'FORBIDDEN');
  const item = readOne({ user, type, num });
  if (!item) throw new ApiError(404, 'Request not found.');
  if (item.requestedByUserId === user.id && user.role !== 'admin') throw new ApiError(403, 'You cannot decide your own request.', null, 'FORBIDDEN');
  return { type, num, item };
}

function audit({ user, session, item, decision, biometric, note }) {
  logStaffAction({
    staffId: user.id, action: 'update', entityType: 'mobile_approval', entityId: Number(item.id.split(':')[1]),
    after: { request: item.id, decision, via: 'mobile', device: session?.device_name || null, biometric: biometric ? 'confirmed' : 'not asked', note: note || null },
  });
}

/** Decides one request. Returns { applied, approval }; applied=false means someone else decided first. */
function decide({ user, session, rawId, decision, note, biometricConfirmed }) {
  const { type, num, item } = loadForDecision({ user, rawId });
  if (item.status !== 'pending') return { applied: false, approval: PUBLIC(item) };

  if (decision === 'approve' && (item.amountCents ?? 0) >= thresholdCents() && biometricConfirmed !== true) {
    throw new ApiError(403, 'Confirm with your fingerprint or face to approve this amount.', null, 'BIOMETRIC_REQUIRED');
  }
  if (decision === 'reject' && !String(note || '').trim()) throw new ApiError(400, 'Say why you are rejecting it.');

  try {
    if (type === 'void' || type === 'refund') {
      if (decision === 'approve') approvalsService.approve({ id: num, reviewer: user });
      else approvalsService.reject({ id: num, reviewer: user, note });
    } else if (type === 'expense') {
      if (decision === 'approve') expenseDecisions.approve({ id: num, user });
      else expenseDecisions.reject({ id: num, user, note });
    } else if (type === 'requisition') {
      if (decision === 'approve') requisitionsService.approve({ requisitionId: num, items: undefined, staffId: user.id, storeId: user.storeId });
      else requisitionsService.reject({ requisitionId: num, reason: note, staffId: user.id, storeId: user.storeId });
    } else if (type === 'duplicate_order') {
      decideDuplicateOrder({ id: num, user, decision, note });
    } else {
      decideStockAdjustment({ id: num, user, decision, note });
    }
  } catch (err) {
    // Two people tapping at once: the loser sees the winner's decision instead of an error. Only a real decision counts: a
    // request that was closed as 'failed' (the void / refund / stock change could no longer be carried out) is THIS person's
    // problem to hear about, not somebody else's decision, so that 409 is passed on.
    if (err instanceof ApiError && err.statusCode === 409) {
      const now = readOne({ user, type, num });
      if (now && ['approved', 'rejected', 'cancelled'].includes(now.rawStatus)) return { applied: false, approval: PUBLIC(now) };
    }
    throw err;
  }

  audit({ user, session, item, decision, biometric: biometricConfirmed === true, note });
  const after = readOne({ user, type, num });
  return { applied: true, approval: PUBLIC(after || { ...item, status: decision === 'approve' ? 'approved' : 'rejected' }) };
}

function decideDuplicateOrder({ id, user, decision, note }) {
  const row = db.prepare('SELECT * FROM duplicate_order_approvals WHERE id = ? AND store_id = ?').get(id, user.storeId);
  if (!row) throw new ApiError(404, 'Request not found.');
  const outcome = decision === 'approve' ? 'approved' : 'rejected';
  const claimed = db.prepare(`UPDATE duplicate_order_approvals SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND status = 'pending'`)
    .run(outcome, user.id, decision === 'reject' ? String(note).trim() : (note || null), id);
  if (claimed.changes !== 1) throw new ApiError(409, 'This request has already been handled.');
  notifications.notify({
    storeId: row.store_id, userIds: [row.requested_by], type: 'approval_decided', severity: outcome === 'approved' ? 'info' : 'warning',
    title: outcome === 'approved' ? 'You can confirm that order now' : 'A manager refused to confirm that order',
    body: decision === 'reject' ? String(note).trim() : null, entityType: 'order', entityId: row.order_id, dedupeKey: `duplicate_order_decided:${id}`,
  });
}

function decideStockAdjustment({ id, user, decision, note }) {
  const row = db.prepare('SELECT * FROM stock_adjustment_requests WHERE id = ? AND store_id = ?').get(id, user.storeId);
  if (!row) throw new ApiError(404, 'Request not found.');
  if (row.status !== 'pending') throw new ApiError(409, `This request is already ${row.status}.`);
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(row.product_id);
  const label = `${product?.name || 'Product'} ${row.change_qty > 0 ? '+' : ''}${row.change_qty}`;
  let outcome = decision === 'approve' ? 'approved' : 'rejected';
  let reviewNote = decision === 'reject' ? String(note).trim() : null;

  db.transaction(() => {
    const claimed = db.prepare(`UPDATE stock_adjustment_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ? AND status = 'pending'`)
      .run(outcome, user.id, reviewNote, id);
    if (claimed.changes !== 1) throw new ApiError(409, 'This request has already been handled.');
    if (decision !== 'approve') return;
    try {
      stockAdjust.apply({ storeId: row.store_id, productId: row.product_id, changeQty: row.change_qty, movementReason: stockAdjust.REASONS[row.reason] || 'adjustment', userId: user.id });
    } catch (err) {
      if (!(err instanceof ApiError) || err.statusCode !== 400) throw err;
      // Stock moved since it was asked for and the change can no longer apply: close it as failed rather than leave it waiting.
      outcome = 'failed'; reviewNote = err.message;
      db.prepare(`UPDATE stock_adjustment_requests SET status = 'failed', review_note = ? WHERE id = ?`).run(err.message, id);
    }
  })();

  notifications.notify({
    storeId: row.store_id, userIds: [row.requested_by], type: 'approval_decided', severity: outcome === 'approved' ? 'info' : 'warning',
    title: `Your stock change (${label}) ${outcome === 'approved' ? 'was approved' : outcome === 'failed' ? 'could not be applied' : 'was rejected'}`,
    body: reviewNote, entityType: 'approval', entityId: id, dedupeKey: `stock_adjustment_decided:${id}`,
  });
  if (outcome === 'failed') throw new ApiError(409, reviewNote || 'The stock change could not be applied.');
}

module.exports = { list, decide, parseId, thresholdCents };
