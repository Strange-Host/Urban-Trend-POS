// Small helpers for the dashboard's "how are we doing" numbers.

/** Percentage change from `previous` to `current`, or null when there is nothing to compare with (no sales before). */
export function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * One revenue figure per day, oldest first, from the sales-trend rows ([{ day, source_type, revenue }]).
 * `include(row)` picks which rows count (e.g. only the local store). Days on which any channel sold are all
 * listed, so two series built from the same rows line up, with 0 where the chosen rows sold nothing.
 */
export function dailySeries(rows, include = () => true) {
  const byDay = new Map();
  for (const r of rows || []) {
    byDay.set(r.day, (byDay.get(r.day) || 0) + (include(r) ? r.revenue : 0));
  }
  return [...byDay.keys()].sort().map((d) => byDay.get(d));
}
