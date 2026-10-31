const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { logStaffAction } = require('../utils/auditLog');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { dateParam, dateOf, localDate } = require('../utils/storeTime');
const permissionsService = require('../services/permissions.service');
const notifications = require('../services/notifications.service');
const stock = require('../services/stock.service');
const { scopeStore } = require('./stockReceiving.controller');

// Outlet opening / closing counts.
//   - Staff count the shelf and submit { product, counted }. The system records what it expected at that moment, so the
//     variance (counted - expected) is fixed at submission and cannot be edited afterwards.
//   - A different person (admin / manager) then approves or rejects it. Approving may also post the variances as
//     'stocktake' adjustments so the system matches the shelf.
//   - The day summary ties an opening and a closing count together: opening count + everything the ledger moved in
//     between should equal the closing count. Whatever it does not explain is the shortage (or surplus) for the day.

const isAdmin = (u) => u.role === 'admin';
const COUNT_SELECT = `
  SELECT c.*, st.name AS store_name, su.name AS submitted_by_name, ru.name AS reviewed_by_name
  FROM stock_counts c
  JOIN stores st ON st.id = c.store_id
  JOIN users su ON su.id = c.submitted_by_staff_id
  LEFT JOIN users ru ON ru.id = c.reviewed_by_staff_id
`;

function present(count, { withLines = false } = {}) {
  const lines = db.prepare(`
    SELECT i.product_id, i.expected_qty, i.counted_qty, i.variance, p.name AS product_name, p.sku
    FROM stock_count_items i JOIN products p ON p.id = i.product_id WHERE i.count_id = ? ORDER BY p.name
  `).all(count.id);
  const out = {
    ...count,
    products_counted: lines.length,
    lines_with_variance: lines.filter((l) => l.variance !== 0).length,
    units_short: lines.reduce((n, l) => n + (l.variance < 0 ? -l.variance : 0), 0),
    units_over: lines.reduce((n, l) => n + (l.variance > 0 ? l.variance : 0), 0),
    // Products the shop holds stock of that this count did not include - a partial count is allowed, but is visible.
    products_not_counted: db.prepare(`
      SELECT COUNT(*) AS c FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.store_id = ? AND i.quantity > 0 AND p.is_active = 1
        AND i.product_id NOT IN (SELECT product_id FROM stock_count_items WHERE count_id = ?)
    `).get(count.store_id, count.id).c,
  };
  if (withLines) out.lines = lines;
  return out;
}

// GET /api/stock/counts?store_id=&date=&kind=&status=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const storeId = scopeStore(req);
  const where = ['c.store_id = @storeId'];
  const params = { storeId };
  const date = dateParam(req.query.date, 'date', null);
  if (date) { where.push('c.count_date = @date'); params.date = date; }
  if (req.query.kind) { where.push('c.kind = @kind'); params.kind = String(req.query.kind); }
  if (req.query.status) { where.push('c.status = @status'); params.status = String(req.query.status); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(`${COUNT_SELECT} ${whereSql} ORDER BY c.count_date DESC, c.kind ASC, c.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset });
  const total = db.prepare(`SELECT COUNT(*) AS c FROM stock_counts c ${whereSql}`).get(params).c;
  res.json(paginatedResponse({ rows: rows.map((r) => present(r)), total, page, limit }));
});

function loadVisible(req) {
  const c = db.prepare(`${COUNT_SELECT} WHERE c.id = ?`).get(req.params.id);
  if (!c || (c.store_id !== req.user.storeId && !permissionsService.can(req.user, 'stock.review'))) throw new ApiError(404, 'Count not found.');
  return c;
}

// GET /api/stock/counts/:id
const getOne = asyncHandler(async (req, res) => {
  res.json({ data: present(loadVisible(req), { withLines: true }) });
});

// POST /api/stock/counts  { kind: 'opening'|'closing', count_date?, note?, items: [{ product_id, counted_qty }] }
// Always counts the caller's own branch.
const submit = asyncHandler(async (req, res) => {
  const user = req.user;
  const b = req.body || {};
  if (!['opening', 'closing'].includes(b.kind)) throw new ApiError(400, 'kind must be "opening" or "closing".');
  const countDate = stock.parseDate(b.count_date, 'count_date');
  if (countDate > stock.shopToday()) throw new ApiError(400, 'count_date cannot be in the future.');
  if (countDate < localDate(7)) throw new ApiError(400, 'A count can only be recorded for the last 7 days.');
  if (!Array.isArray(b.items) || b.items.length === 0) throw new ApiError(400, 'Count at least one product.');
  if (b.items.length > 2000) throw new ApiError(400, 'A count can have at most 2000 products.');

  const seen = new Set();
  const lines = b.items.map((it, idx) => {
    if (!Number.isInteger(it.product_id)) throw new ApiError(400, `Line ${idx + 1}: product_id is required.`);
    if (!Number.isInteger(it.counted_qty) || it.counted_qty < 0) throw new ApiError(400, `Line ${idx + 1}: counted_qty must be a whole number, zero or more.`);
    if (seen.has(it.product_id)) throw new ApiError(400, `Line ${idx + 1}: that product is already in this count.`);
    seen.add(it.product_id);
    const p = db.prepare('SELECT id, approval_status FROM products WHERE id = ?').get(it.product_id);
    if (!p || p.approval_status !== 'approved') throw new ApiError(404, `Line ${idx + 1}: product not found.`);
    return { product_id: p.id, counted: it.counted_qty };
  });

  const id = db.transaction(() => {
    const existing = db.prepare('SELECT id, status FROM stock_counts WHERE store_id = ? AND count_date = ? AND kind = ?').get(user.storeId, countDate, b.kind);
    if (existing) {
      if (existing.status !== 'rejected') {
        throw new ApiError(409, `The ${b.kind} count for ${countDate} was already submitted (${existing.status}).`, null, 'COUNT_EXISTS');
      }
      db.prepare('DELETE FROM stock_count_items WHERE count_id = ?').run(existing.id); // a rejected count may be redone
      db.prepare('DELETE FROM stock_counts WHERE id = ?').run(existing.id);
    }
    const mark = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM inventory_movements').get().m;
    const countId = db.prepare(`
      INSERT INTO stock_counts (store_id, count_date, kind, note, submitted_by_staff_id, ledger_mark) VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.storeId, countDate, b.kind, stock.trimmed(b.note) || null, user.id, mark).lastInsertRowid;
    const ins = db.prepare('INSERT INTO stock_count_items (count_id, product_id, expected_qty, counted_qty, variance) VALUES (?, ?, ?, ?, ?)');
    for (const l of lines) {
      const expected = stock.quantityOf(l.product_id, user.storeId);
      ins.run(countId, l.product_id, expected, l.counted, l.counted - expected);
    }
    return countId;
  })();

  const count = present(db.prepare(`${COUNT_SELECT} WHERE c.id = ?`).get(id), { withLines: true });
  logStaffAction({
    staffId: user.id, action: 'create', entityType: 'stock_count', entityId: id,
    after: { store_id: user.storeId, count_date: countDate, kind: b.kind, products: count.products_counted, units_short: count.units_short, units_over: count.units_over },
  });
  if (count.lines_with_variance > 0) {
    notifications.notify({
      storeId: user.storeId, roles: ['admin', 'manager'], type: 'stock_count_variance', severity: 'warning',
      title: `${b.kind === 'opening' ? 'Opening' : 'Closing'} stock count does not match`,
      body: `${user.name}: ${count.lines_with_variance} product(s) differ (${count.units_short} short, ${count.units_over} over) on ${countDate}.`,
      entityType: 'stock_count', entityId: id, dedupeKey: `stock_count_variance:${id}`,
    });
  }
  res.status(201).json({ data: count });
});

function loadPendingCount(req) {
  const c = loadVisible(req);
  if (c.status !== 'submitted') throw new ApiError(409, `This count is already ${c.status}.`);
  if (c.submitted_by_staff_id === req.user.id && !isAdmin(req.user)) throw new ApiError(403, 'You submitted this count, so someone else has to review it.');
  return c;
}

// POST /api/stock/counts/:id/approve  { note?, apply_adjustments? }
const approve = asyncHandler(async (req, res) => {
  const c = loadPendingCount(req);
  const apply = Boolean(req.body && req.body.apply_adjustments);
  const lines = db.prepare('SELECT product_id, variance FROM stock_count_items WHERE count_id = ?').all(c.id);

  db.transaction(() => {
    const fresh = db.prepare('SELECT status FROM stock_counts WHERE id = ?').get(c.id);
    if (fresh.status !== 'submitted') throw new ApiError(409, `This count is already ${fresh.status}.`);
    if (apply) {
      for (const l of lines) {
        if (l.variance === 0) continue;
        stock.applyMovement({ productId: l.product_id, storeId: c.store_id, change: l.variance, reason: 'stocktake', referenceType: 'stocktake', referenceId: c.id, userId: req.user.id });
      }
    }
    db.prepare(`
      UPDATE stock_counts SET status = 'approved', reviewed_by_staff_id = ?, reviewed_at = datetime('now'), review_note = ?, adjustments_applied = ? WHERE id = ?
    `).run(req.user.id, stock.trimmed(req.body && req.body.note) || null, apply ? 1 : 0, c.id);
  })();

  const after = present(db.prepare(`${COUNT_SELECT} WHERE c.id = ?`).get(c.id), { withLines: true });
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'stock_count', entityId: c.id, before: c, after: { ...c, status: 'approved', adjustments_applied: apply ? 1 : 0 } });
  res.json({ data: after });
});

// POST /api/stock/counts/:id/reject  { note }
const reject = asyncHandler(async (req, res) => {
  const c = loadPendingCount(req);
  const note = stock.trimmed(req.body && req.body.note);
  if (!note) throw new ApiError(400, 'Say why you are rejecting it (note is required).');
  db.prepare(`UPDATE stock_counts SET status = 'rejected', reviewed_by_staff_id = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?`).run(req.user.id, note, c.id);
  const after = present(db.prepare(`${COUNT_SELECT} WHERE c.id = ?`).get(c.id), { withLines: true });
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'stock_count', entityId: c.id, before: c, after: { ...c, status: 'rejected', review_note: note } });
  notifications.notify({
    storeId: c.store_id, userIds: [c.submitted_by_staff_id], type: 'stock_count_rejected', severity: 'warning',
    title: 'Stock count rejected', body: note, entityType: 'stock_count', entityId: c.id,
  });
  res.json({ data: after });
});

// GET /api/stock/counts/day-summary?store_id=&date=
// For every product present in BOTH the day's opening and closing count:
//   expected_closing = opening count + the ledger's real stock flows between the two counts
//   unexplained      = closing count - expected_closing   (negative = missing)
// 'stocktake' adjustments are left out of those flows: they are corrections that bring the system into line with a
// count, not stock coming or going. Counting them would cancel the very shortage being measured (approving the opening
// count with adjustments posts one right after it).
const daySummary = asyncHandler(async (req, res) => {
  const storeId = scopeStore(req);
  const date = dateParam(req.query.date, 'date', stock.shopToday());
  const find = (kind) => db.prepare(`${COUNT_SELECT} WHERE c.store_id = ? AND c.count_date = ? AND c.kind = ? AND c.status != 'rejected'`).get(storeId, date, kind);
  const opening = find('opening');
  const closing = find('closing');
  const out = {
    store_id: storeId, date,
    opening: opening ? { id: opening.id, status: opening.status, submitted_by_name: opening.submitted_by_name, submitted_at: opening.submitted_at } : null,
    closing: closing ? { id: closing.id, status: closing.status, submitted_by_name: closing.submitted_by_name, submitted_at: closing.submitted_at } : null,
    lines: [], totals: { units_missing: 0, units_surplus: 0, products_with_difference: 0 },
  };
  if (!opening || !closing) return res.json({ data: out });

  const rows = db.prepare(`
    SELECT o.product_id, p.name AS product_name, p.sku, o.counted_qty AS opening_counted, c.counted_qty AS closing_counted
    FROM stock_count_items o
    JOIN stock_count_items c ON c.product_id = o.product_id AND c.count_id = ?
    JOIN products p ON p.id = o.product_id
    WHERE o.count_id = ? ORDER BY p.name
  `).all(closing.id, opening.id);
  const mv = db.prepare(`
    SELECT reason, SUM(change_qty) AS qty FROM inventory_movements
    WHERE store_id = ? AND product_id = ? AND id > ? AND id <= ? AND reason != 'stocktake' GROUP BY reason
  `);
  for (const r of rows) {
    const moved = {};
    let net = 0;
    for (const m of mv.all(storeId, r.product_id, opening.ledger_mark, closing.ledger_mark)) { moved[m.reason] = m.qty; net += m.qty; }
    const expectedClosing = r.opening_counted + net;
    const unexplained = r.closing_counted - expectedClosing;
    out.lines.push({ ...r, movements: moved, net_movement: net, expected_closing: expectedClosing, unexplained });
    if (unexplained < 0) out.totals.units_missing += -unexplained;
    if (unexplained > 0) out.totals.units_surplus += unexplained;
    if (unexplained !== 0) out.totals.products_with_difference += 1;
  }
  res.json({ data: out });
});

// GET /api/stock/activity?store_id=&staff_id=&from=&to=&include_sales=1&limit=
// Who did what with stock at one branch: every stock movement that is not an ordinary sale (receipts, issues, transfers,
// stocktake and manual adjustments, voids, returns), count submissions and reviews, and transfer requests and decisions,
// newest first, plus a per-person tally. Defaults to the last 7 days.
const activity = asyncHandler(async (req, res) => {
  const storeId = scopeStore(req);
  const from = dateParam(req.query.from, 'from', localDate(7));
  const to = dateParam(req.query.to, 'to', stock.shopToday());
  const staffId = req.query.staff_id ? Number(req.query.staff_id) : null;
  const includeSales = req.query.include_sales === '1' || req.query.include_sales === 'true';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);

  const entries = [];
  const movementRows = db.prepare(`
    SELECT m.id, m.created_at, m.created_by AS staff_id, COALESCE(u.name, 'System') AS staff_name, m.reason, m.change_qty,
           m.reference_type, m.reference_id, p.name AS product_name, p.sku
    FROM inventory_movements m
    JOIN products p ON p.id = m.product_id
    LEFT JOIN users u ON u.id = m.created_by
    WHERE m.store_id = @storeId AND ${dateOf('m.created_at')} BETWEEN @from AND @to
      ${includeSales ? '' : "AND m.reason != 'sale'"} ${staffId ? 'AND m.created_by = @staffId' : ''}
  `).all({ storeId, from, to, ...(staffId ? { staffId } : {}) });
  for (const m of movementRows) {
    entries.push({ at: m.created_at, staff_id: m.staff_id, staff_name: m.staff_name, kind: m.reason, product_name: m.product_name, sku: m.sku, change_qty: m.change_qty, reference_type: m.reference_type, reference_id: m.reference_id });
  }

  const countRows = db.prepare(`${COUNT_SELECT} WHERE c.store_id = @storeId AND ${dateOf('c.submitted_at')} BETWEEN @from AND @to`).all({ storeId, from, to });
  for (const c of countRows) {
    if (!staffId || c.submitted_by_staff_id === staffId) {
      entries.push({ at: c.submitted_at, staff_id: c.submitted_by_staff_id, staff_name: c.submitted_by_name, kind: `count_${c.kind}_submitted`, reference_type: 'stock_count', reference_id: c.id, detail: `${c.count_date}` });
    }
    if (c.reviewed_at && (!staffId || c.reviewed_by_staff_id === staffId)) {
      entries.push({ at: c.reviewed_at, staff_id: c.reviewed_by_staff_id, staff_name: c.reviewed_by_name, kind: `count_${c.kind}_${c.status}`, reference_type: 'stock_count', reference_id: c.id, detail: `${c.count_date}${c.adjustments_applied ? ' (adjusted)' : ''}` });
    }
  }

  const transferRows = db.prepare(`
    SELECT t.*, ru.name AS requested_by_name, vu.name AS reviewed_by_name
    FROM stock_transfers t JOIN users ru ON ru.id = t.requested_by_staff_id LEFT JOIN users vu ON vu.id = t.reviewed_by_staff_id
    WHERE (t.from_store_id = @storeId OR t.to_store_id = @storeId) AND ${dateOf('t.created_at')} BETWEEN @from AND @to
  `).all({ storeId, from, to });
  for (const t of transferRows) {
    if (!staffId || t.requested_by_staff_id === staffId) entries.push({ at: t.created_at, staff_id: t.requested_by_staff_id, staff_name: t.requested_by_name, kind: 'transfer_requested', reference_type: 'transfer', reference_id: t.id });
    if (t.reviewed_at && (!staffId || t.reviewed_by_staff_id === staffId)) entries.push({ at: t.reviewed_at, staff_id: t.reviewed_by_staff_id, staff_name: t.reviewed_by_name, kind: `transfer_${t.status}`, reference_type: 'transfer', reference_id: t.id });
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const tally = new Map();
  for (const e of entries) {
    const key = e.staff_id || 0;
    if (!tally.has(key)) tally.set(key, { staff_id: e.staff_id, staff_name: e.staff_name, actions: 0, units_in: 0, units_out: 0 });
    const t = tally.get(key);
    t.actions += 1;
    if (e.change_qty > 0) t.units_in += e.change_qty;
    if (e.change_qty < 0) t.units_out += -e.change_qty;
  }
  res.json({ data: { store_id: storeId, from, to, summary: [...tally.values()].sort((a, b) => b.actions - a.actions), entries: entries.slice(0, limit), truncated: entries.length > limit } });
});

module.exports = { list, getOne, submit, approve, reject, daySummary, activity };
