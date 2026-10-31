const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');

// How each person's commission is worked out. Stored on the user (users.commission_*), changed by an admin only.
//   fixed        a set amount per unit sold. commission_fixed_cents is that amount; when it is empty the store's
//                achievement tiers (settings commission_*_kes) set it, which is how everyone was paid before pay
//                types existed - so every existing account is already 'fixed' with no override and nothing moves.
//   percentage   a share of each secured order's total, in basis points (250 = 2.5%). No per-unit amount.
//   combined     the per-unit amount and the percentage, added together.
// All money is integer cents; percentages are integer basis points (10000 = 100%), so there is no floating point.

const TYPES = ['fixed', 'percentage', 'combined'];

const termsError = (message, code = 'PAY_TERMS_INVALID') => new ApiError(422, message, null, code);

const toTerms = (u) => ({
  type: u.commission_type || 'fixed',
  fixedCents: u.commission_fixed_cents ?? null,
  percentBp: u.commission_percent_bp ?? 0,
});

/** One person's terms. Unknown staff come back as the default (fixed, store tiers), never an error. */
function getTerms(staffId) {
  const u = db.prepare('SELECT commission_type, commission_fixed_cents, commission_percent_bp FROM users WHERE id = ?').get(staffId);
  return toTerms(u || {});
}

/** Everyone in the store who can earn commission, with their terms. */
function listTerms({ storeId }) {
  return db.prepare(`
    SELECT id, name, role, is_active, commission_type, commission_fixed_cents, commission_percent_bp
      FROM users WHERE store_id = ? AND is_active = 1 ORDER BY name
  `).all(storeId).map((u) => ({ staffId: u.id, name: u.name, role: u.role, ...toTerms(u) }));
}

function validate({ type, fixedCents, percentBp }) {
  if (!TYPES.includes(type)) throw termsError(`Pay type must be one of ${TYPES.join(', ')}.`, 'PAY_TYPE_INVALID');

  const hasFixed = fixedCents !== undefined && fixedCents !== null;
  if (hasFixed && (!Number.isSafeInteger(fixedCents) || fixedCents < 0)) {
    throw termsError('The fixed amount per unit must be a whole number of cents, zero or more.');
  }
  const bp = percentBp === undefined || percentBp === null ? 0 : percentBp;
  if (!Number.isSafeInteger(bp) || bp < 0 || bp > 10000) {
    throw termsError('The percentage must be between 0% and 100% (0 to 10000 basis points).');
  }

  if (type === 'fixed') return { type, fixedCents: hasFixed ? fixedCents : null, percentBp: 0 };
  if (bp === 0) throw termsError(`A ${type} pay type needs a percentage above 0%. Use "fixed" for pay with no percentage.`, 'PERCENT_REQUIRED');
  // A percentage-only person has no per-unit amount at all, whatever was sent.
  if (type === 'percentage') return { type, fixedCents: null, percentBp: bp };
  return { type, fixedCents: hasFixed ? fixedCents : null, percentBp: bp };
}

/** Sets one person's terms. Run payroll drafts must be regenerated to pick them up (an approved run never changes). */
function setTerms({ staffId, storeId, type, fixedCents, percentBp, actorId }) {
  const user = db.prepare('SELECT id, name, store_id FROM users WHERE id = ? AND store_id = ?').get(staffId, storeId);
  if (!user) throw new ApiError(404, 'Staff member not found.');
  const next = validate({ type, fixedCents, percentBp });
  const before = getTerms(staffId);

  db.prepare(`UPDATE users SET commission_type = ?, commission_fixed_cents = ?, commission_percent_bp = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(next.type, next.fixedCents, next.percentBp, staffId);
  logStaffAction({ staffId: actorId, action: 'update', entityType: 'pay_terms', entityId: staffId, before, after: next });
  return { staffId: user.id, name: user.name, ...next };
}

/** The commission one order earns under these terms, given the per-unit amount the tiers worked out. All cents. */
function commissionForOrder({ terms, tierRate, units, total }) {
  const perUnit = terms.fixedCents != null ? terms.fixedCents : tierRate;
  const unitPart = terms.type === 'percentage' ? 0 : units * perUnit;
  const percentPart = terms.type === 'fixed' ? 0 : Math.floor((total * terms.percentBp) / 10000);
  return unitPart + percentPart;
}

/** The per-unit amount that applies to this person (0 for percentage-only). */
function unitRateFor({ terms, tierRate }) {
  if (terms.type === 'percentage') return 0;
  return terms.fixedCents != null ? terms.fixedCents : tierRate;
}

module.exports = { TYPES, getTerms, listTerms, setTerms, validate, commissionForOrder, unitRateFor };
