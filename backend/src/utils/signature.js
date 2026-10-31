const ApiError = require('./ApiError');

// A typed-name signature, the same convention the employee onboarding agreement already uses. Case, extra spaces
// and a leading/trailing space are forgiven; a different name is not. The signer's own account name is the
// reference, so nobody can sign for someone else by typing their name into their own screen.
const normalizeName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Returns the cleaned signature text, or throws 422.
 * @param {string} typed        what the person typed
 * @param {string} accountName  the name on their account
 * @param {string} what         short phrase for the error, e.g. 'the request'
 */
function requireSignature(typed, accountName, what = 'this') {
  const clean = String(typed ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) {
    throw new ApiError(422, `Type your full name to sign ${what}.`, null, 'SIGNATURE_REQUIRED');
  }
  if (normalizeName(clean) !== normalizeName(accountName)) {
    throw new ApiError(422, `The name you typed does not match your account name (${accountName}). Type it exactly to sign ${what}.`, null, 'SIGNATURE_MISMATCH');
  }
  return clean;
}

module.exports = { normalizeName, requireSignature };
