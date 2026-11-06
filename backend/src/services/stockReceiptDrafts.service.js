const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const permissionsService = require('./permissions.service');
const stock = require('./stock.service');
const receiving = require('./stockReceiving.service');

// Draft receipts (redesign Phase 5). A draft is a delivery that is half entered: saved so it can be finished later, by the
// same person or by someone who reviews stock. It is only a saved request body. It never posts stock, never creates a
// product, supplier or category, and appears in no report; submitting it runs the ordinary receive (createReceipt), which
// is where stock goes in and where every rule is checked.
//
// Because the real checks happen at submit, a draft may be incomplete or even wrong: the only things refused when saving are
// the ones that make it unusable (not the main store, an impossible date, a supplier that does not exist, too many lines).

const MAX_LINES = 200;            // same ceiling as a receipt
const MAX_BODY_BYTES = 256 * 1024; // a draft is a form, not a file store
const KEPT_KEYS = ['supplier_id', 'new_supplier', 'reference', 'note', 'received_on', 'items'];

const LIST_SELECT = `
  SELECT d.id, d.store_id, d.supplier_id, d.reference, d.received_on, d.line_count, d.created_at, d.updated_at,
         d.created_by_staff_id, u.name AS created_by_name, s.name AS supplier_name
  FROM stock_receipt_drafts d
  JOIN users u ON u.id = d.created_by_staff_id
  LEFT JOIN suppliers s ON s.id = d.supplier_id
`;

// Same rule createReceipt applies: only someone who manages products and may see buying prices can put a cost on a line.
const canCostLines = (user) => permissionsService.can(user, 'products.manage') && permissionsService.can(user, 'products.view_cost');

function requireMainStore(user) {
  if (!stock.isMainStore(user.storeId)) {
    throw new ApiError(409, 'Shipments are received at the main store. Outlets are supplied by a transfer.', null, 'NOT_MAIN_STORE');
  }
}

// The caller's own drafts; a stock reviewer sees every draft in the branch. Anything else is "not found", not "forbidden",
// so a draft's existence is not revealed to someone who may not open it.
function loadVisible(user, id) {
  const row = db.prepare(`${LIST_SELECT} WHERE d.id = ?`).get(id);
  const mine = row && row.created_by_staff_id === user.id;
  if (!row || row.store_id !== user.storeId || (!mine && !permissionsService.can(user, 'stock.review'))) {
    throw new ApiError(404, 'Draft not found.');
  }
  return row;
}

function cleanBody(user, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'A draft needs the receipt form as an object.');
  const body = {};
  for (const key of KEPT_KEYS) if (input[key] !== undefined) body[key] = input[key];

  if (body.items === undefined) body.items = [];
  if (!Array.isArray(body.items)) throw new ApiError(400, 'items must be a list.');
  if (body.items.length > MAX_LINES) throw new ApiError(400, `A shipment can have at most ${MAX_LINES} lines; split it into two receipts.`);
  const allowCost = canCostLines(user);
  body.items = body.items.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError(400, `Line ${idx + 1}: each line must be an object.`);
    const line = { ...item };
    // A buying price is dropped for anyone who may not set one, so it is never stored on their behalf.
    if (!allowCost) {
      delete line.unit_cost;
      if (line.new_product && typeof line.new_product === 'object') line.new_product = { ...line.new_product, cost_price: undefined };
    }
    return line;
  });

  if (body.received_on !== undefined && body.received_on !== null && body.received_on !== '') {
    const day = stock.parseDate(body.received_on, 'received_on');
    if (day > stock.shopToday()) throw new ApiError(400, 'received_on cannot be in the future.');
  }
  if (body.supplier_id) {
    const s = db.prepare('SELECT id, is_active FROM suppliers WHERE id = ?').get(body.supplier_id);
    if (!s || !s.is_active) throw new ApiError(400, 'That supplier does not exist (or has been switched off).');
  }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw new ApiError(400, 'That draft is too large to save.');
  return body;
}

const present = (row, body) => ({ ...row, ...(body ? { body } : {}) });

// What a person may read of a stored body: another person's buying prices only if they could set them themselves.
function readableBody(user, json) {
  const body = JSON.parse(json);
  if (!canCostLines(user)) {
    body.items = (body.items || []).map((line) => {
      const { unit_cost: _dropped, ...rest } = line;
      return rest.new_product ? { ...rest, new_product: { ...rest.new_product, cost_price: undefined } } : rest;
    });
  }
  return body;
}

// GET /api/stock/receipts/drafts
function listDrafts({ user }) {
  const where = ['d.store_id = @storeId'];
  const params = { storeId: user.storeId };
  if (!permissionsService.can(user, 'stock.review')) { where.push('d.created_by_staff_id = @userId'); params.userId = user.id; }
  const rows = db.prepare(`${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC, d.id DESC`).all(params);
  return { data: rows };
}

// GET /api/stock/receipts/drafts/:id
function getDraft({ params, user }) {
  const row = loadVisible(user, params.id);
  const stored = db.prepare('SELECT body FROM stock_receipt_drafts WHERE id = ?').get(row.id).body;
  return { data: present(row, readableBody(user, stored)) };
}

// POST /api/stock/receipts/drafts   (new draft)   |   PUT /api/stock/receipts/drafts/:id   (replace its contents)
function saveDraft({ user, params, body: input }) {
  requireMainStore(user);
  const body = cleanBody(user, input);
  const columns = {
    supplier_id: body.supplier_id ? Number(body.supplier_id) : null,
    reference: stock.trimmed(body.reference) || null,
    received_on: body.received_on ? String(body.received_on) : null,
    line_count: body.items.length,
    body: JSON.stringify(body),
  };

  if (params && params.id) {
    const existing = loadVisible(user, params.id);
    db.prepare(`
      UPDATE stock_receipt_drafts SET supplier_id = @supplier_id, reference = @reference, received_on = @received_on,
             line_count = @line_count, body = @body, updated_at = datetime('now') WHERE id = @id
    `).run({ ...columns, id: existing.id });
    logStaffAction({ staffId: user.id, action: 'update', entityType: 'stock_receipt_draft', entityId: existing.id, after: { lines: columns.line_count } });
    return { data: present(loadVisible(user, existing.id), JSON.parse(columns.body)) };
  }

  const id = db.prepare(`
    INSERT INTO stock_receipt_drafts (store_id, created_by_staff_id, supplier_id, reference, received_on, line_count, body)
    VALUES (@store_id, @created_by, @supplier_id, @reference, @received_on, @line_count, @body)
  `).run({ ...columns, store_id: user.storeId, created_by: user.id }).lastInsertRowid;
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'stock_receipt_draft', entityId: id, after: { lines: columns.line_count } });
  return { data: present(loadVisible(user, id), JSON.parse(columns.body)) };
}

// DELETE /api/stock/receipts/drafts/:id
function deleteDraft({ params, user }) {
  const row = loadVisible(user, params.id);
  db.prepare('DELETE FROM stock_receipt_drafts WHERE id = ?').run(row.id);
  logStaffAction({ staffId: user.id, action: 'delete', entityType: 'stock_receipt_draft', entityId: row.id, before: { lines: row.line_count } });
  return { data: { id: row.id, deleted: true } };
}

// POST /api/stock/receipts/drafts/:id/submit
// Runs the ordinary receive with the saved form, then deletes the draft, in ONE transaction: either the stock went in and the
// draft is gone, or nothing happened and the draft is still there with the error. A second submit finds no draft, so one
// draft can never put stock in twice. The receipt is made by whoever submits, with the same permission checks as a direct receive.
function submitDraft({ params, user }) {
  const run = db.transaction(() => {
    const row = loadVisible(user, params.id);
    const body = readableBody(user, db.prepare('SELECT body FROM stock_receipt_drafts WHERE id = ?').get(row.id).body);
    const result = receiving.createReceipt({ user, body });
    db.prepare('DELETE FROM stock_receipt_drafts WHERE id = ?').run(row.id);
    return { result, draftId: row.id, lines: row.line_count };
  });
  const { result, draftId, lines } = run();
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'stock_receipt_draft', entityId: draftId, before: { lines }, after: { submitted_as_receipt: result.data.id } });
  return result;
}

module.exports = { listDrafts, getDraft, saveDraft, deleteDraft, submitDraft };
