const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const stock = require('./stock.service');
const settingsService = require('./settings.service');
const notifications = require('./notifications.service');

// A stock-take from the phone. The counted sheet (the "draft") lives on the server, so a phone that is backgrounded,
// killed or lost loses nothing, and the same person can pick the sheet up again.
//
//   draft -> submit -> applied              (every difference was small enough to apply straight away)
//                   -> pending_approval     (some difference was bigger than the limit: an owner/manager decides)
//                        -> applied | rejected
//
// Differences are posted to stock through the normal ledger (stockService.applyMovement, reason 'stocktake'), so the stock
// history explains every change. A product that was NOT counted is left alone: it is never treated as zero.

const thresholdUnits = () => {
  const n = parseInt(settingsService.getAll().stocktake_approval_units, 10);
  return Number.isInteger(n) && n >= 0 ? n : 10;
};

function assertCategory(categoryId) {
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new ApiError(400, 'That category does not exist.', null, 'INVALID_CATEGORY');
}

// The products a sheet covers: approved, switched-on shop products (the online catalogue holds no shop stock).
const scopeProductSql = (take) => `
  SELECT p.id, p.name, p.sku, p.barcode FROM products p
  WHERE p.is_active = 1 AND p.approval_status = 'approved' AND p.catalogue = 'shop'
  ${take.scope_type === 'category' ? 'AND p.category_id = @categoryId' : ''}`;

function getTake(id) {
  const t = db.prepare(`
    SELECT t.*, c.name AS category_name, u.name AS created_by_name
    FROM stock_takes t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.created_by WHERE t.id = ?
  `).get(id);
  return t || null;
}

function linesOf(take) {
  const draft = take.status === 'draft';
  const limit = thresholdUnits();
  const rows = db.prepare(`
    SELECT l.*, p.name, p.sku, p.barcode, COALESCE(i.quantity, 0) AS live_qty
    FROM stock_take_lines l JOIN products p ON p.id = l.product_id
    LEFT JOIN inventory i ON i.product_id = l.product_id AND i.store_id = ?
    WHERE l.take_id = ? ORDER BY p.name COLLATE NOCASE, p.id
  `).all(take.store_id, take.id);
  return rows.map((l) => {
    const systemQty = draft ? l.live_qty : l.expected_qty;
    const variance = draft ? l.counted_qty - l.live_qty : l.variance;
    return {
      productId: l.product_id, name: l.name, sku: l.sku, barcode: l.barcode, countedQty: l.counted_qty, systemQty, variance,
      needsApproval: draft ? Math.abs(variance) > limit : l.needs_approval === 1, applied: l.applied === 1,
    };
  });
}

function present(take, { withLines = false } = {}) {
  const lines = linesOf(take);
  const out = {
    id: take.id,
    scope: { type: take.scope_type, categoryId: take.category_id, categoryName: take.category_name || null },
    status: take.status, note: take.note,
    createdBy: { id: take.created_by, name: take.created_by_name || 'Unknown' },
    createdAt: take.created_at, submittedAt: take.submitted_at,
    lineCount: lines.length,
    varianceUnits: lines.reduce((n, l) => n + Math.abs(l.variance), 0),
    needsApprovalCount: lines.filter((l) => l.needsApproval).length,
  };
  if (take.review_note) out.reviewNote = take.review_note;
  return withLines ? { ...out, lines } : out;
}

function start({ storeId, userId, scope, note }) {
  if (scope.type === 'category') {
    if (!scope.categoryId) throw new ApiError(400, 'Pick the category to count.', null, 'INVALID_CATEGORY');
    assertCategory(scope.categoryId);
  }
  const categoryId = scope.type === 'category' ? scope.categoryId : null;
  // One open sheet per person per area: starting again resumes it.
  const existing = db.prepare(`SELECT id FROM stock_takes WHERE store_id = ? AND created_by = ? AND status = 'draft' AND scope_type = ? AND category_id IS ?`)
    .get(storeId, userId, scope.type, categoryId);
  if (existing) return { take: present(getTake(existing.id)), resumed: true };
  const r = db.prepare(`INSERT INTO stock_takes (store_id, scope_type, category_id, note, created_by) VALUES (?, ?, ?, ?, ?)`)
    .run(storeId, scope.type, categoryId, note || null, userId);
  return { take: present(getTake(Number(r.lastInsertRowid))), resumed: false };
}

function assertOwnDraft(take, user) {
  if (!take) throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  if (take.created_by !== user.id) throw new ApiError(403, 'Only the person who started this stock-take can change it.', null, 'FORBIDDEN');
  if (take.status !== 'draft') throw new ApiError(409, 'This stock-take has already been submitted.', null, 'NOT_DRAFT');
}

// Idempotent: the same product sent again just replaces its count, so a retry after a dropped connection is harmless.
// All-or-nothing: one bad line rejects the whole call and changes nothing.
function saveLines(takeId, user, lines) {
  const take = getTake(takeId);
  assertOwnDraft(take, user);
  const inScope = db.prepare(`${scopeProductSql(take)} AND p.id = @pid`);
  return db.transaction(() => {
    const up = db.prepare(`
      INSERT INTO stock_take_lines (take_id, product_id, counted_qty) VALUES (?, ?, ?)
      ON CONFLICT(take_id, product_id) DO UPDATE SET counted_qty = excluded.counted_qty
    `);
    // If the same product appears twice in one call, the last one wins.
    const latest = new Map(lines.map((l) => [l.productId, l.countedQty]));
    for (const [productId, countedQty] of latest) {
      if (!inScope.get({ pid: productId, categoryId: take.category_id })) {
        throw new ApiError(422, `Product ${productId} is not part of this stock-take.`, { productId }, 'NOT_IN_SCOPE');
      }
      up.run(takeId, productId, countedQty);
    }
    return present(getTake(takeId), { withLines: true });
  })();
}

function submit(takeId, user) {
  const take = getTake(takeId);
  assertOwnDraft(take, user);
  const limit = thresholdUnits();
  const result = db.transaction(() => {
    const lines = db.prepare('SELECT * FROM stock_take_lines WHERE take_id = ?').all(takeId);
    if (!lines.length) throw new ApiError(422, 'Count at least one product before submitting.', null, 'NO_LINES');
    const applied = []; const pendingApproval = [];
    const freeze = db.prepare('UPDATE stock_take_lines SET expected_qty = ?, variance = ?, needs_approval = ?, applied = ? WHERE take_id = ? AND product_id = ?');
    for (const l of lines) {
      const expected = stock.quantityOf(l.product_id, take.store_id);
      const variance = l.counted_qty - expected;
      const needs = Math.abs(variance) > limit;
      let done = 0;
      if (variance !== 0 && !needs) {
        stock.applyMovement({ productId: l.product_id, storeId: take.store_id, change: variance, reason: 'stocktake', referenceType: 'stocktake', referenceId: takeId, userId: user.id });
        done = 1; applied.push({ productId: l.product_id, variance });
      } else if (needs) {
        pendingApproval.push({ productId: l.product_id, variance });
      }
      freeze.run(expected, variance, needs ? 1 : 0, done, takeId, l.product_id);
    }
    const status = pendingApproval.length ? 'pending_approval' : 'applied';
    db.prepare(`UPDATE stock_takes SET status = ?, submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(status, takeId);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM (${scopeProductSql(take)})`).get({ categoryId: take.category_id }).c;
    return { status, applied, pendingApproval, notCountedCount: Math.max(total - lines.length, 0) };
  })();
  if (result.status === 'pending_approval') {
    notifications.notify({
      storeId: take.store_id, roles: ['admin', 'manager'], type: 'stock_take_pending', severity: 'warning',
      title: 'A stock-take needs your decision',
      body: `${user.name} counted ${result.pendingApproval.length} product(s) with a big difference.`,
      entityType: 'stock_take', entityId: takeId, dedupeKey: `stock_take_pending:${takeId}`,
    });
  }
  return result;
}

function decide(takeId, user, { approve, note }) {
  const take = getTake(takeId);
  if (!take) throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  if (take.status !== 'pending_approval') throw new ApiError(409, 'This stock-take is not waiting for a decision.', null, 'NOT_PENDING');
  if (take.created_by === user.id && user.role !== 'admin') {
    throw new ApiError(403, 'You counted this stock, so someone else has to decide on it.', null, 'SELF_APPROVAL');
  }
  const appliedLines = db.transaction(() => {
    let n = 0;
    if (approve) {
      const pending = db.prepare('SELECT * FROM stock_take_lines WHERE take_id = ? AND needs_approval = 1 AND applied = 0').all(takeId);
      for (const l of pending) {
        // The difference the counter found, as it stood at submit. Sales since then are real movements of their own.
        stock.applyMovement({ productId: l.product_id, storeId: take.store_id, change: l.variance, reason: 'stocktake', referenceType: 'stocktake', referenceId: takeId, userId: user.id });
        db.prepare('UPDATE stock_take_lines SET applied = 1 WHERE take_id = ? AND product_id = ?').run(takeId, l.product_id);
        n += 1;
      }
    }
    db.prepare(`UPDATE stock_takes SET status = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), review_note = ? WHERE id = ?`)
      .run(approve ? 'applied' : 'rejected', user.id, note || null, takeId);
    return n;
  })();
  notifications.notify({
    storeId: take.store_id, userIds: [take.created_by], type: approve ? 'stock_take_approved' : 'stock_take_rejected', severity: approve ? 'info' : 'warning',
    title: approve ? 'Your stock-take was approved' : 'Your stock-take was rejected', body: note || null, entityType: 'stock_take', entityId: takeId,
  });
  return { take: present(getTake(takeId), { withLines: true }), appliedLines };
}

function list({ storeId, userId, onlyMine, status, beforeId, limit }) {
  const where = ['t.store_id = @storeId']; const params = { storeId, take: limit + 1 };
  if (onlyMine) { where.push('t.created_by = @userId'); params.userId = userId; }
  if (status) { where.push('t.status = @status'); params.status = status; }
  if (beforeId) { where.push('t.id < @beforeId'); params.beforeId = beforeId; }
  const rows = db.prepare(`SELECT t.id FROM stock_takes t WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT @take`).all(params);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { items: page.map((r) => present(getTake(r.id))), more, lastId: page.length ? page[page.length - 1].id : null };
}

// Products on this sheet's area, for scanning a barcode or typing a name while counting. Works for anyone who can count, who
// need not be allowed to browse the whole catalog. systemQty is the live shop stock; cost is never included.
function searchScope(takeId, user, { q = '', barcode = '' }) {
  const take = getTake(takeId);
  if (!take || take.store_id !== user.storeId) throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  if (take.created_by !== user.id && !require('./permissions.service').can(user, 'stock.review')) throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  const where = [];
  const params = { categoryId: take.category_id, storeId: take.store_id };
  if (barcode) { where.push('p.barcode = @barcode'); params.barcode = String(barcode).slice(0, 64); }
  else if (q) { where.push('(p.name LIKE @q OR p.sku LIKE @q OR p.barcode LIKE @q)'); params.q = `%${String(q).slice(0, 100)}%`; }
  else return [];
  return db.prepare(`
    SELECT p.id, p.name, p.sku, p.barcode, COALESCE(i.quantity, 0) AS system_qty
    FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.store_id = @storeId
    WHERE p.is_active = 1 AND p.approval_status = 'approved' AND p.catalogue = 'shop'
      ${take.scope_type === 'category' ? 'AND p.category_id = @categoryId' : ''} AND ${where.join(' AND ')}
    ORDER BY p.name COLLATE NOCASE LIMIT 20
  `).all(params).map((r) => ({ productId: r.id, name: r.name, sku: r.sku, barcode: r.barcode, systemQty: r.system_qty }));
}

module.exports = { searchScope, start, saveLines, submit, decide, list, getTake, present, thresholdUnits };
