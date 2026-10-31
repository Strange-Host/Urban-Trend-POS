// How a till sale is paid for: one method for the whole amount, or split across several (typically "Cash + M-Pesa").
// The checkout API already takes a list of payments whose amounts add up exactly to the sale total (integer cents), so
// this only turns what the cashier typed into that list, and says what is still missing.

export const METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'mobile_money', label: 'M-Pesa', refLabel: 'M-Pesa code' },
  { key: 'card', label: 'Card', refLabel: 'Card ref' },
];

export const methodLabel = (key) => METHODS.find((m) => m.key === key)?.label || String(key).replace('_', ' ');

const BLANK = () => ({ cash: '', mobile_money: '', card: '' });

/** mode 'single' pays the whole total with `method`; mode 'split' uses `amounts` (what the cashier typed) and `refs`. */
export const emptyPayment = (mode = 'single', method = 'cash') => ({ mode, method, amounts: BLANK(), refs: BLANK() });

/** The same choices with the typed amounts and references cleared (after a sale), so the next sale starts clean. */
export const clearedPayment = (p) => emptyPayment(p.mode, p.method);

/**
 * "1,250.50" / "1250.5" / "500" / "" -> integer cents. "" is 0 (nothing paid this way).
 * Returns null for anything that is not a plain non-negative amount with at most 2 decimals.
 * Done with strings, not floating point, so 1.15 is exactly 115.
 */
export function toCents(input) {
  const s = String(input ?? '').replace(/[,\s]/g, '');
  if (s === '') return 0;
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  return Number(m[1] || 0) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
}

export const centsToInput = (cents) => (cents / 100).toFixed(2);

const kes = (cents) => (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * -> { payments, paid, remaining, error }
 *   payments: what to send to checkout ([{ method, amount, reference? }], amounts in cents)
 *   remaining: total - paid (cents; > 0 still to take, < 0 too much)
 *   error: why it cannot be charged yet, or null when it can
 */
export function buildPayments(state, total) {
  if (state.mode !== 'split') {
    return { payments: [{ method: state.method, amount: total }], paid: total, remaining: 0, error: null };
  }

  const payments = [];
  let paid = 0;
  for (const m of METHODS) {
    const cents = toCents(state.amounts[m.key]);
    if (cents === null) {
      return { payments: [], paid, remaining: total - paid, error: `${m.label}: enter an amount like 500 or 500.50.` };
    }
    if (cents > 0) {
      paid += cents;
      const reference = String(state.refs[m.key] || '').trim();
      payments.push({ method: m.key, amount: cents, ...(reference ? { reference } : {}) });
    }
  }

  const remaining = total - paid;
  let error = null;
  if (payments.length === 0) error = 'Enter how much is paid by each method.';
  else if (remaining > 0) error = `${kes(remaining)} still to be paid.`;
  else if (remaining < 0) error = `Payments are ${kes(-remaining)} more than the total.`;
  return { payments, paid, remaining, error };
}

/** What `method` should hold so the split adds up exactly: the total minus what the other methods already cover. */
export function restFor(state, method, total) {
  let others = 0;
  for (const m of METHODS) {
    if (m.key === method) continue;
    others += toCents(state.amounts[m.key]) || 0;
  }
  const rest = total - others;
  return rest > 0 ? centsToInput(rest) : '';
}

/** "Cash 500.00 + M-Pesa 700.00" for a finished sale's payments. */
export function describePayments(payments) {
  return (payments || []).map((p) => `${methodLabel(p.method)} ${kes(p.amount)}`).join(' + ');
}
