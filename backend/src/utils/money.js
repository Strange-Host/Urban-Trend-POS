const ApiError = require('./ApiError');

// Money is integer cents everywhere in the backend. This is the one place that turns text into cents, cents into text,
// takes a percentage of an amount, and splits an amount, all without floating point:
//
//   toCents('1,500.50')      -> 150050        (null when it is not an amount)
//   requireCents(v, 'Price') -> cents, 0 for blank, ApiError 422 for rubbish
//   formatMoney(150050)      -> '1500.50'     (plain digits, no grouping; display grouping belongs to the frontend)
//   percentToBp('16.5')      -> 1650          (basis points: 1 bp = 0.01%)
//   percentOf(10050, '5')    -> 503           (half-up, integer arithmetic)
//   split(1000, 3)           -> [334, 333, 333]  (always adds back to the total)
//   allocate(1000, [1, 1, 2])-> [250, 250, 500]

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// Reads a decimal such as "19.99", "1,500.00", " 7 ", ".5", "-2.5" or 1e-7 into an integer scaled by 10^decimals, by
// working on the digits (never value * 100). Like parseFloat it reads the leading number and ignores trailing text.
// Beyond `decimals` places it rounds half up (half towards zero for negatives, which is what Math.round does).
// Returns null when there is no number at the start, or the result would not be a safe integer.
function parseScaled(value, decimals) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const s = String(value).replace(/[,\s]/g, '');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?/.exec(s);
  const intPart = m[2];
  const fracPart = m[3] || '';
  if (!m || (intPart === '' && fracPart === '')) return null;

  let digits = intPart + fracPart;
  let point = intPart.length + Number(m[4] || 0);
  if (point < 0) { digits = '0'.repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const whole = digits.slice(0, point) || '0';
  const frac = digits.slice(point);
  const rest = frac.slice(decimals);

  let n = Number(whole + frac.slice(0, decimals).padEnd(decimals, '0'));
  const negative = m[1] === '-';
  if (rest) {
    const more = /[1-9]/.test(rest.slice(1));
    const roundUp = negative ? (rest[0] > '5' || (rest[0] === '5' && more)) : rest[0] >= '5';
    if (roundUp) n += 1;
  }
  if (!Number.isSafeInteger(n)) return null;
  return negative && n !== 0 ? -n : n;
}

const toCents = (value) => parseScaled(value, 2);
const percentToBp = (value) => parseScaled(value, 2);

// For amounts that arrive from outside (a product feed, a form). Blank counts as zero unless allowBlank is false;
// anything that is not an amount is refused, so a bad price can never become a silent 0.
function requireCents(value, label = 'Amount', { allowBlank = true } = {}) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    if (allowBlank) return 0;
    throw new ApiError(422, `${label} is missing.`);
  }
  const cents = toCents(value);
  if (cents === null) throw new ApiError(422, `${label} "${String(value).slice(0, 40)}" is not a valid amount.`);
  return cents;
}

// Integer cents to "1234.56". Negative amounts get a leading minus.
function formatMoney(cents) {
  if (!Number.isInteger(cents)) throw new TypeError(`formatMoney needs whole cents, got ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// round(a / b) for integers, halves rounded up, like Math.round but exact. b must be positive.
function roundDiv(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || b <= 0) throw new TypeError(`roundDiv needs integers and a positive divisor, got ${a} / ${b}`);
  const q = Math.floor((2 * a + b) / (2 * b));
  if (!Number.isSafeInteger(2 * a + b)) throw new RangeError('Amount too large for exact arithmetic.');
  return q;
}

function bpOf(percent) {
  const bp = percentToBp(percent);
  if (bp === null) throw new TypeError(`Not a percentage: ${percent}`);
  return bp;
}

// `percent` of an amount, e.g. percentOf(10050, 5) or percentOf(10050, '2.5'). Percent keeps two decimals.
function percentOf(cents, percent) {
  const bp = bpOf(percent);
  if (!Number.isSafeInteger(cents * bp)) throw new RangeError('Amount too large for exact arithmetic.');
  return roundDiv(cents * bp, 10000);
}

// The tax already inside a tax-inclusive amount: gross x rate / (100 + rate).
function inclusivePart(gross, ratePercent) {
  const bp = bpOf(ratePercent);
  if (!Number.isSafeInteger(gross * bp)) throw new RangeError('Amount too large for exact arithmetic.');
  return roundDiv(gross * bp, 10000 + bp);
}

// Shares of a total that always add back to the total. Weights are non-negative integers; the leftover cents go to the
// largest remainders (earlier entries first on a tie).
function allocate(total, weights) {
  if (!Number.isInteger(total)) throw new TypeError('allocate needs whole cents.');
  if (!Array.isArray(weights) || weights.length === 0 || weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new TypeError('allocate needs a list of non-negative whole weights.');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) throw new TypeError('allocate needs at least one weight above zero.');
  const sign = total < 0 ? -1 : 1;
  const t = Math.abs(total);
  const base = weights.map((w) => Math.floor((t * w) / sum));
  if (!Number.isSafeInteger(t * sum)) throw new RangeError('Amount too large for exact arithmetic.');
  let left = t - base.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => ({ i, r: (t * w) % sum })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; base[i] += 1; left -= 1; }
  return base.map((v) => (v === 0 ? 0 : sign * v));
}

// Equal shares: split(1000, 3) -> [334, 333, 333].
function split(total, parts) {
  if (!Number.isInteger(parts) || parts < 1) throw new TypeError('split needs at least one part.');
  return allocate(total, Array(parts).fill(1));
}

module.exports = { toCents, requireCents, formatMoney, percentToBp, percentOf, inclusivePart, roundDiv, allocate, split, MAX_SAFE };
