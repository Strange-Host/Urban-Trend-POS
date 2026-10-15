const ApiError = require('./ApiError');

// The shop's own clock. Every timestamp in the database is UTC (datetime('now')), but "today",
// "this week's sales" and "which day did this sale fall on" mean the SHOP's calendar day. In
// Kenya that is UTC+3, so a sale rung up at 1:30 am belongs to today, not to yesterday's UTC
// date. Default Africa/Nairobi; STORE_TIMEZONE (an IANA name) overrides it for another country.
// The offset is looked up per call, so a zone with daylight saving stays correct for "now".
const TZ = process.env.STORE_TIMEZONE || 'Africa/Nairobi';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(at) {
  const o = {};
  for (const p of fmt.formatToParts(at)) o[p.type] = p.value;
  return o;
}

// Minutes the shop clock is ahead of UTC (Nairobi: 180).
function offsetMinutes(at = new Date()) {
  const p = parts(at);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

// A quoted SQLite date modifier, e.g. '+180 minutes'. Built from a number we computed, never
// from user input, so it is safe to put straight into SQL text.
function sqlOffset(at) {
  const m = offsetMinutes(at);
  return `'${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes'`;
}

// SQL for "the shop's calendar day of this UTC timestamp column".
const dateOf = (column) => `date(${column}, ${sqlOffset()})`;
// SQL for "today's date at the shop" and "the shop's current hour 00-23".
const todaySql = () => `date('now', ${sqlOffset()})`;
const hourNowSql = () => `strftime('%H', 'now', ${sqlOffset()})`;

// 'YYYY-MM-DD' at the shop, `daysAgo` days back.
function localDate(daysAgo = 0, at = new Date()) {
  const p = parts(new Date(at.getTime() - daysAgo * 86400000));
  return `${p.year}-${p.month}-${p.day}`;
}

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// A date-only query value (from/to/date). Returns the fallback when it is absent; 400 when it is
// present but not a real YYYY-MM-DD, instead of silently comparing a malformed string.
function dateParam(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !isRealDate(value)) {
    throw new ApiError(400, `${name} must be a date in YYYY-MM-DD format.`);
  }
  return value;
}

module.exports = { TZ, offsetMinutes, sqlOffset, dateOf, todaySql, hourNowSql, localDate, dateParam };
