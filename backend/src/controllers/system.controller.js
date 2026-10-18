const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const systemConfig = require('../services/systemConfig.service');
const mailService = require('../services/mail.service');

// GET /api/system/config
const getConfig = asyncHandler(async (req, res) => {
  res.json({ data: systemConfig.describe() });
});

// PUT /api/system/config  { values: {...}, smtp_password?, clear_smtp_password?, resend_api_key?, clear_resend_api_key? }
const saveConfig = asyncHandler(async (req, res) => {
  const {
    values, smtp_password: smtpPassword, clear_smtp_password: clearSmtpPassword,
    resend_api_key: resendApiKey, clear_resend_api_key: clearResendApiKey,
  } = req.body || {};
  if (values !== undefined && (typeof values !== 'object' || values === null || Array.isArray(values))) throw new ApiError(400, 'values must be an object.');
  if (smtpPassword !== undefined && typeof smtpPassword !== 'string') throw new ApiError(400, 'smtp_password must be text.');
  if (resendApiKey !== undefined && typeof resendApiKey !== 'string') throw new ApiError(400, 'resend_api_key must be text.');
  res.json({
    data: systemConfig.save({
      values: values || {}, smtpPassword, clearSmtpPassword: clearSmtpPassword === true,
      resendApiKey, clearResendApiKey: clearResendApiKey === true, userId: req.user.id,
    }),
  });
});

// POST /api/system/test-email  { to }
const testEmail = asyncHandler(async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new ApiError(400, 'Enter a valid email address to send the test to.');
  await mailService.sendTest(to);
  res.json({ data: { sent: true, to } });
});

// POST /api/system/check-public-url  { url? }  (defaults to the saved address)
const checkPublicUrl = asyncHandler(async (req, res) => {
  res.json({ data: await systemConfig.checkPublicUrl(req.body?.url) });
});

module.exports = { getConfig, saveConfig, testEmail, checkPublicUrl };
