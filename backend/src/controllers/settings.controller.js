const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const settingsService = require('../services/settings.service');
const systemConfig = require('../services/systemConfig.service');

// The mail password (smtp_pass_enc) and the Resend API key (resend_api_key_enc) must never leave the server, even encrypted.
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
  res.json({ data: publicView(settingsService.setMany(req.body, req.user.id)) });
});

module.exports = { getAll, update };
