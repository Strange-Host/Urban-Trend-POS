const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1 } = require('../utils/mobileAudit');
const permissionsService = require('../services/permissions.service');
const takes = require('../services/stockTakes.service');

// Stock-take from the phone. Counting needs stock.count; deciding on a big difference needs stock.review.
// Without stock.review you only ever see your own sheets.

const isReviewer = (user) => permissionsService.can(user, 'stock.review');

function visible(req) {
  const take = takes.getTake(Number(req.params.id));
  if (!take || take.store_id !== req.user.storeId || (take.created_by !== req.user.id && !isReviewer(req.user))) {
    throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  }
  return take;
}

const start = asyncHandler(async (req, res) => {
  const { take, resumed } = takes.start({ storeId: req.user.storeId, userId: req.user.id, scope: req.body.scope, note: req.body.note });
  if (!resumed) auditV1(req, { action: 'create', entityType: 'stock_take', entityId: take.id, after: { scope: take.scope.type, category_id: take.scope.categoryId } });
  res.status(resumed ? 200 : 201).json(take);
});

const list = asyncHandler(async (req, res) => {
  const cur = cursorUtil.decode(req.query.cursor);
  const out = takes.list({
    storeId: req.user.storeId, userId: req.user.id,
    onlyMine: req.query.mine === '1' || !isReviewer(req.user),
    status: ['draft', 'applied', 'pending_approval', 'rejected'].includes(req.query.status) ? req.query.status : null,
    beforeId: cur && Number.isInteger(cur.i) ? cur.i : null, limit: cursorUtil.pageSize(req.query.limit),
  });
  res.json({ items: out.items, nextCursor: out.more ? cursorUtil.encode({ i: out.lastId }) : null });
});

const get = asyncHandler(async (req, res) => {
  res.json(takes.present(visible(req), { withLines: true }));
});

const saveLines = asyncHandler(async (req, res) => {
  const take = takes.getTake(Number(req.params.id));
  if (take && take.store_id !== req.user.storeId) throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  res.json(takes.saveLines(Number(req.params.id), req.user, req.body.lines));
});

const submit = asyncHandler(async (req, res) => {
  const take = takes.getTake(Number(req.params.id));
  if (take && take.store_id !== req.user.storeId) throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  const out = takes.submit(Number(req.params.id), req.user);
  auditV1(req, { action: 'update', entityType: 'stock_take', entityId: Number(req.params.id), before: { status: 'draft' },
    after: { status: out.status, applied: out.applied.length, pending_approval: out.pendingApproval.length } });
  res.json(out);
});

const decide = (approve) => asyncHandler(async (req, res) => {
  const take = takes.getTake(Number(req.params.id));
  if (!take || take.store_id !== req.user.storeId) throw new ApiError(404, 'Stock-take not found.', null, 'NOT_FOUND');
  const note = approve ? req.body.note : req.body.reason;
  const out = takes.decide(take.id, req.user, { approve, note });
  auditV1(req, { action: 'update', entityType: 'stock_take', entityId: take.id, before: { status: 'pending_approval' },
    after: { status: out.take.status, applied_lines: out.appliedLines }, reason: note || null });
  res.json(out.take);
});

module.exports = { start, list, get, saveLines, submit, approve: decide(true), reject: decide(false) };
