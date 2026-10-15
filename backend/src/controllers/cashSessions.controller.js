const asyncHandler = require('../utils/asyncHandler');
const cashSessionsService = require('../services/cashSessions.service');
const { PAGINATION } = require('../config/limits');

// GET /api/cash-sessions/current — the logged-in cashier's currently open session, or null
const current = asyncHandler(async (req, res) => {
  res.json({ data: cashSessionsService.getCurrentOpen(req.user.id, req.user.storeId) });
});

// POST /api/cash-sessions/open  { openingAmount }
const open = asyncHandler(async (req, res) => {
  const session = cashSessionsService.open(req.user.id, req.user.storeId, req.body.openingAmount);
  res.status(201).json({ data: session });
});

// POST /api/cash-sessions/:id/close  { closingAmount }
const close = asyncHandler(async (req, res) => {
  const session = cashSessionsService.close(req.params.id, req.user.id, req.body.closingAmount);
  const handover = require('../services/shift.service').recordHandover({
    userId: req.user.id, userName: req.user.name, storeId: req.user.storeId, trigger: 'cash_session_close', notes: req.body.handover_notes,
  });
  res.json({ data: session, handover });
});

// GET /api/cash-sessions/:id
const getById = asyncHandler(async (req, res) => {
  res.json({ data: cashSessionsService.getById(req.params.id, req.user.storeId) });
});

// GET /api/cash-sessions?userId=&page=&pageSize=
const list = asyncHandler(async (req, res) => {
  res.json(cashSessionsService.list({
    storeId: req.user.storeId,
    userId: req.query.userId,
    page: Number(req.query.page) || 1,
    // 3.3 — previously had no upper bound at all (a bare `|| 20`), meaning
    // ?pageSize=999999999 would run one query pulling every cash session
    // this store has ever had. Capped the same way every other list
    // endpoint in this app already is.
    pageSize: Math.min(Number(req.query.pageSize) || PAGINATION.CASH_SESSIONS_DEFAULT_PAGE_SIZE, PAGINATION.MAX_PAGE_SIZE),
  }));
});

module.exports = { current, open, close, getById, list };
