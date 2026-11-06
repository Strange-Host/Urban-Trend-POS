const asyncHandler = require('../utils/asyncHandler');
const cursorUtil = require('../utils/cursor');
const { auditV1 } = require('../utils/mobileAudit');
const { deviceIdOf } = require('../utils/mobileAudit');
const svc = require('../services/mobileTelesales.service');

const idOf = (req) => Number(req.params.id);
const list = asyncHandler(async (req, res) => { res.json(svc.list({ user: req.user, cursor: req.query.cursor, limit: cursorUtil.pageSize(req.query.limit) })); });
const get = asyncHandler(async (req, res) => { res.json(svc.detail({ id: idOf(req), user: req.user })); });

const confirm = asyncHandler(async (req, res) => {
  const out = svc.confirm({ id: idOf(req), user: req.user });
  auditV1(req, { action: 'update', entityType: 'order', entityId: idOf(req), after: { telesales: 'confirmed' } });
  res.json(out);
});
const reschedule = asyncHandler(async (req, res) => {
  const out = svc.reschedule({ id: idOf(req), user: req.user, callbackAt: req.body.callbackAt, note: req.body.note });
  auditV1(req, { action: 'update', entityType: 'order', entityId: idOf(req), after: { telesales: 'rescheduled', callbackAt: out.callbackAt }, reason: req.body.note || null });
  res.json(out);
});
const cancel = asyncHandler(async (req, res) => {
  const out = svc.cancel({ id: idOf(req), user: req.user, reason: req.body.reason });
  auditV1(req, { action: 'update', entityType: 'order', entityId: idOf(req), after: { telesales: 'cancelled' }, reason: req.body.reason });
  res.json(out);
});
const requestApproval = asyncHandler(async (req, res) => {
  const r = svc.requestApproval({ id: idOf(req), user: req.user, note: req.body.note, deviceId: deviceIdOf(req) });
  if (r.created) auditV1(req, { action: 'create', entityType: 'duplicate_order_approval', entityId: r.id, after: { orderId: idOf(req) }, reason: req.body.note || null });
  res.status(r.created ? 201 : 200).json({ approval: r.approval });
});

module.exports = { list, get, confirm, reschedule, cancel, requestApproval };
