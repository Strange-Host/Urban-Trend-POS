const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const settingsService = require('../services/settings.service');
const systemConfig = require('../services/systemConfig.service');

// The mail password (smtp_pass_enc) must never leave the server, even encrypted.
function publicView(all) {
  const rest = { ...all };
  for (const key of systemConfig.SECRET_KEYS) delete rest[key];
  return rest;
}

const getAll = asyncHandler(async (req, res) => {
  res.json({ data: publicView(settingsService.getAll()) });
});

const update = asyncHandler(async (req, res) => {
  // security_* values have their own validated screen (Security) so a typo can't, say, make the lock time longer than the sign-out time.
  const blocked = Object.keys(req.body || {}).filter((k) => systemConfig.MANAGED_KEYS.has(k) || k.startsWith('security_'));
  if (blocked.length) {
    throw new ApiError(400, `${blocked.join(', ')} can only be changed from their own section in Settings, which validates them.`);
  }
  // Percent settings must be a number from 0 to 100; the discount cap and the VAT report both divide by them.
  for (const key of ['max_discount_percent', 'vat_rate_percent']) {
    if (req.body?.[key] === undefined) continue;
    const n = Number(req.body[key]);
    if (String(req.body[key]).trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) {
      throw new ApiError(400, `${key === 'vat_rate_percent' ? 'VAT rate' : 'Maximum discount'} must be a number between 0 and 100.`);
    }
  }
  if (req.body?.delivery_use_area_rates !== undefined && !['0', '1'].includes(String(req.body.delivery_use_area_rates))) {
    throw new ApiError(400, 'delivery_use_area_rates must be 0 or 1.');
  }
  res.json({ data: publicView(settingsService.setMany(req.body, req.user.id)) });
});

module.exports = { getAll, update };
