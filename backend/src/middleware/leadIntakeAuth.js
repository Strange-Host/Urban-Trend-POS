const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

// The website form plugin proves it is ours with a shared secret in the
// X-Intake-Secret HEADER (WPForms webhooks support custom headers). Unlike the
// payment callbacks it is NOT put in the URL — so it can never end up in an
// access log. Fails closed: no LEAD_INTAKE_SECRET configured means no intake,
// not open intake (the older system accepted anyone's POST).
function requireIntakeSecret(req, res, next) {
  const expected = process.env.LEAD_INTAKE_SECRET;
  if (!expected) {
    logger.error('Lead intake rejected: LEAD_INTAKE_SECRET is not set.');
    throw new ApiError(503, 'Lead intake is not configured.');
  }
  const provided = Buffer.from(String(req.get('x-intake-secret') || ''));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    throw new ApiError(401, 'Invalid or missing intake secret.');
  }
  next();
}

module.exports = { requireIntakeSecret };
