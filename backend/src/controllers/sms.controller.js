const asyncHandler = require('../utils/asyncHandler');
const smsService = require('../services/sms.service');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { logStaffAction } = require('../utils/auditLog');

// GET /api/sms/status
const status = asyncHandler(async (req, res) => {
  res.json({ data: smsService.getStatus({ storeId: req.user.storeId }) });
});

// GET /api/sms/credentials — flags only, never the secrets
const getCredentials = asyncHandler(async (req, res) => {
  res.json({ data: smsService.getSafeCredentials(req.user.storeId) });
});

// PUT /api/sms/credentials
const saveCredentials = asyncHandler(async (req, res) => {
  const data = smsService.saveCredentials({ storeId: req.user.storeId, data: req.body });
  // Audit entry records THAT credentials changed, never what they are.
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'sms_credentials', entityId: req.user.storeId, before: {}, after: { credentials_updated: true } });
  res.json({ data });
});

// DELETE /api/sms/credentials
const removeCredentials = asyncHandler(async (req, res) => {
  const data = smsService.removeCredentials({ storeId: req.user.storeId });
  logStaffAction({ staffId: req.user.id, action: 'delete', entityType: 'sms_credentials', entityId: req.user.storeId, before: { credentials_removed: true } });
  res.json({ data });
});

// POST /api/sms/test
const sendTest = asyncHandler(async (req, res) => {
  const result = await smsService.sendTest({ storeId: req.user.storeId, to: req.body.to });
  res.json({ data: result });
});

// GET /api/sms/outbox?status=&page=&limit=
const listOutbox = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total } = smsService.listOutbox({ storeId: req.user.storeId, status: req.query.status || null, limit, offset });
  res.json(paginatedResponse({ rows, total, page, limit }));
});

// POST /api/sms/outbox/:id/retry
const retry = asyncHandler(async (req, res) => {
  res.json({ data: smsService.retry({ storeId: req.user.storeId, id: Number(req.params.id) }) });
});

module.exports = { status, getCredentials, saveCredentials, removeCredentials, sendTest, listOutbox, retry };
