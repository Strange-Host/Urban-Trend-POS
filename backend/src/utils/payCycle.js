// The pay cycle: one calendar month of work, paid on a fixed day of the month after (the 3rd by default).
// October is worked 1-31 October and paid on 3 November. Commission targets are per cycle, so the commission tier
// starts again from zero on the 1st of every month - a pay period can never straddle two months.
// Pure date arithmetic on 'YYYY-MM-DD' shop dates; no clock, no database.

const DEFAULT_PAY_DAY = 3;

const pad = (n) => String(n).padStart(2, '0');

function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** 'YYYY-MM' of a 'YYYY-MM-DD' date. */
const monthOf = (date) => date.slice(0, 7);

/** First and last day of 'YYYY-MM'. */
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Splits any from/to range into one { from, to } per calendar month it touches, in order. */
function monthSegments(from, to) {
  const out = [];
  let month = monthOf(from);
  const last = monthOf(to);
  while (month <= last) {
    const b = monthBounds(month);
    out.push({ from: b.from < from ? from : b.from, to: b.to > to ? to : b.to });
    month = addMonths(month, 1);
  }
  return out;
}

/** The configured pay day as a whole number 1-28 (28 so it exists in every month); anything unusable falls back to the 3rd. */
function normalizePayDay(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 28 ? n : DEFAULT_PAY_DAY;
}

/** True when both dates fall in the same calendar month. */
const sameMonth = (from, to) => monthOf(from) === monthOf(to);

/** The day a period's pay is due: the pay day of the month after the month the period ends in. */
function payDateFor(periodEnd, payDay = DEFAULT_PAY_DAY) {
  return `${addMonths(monthOf(periodEnd), 1)}-${pad(normalizePayDay(payDay))}`;
}

/** The full cycle for one month: the dates worked and the date it is paid. */
function cycleFor(month, payDay = DEFAULT_PAY_DAY) {
  const { from, to } = monthBounds(month);
  return { month, from, to, payDate: payDateFor(to, payDay) };
}

/**
 * Where "today" sits in the cycle: the month being worked now, and the month just finished (the one whose pay is
 * next to be calculated and paid).
 */
function cycleAround(today, payDay = DEFAULT_PAY_DAY) {
  const month = monthOf(today);
  return { current: cycleFor(month, payDay), previous: cycleFor(addMonths(month, -1), payDay) };
}

module.exports = { DEFAULT_PAY_DAY, isRealDate, isMonth, monthOf, monthBounds, addMonths, normalizePayDay, monthSegments, sameMonth, payDateFor, cycleFor, cycleAround };
