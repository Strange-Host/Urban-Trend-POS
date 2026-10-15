const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const salesService = require('../services/sales.service');
const cashSessionsService = require('../services/cashSessions.service');
const { PAGINATION } = require('../config/limits');

// POST /api/sales  — checkout

const checkout = asyncHandler(async (req, res) => {
  const { items, payments, customerId, discountTotal, clientSaleId } = req.body;
  // Resolved from the logged-in cashier's own open session, never trusted
  // from the client — otherwise a sale could be attributed to someone
  // else's shift. A cashier with no open session just checks out with
  // cash_session_id NULL, same as before this feature existed.
  const openSession = cashSessionsService.getCurrentOpen(req.user.id, req.user.storeId);
  const sale = salesService.checkout({
    storeId: req.user.storeId,
    cashierId: req.user.id,
    customerId,
    cashSessionId: openSession?.id || null,
    items,
    payments,
    discountTotal: discountTotal || 0,
    clientSaleId: clientSaleId || null,
  });
  res.status(201).json({ data: salesService.getSaleWithItems(sale.id, req.user.storeId) });
});

// GET /api/sales?from=&to=&cashier_id=&page=&pageSize=
const list = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const pageSize = Math.min(parseInt(req.query.pageSize) || PAGINATION.DEFAULT_PAGE_SIZE, PAGINATION.MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  // 1.2 — always scoped to the caller's own store. There used to be an
  // `includeAllChannels=1` flag here that swapped the store filter for
  // `1=1`, letting ANY authenticated user (not just admins — any role, any
  // store) see every other store's sales just by passing that query
  // param. "Channels" here means local register vs. Shopify vs. WooCommerce
  // (source_type, filterable below) — it never meant "other stores'
  // physical branches," so removing the store-boundary bypass doesn't
  // remove any real capability, just the accidental leak. If a genuine
  // cross-store rollup view is wanted later, that needs its own
  // deliberately-scoped role/permission — not a client-supplied boolean.
  const where = ['s.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.from) { where.push('s.created_at >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('s.created_at <= ?'); params.push(req.query.to); }
  if (req.query.cashier_id) { where.push('s.cashier_id = ?'); params.push(req.query.cashier_id); }
  if (req.query.source_type) { where.push('s.source_type = ?'); params.push(req.query.source_type); }
  if (req.query.income_source_id) { where.push('s.income_source_id = ?'); params.push(req.query.income_source_id); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT s.*, u.name AS cashier_name, st.name AS store_name, iso.name AS income_source_name, iso.platform AS income_source_platform
    FROM sales s
    JOIN users u ON u.id = s.cashier_id
    LEFT JOIN stores st ON st.id = s.store_id
    LEFT JOIN income_sources iso ON iso.id = s.income_source_id
    ${whereSql}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) c FROM sales s ${whereSql}`).get(...params).c;

  res.json({ data: rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
});

// GET /api/sales/:id
const getById = asyncHandler(async (req, res) => {
  const sale = salesService.getSaleWithItems(req.params.id, req.user.storeId);
  if (!sale) throw new ApiError(404, 'Sale not found.');
  res.json({ data: sale });
});

// POST /api/sales/:id/void  — manager/admin only, restocks items
const voidSale = asyncHandler(async (req, res) => {
  const sale = salesService.voidSale(req.params.id, req.user.storeId, req.user.id);
  res.json({ data: sale });
});

module.exports = { checkout, list, getById, voidSale };
