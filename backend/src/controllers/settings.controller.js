const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const settingsService = require('../services/settings.service');
const systemConfig = require('../services/systemConfig.service');
const { compare, isVersion } = require('../utils/appVersion');

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
  if (req.body?.clockout_gate_mode !== undefined && !['reason', 'block'].includes(String(req.body.clockout_gate_mode))) {
    throw new ApiError(400, 'clockout_gate_mode must be "reason" or "block".');
  }
  if (req.body?.inventory_valuation_method !== undefined && !['fifo', 'average'].includes(String(req.body.inventory_valuation_method))) {
    throw new ApiError(400, 'inventory_valuation_method must be fifo or average.');
  }
  if (req.body?.expiry_alert_days !== undefined) {
    const n = Number(req.body.expiry_alert_days);
    if (String(req.body.expiry_alert_days).trim() === '' || !Number.isInteger(n) || n < 0 || n > 365) {
      throw new ApiError(400, 'Expiry alert days must be a whole number from 0 to 365.');
    }
  }
  // The mobile app compares these as version numbers, so a typo here would quietly block or free every phone.
  for (const key of ['app_min_version', 'app_latest_version']) {
    if (req.body?.[key] !== undefined && !isVersion(req.body[key])) {
      throw new ApiError(400, `${key} must be a version number such as 1.2.0.`);
    }
  }
  const nextMin = req.body?.app_min_version ?? settingsService.getAll().app_min_version;
  const nextLatest = req.body?.app_latest_version ?? settingsService.getAll().app_latest_version;
  if ((req.body?.app_min_version !== undefined || req.body?.app_latest_version !== undefined) && compare(nextMin, nextLatest) === 1) {
    throw new ApiError(400, 'The minimum app version cannot be higher than the latest one.');
  }
  if (req.body?.app_download_url !== undefined && req.body.app_download_url !== '' && !/^https:\/\/\S+$/i.test(String(req.body.app_download_url))) {
    throw new ApiError(400, 'app_download_url must be an https:// link.');
  }
  if (req.body?.attention_cash_variance_kes !== undefined) {
    const n = Number(req.body.attention_cash_variance_kes);
    if (String(req.body.attention_cash_variance_kes).trim() === '' || !Number.isFinite(n) || n < 0) {
      throw new ApiError(400, 'attention_cash_variance_kes must be a number of shillings, 0 or more.');
    }
  }
  for (const [key, label, max] of [['stock_adjust_approval_units', 'Stock adjustment approval units', 1000000], ['approval_biometric_above_kes', 'Biometric approval amount', 1e9]]) {
    if (req.body?.[key] === undefined) continue;
    const n = Number(req.body[key]);
    if (String(req.body[key]).trim() === '' || !Number.isFinite(n) || n < 0 || n > max) throw new ApiError(400, `${label} must be a number from 0 to ${max}.`);
  }
  if (req.body?.app_auto_lock_seconds !== undefined) {
    const n = Number(req.body.app_auto_lock_seconds);
    if (String(req.body.app_auto_lock_seconds).trim() === '' || !Number.isInteger(n) || n < 15 || n > 3600) {
      throw new ApiError(400, 'app_auto_lock_seconds must be a whole number of seconds from 15 to 3600.');
    }
  }
  if (req.body?.delivery_use_area_rates !== undefined && !['0', '1'].includes(String(req.body.delivery_use_area_rates))) {
    throw new ApiError(400, 'delivery_use_area_rates must be 0 or 1.');
  }
  res.json({ data: publicView(settingsService.setMany(req.body, req.user.id)) });
});

module.exports = { getAll, update };
