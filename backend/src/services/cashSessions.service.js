const db = require('../config/db');
const ApiError = require('../utils/ApiError');

/** The currently open session for this cashier at this store, or null. */
function getCurrentOpen(userId, storeId) {
  return db.prepare(`
    SELECT * FROM cash_sessions WHERE user_id = ? AND store_id = ? AND closed_at IS NULL
  `).get(userId, storeId) || null;
}

function open(userId, storeId, openingAmount) {
  if (getCurrentOpen(userId, storeId)) {
    throw new ApiError(409, 'You already have an open cash session. Close it before opening a new one.');
  }
  if (typeof openingAmount !== 'number' || openingAmount < 0) {
    throw new ApiError(400, 'openingAmount must be a non-negative number.');
  }
  const result = db.prepare(`
    INSERT INTO cash_sessions (store_id, user_id, opening_amount) VALUES (?, ?, ?)
  `).run(storeId, userId, openingAmount);
  return db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Expected cash in the drawer at close = opening float + cash actually
 * collected during the session. "Cash actually collected" is read from
 * `payments` (the real per-method breakdown of a sale, including split
 * payments), not `sales.payment_method` (which collapses a split payment
 * down to just 'split' and can't tell you how much of it was cash) — so a
 * split cash+card sale is correctly counted for its cash portion only.
 * Voided sales are excluded, since that cash didn't stay in the drawer.
 */
function expectedCashFor(sessionId) {
  const session = db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new ApiError(404, 'Cash session not found.');

  const cashCollected = db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS total
    FROM payments p
    JOIN sales s ON s.id = p.sale_id
    WHERE s.cash_session_id = ? AND p.method = 'cash' AND s.status != 'voided'
  `).get(sessionId).total;

  return session.opening_amount + cashCollected;
}

function close(sessionId, userId, closingAmount) {
  const session = db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new ApiError(404, 'Cash session not found.');
  if (session.user_id !== userId) throw new ApiError(403, 'You can only close your own cash session.');
  if (session.closed_at) throw new ApiError(409, 'This cash session is already closed.');
  if (typeof closingAmount !== 'number' || closingAmount < 0) {
    throw new ApiError(400, 'closingAmount must be a non-negative number.');
  }

  const expectedAmount = expectedCashFor(sessionId);

  db.prepare(`
    UPDATE cash_sessions SET closing_amount = ?, expected_amount = ?, closed_at = datetime('now') WHERE id = ?
  `).run(closingAmount, expectedAmount, sessionId);

  return db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(sessionId);
}

// 1.3 — scoped by storeId: without this, any authenticated user could view
// another store's cash session (including its expected/actual cash totals)
// just by guessing/enumerating a session id.
function getById(sessionId, storeId) {
  const session = db.prepare('SELECT * FROM cash_sessions WHERE id = ? AND store_id = ?').get(sessionId, storeId);
  if (!session) throw new ApiError(404, 'Cash session not found.');
  const salesSummary = db.prepare(`
    SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
    FROM sales WHERE cash_session_id = ? AND status != 'voided'
    GROUP BY payment_method
  `).all(sessionId);
  return { ...session, salesSummary };
}

function list({ storeId, userId, page = 1, pageSize = 20 }) {
  // Columns are qualified (cs.) because the query below joins users, which ALSO has a store_id:
  // unqualified, SQLite rejects it as "ambiguous column name", so this endpoint answered 500 for
  // every request and the Cash sessions tab never loaded.
  const where = ['cs.store_id = ?'];
  const params = [storeId];
  if (userId) { where.push('cs.user_id = ?'); params.push(userId); }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM cash_sessions cs WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = db.prepare(`
    SELECT cs.*, u.name AS cashier_name
    FROM cash_sessions cs JOIN users u ON u.id = cs.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY cs.opened_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  return { data: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

module.exports = { open, close, getCurrentOpen, getById, list };
