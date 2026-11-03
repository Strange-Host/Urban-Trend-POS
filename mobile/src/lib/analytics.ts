import type { AnalyticsRange, ChannelRow, TrendPoint } from "../api/types";

export const RANGES: { key: AnalyticsRange; label: string }[] = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "all", label: "All time" },
];

export const CHANNEL_LABEL: Record<string, string> = {
  local: "Local store",
  shopify: "Shopify",
  woocommerce: "WooCommerce",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day as YYYY-MM-DD (not UTC: a Nairobi evening must not roll into tomorrow). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

/** Date window for a range. `prev*` is the same-length window just before it (none for "all"). */
export function rangeWindow(range: AnalyticsRange, now: Date = new Date()) {
  if (range === "all") return { from: "1970-01-01", prevFrom: null, prevTo: null };
  const n = Number(range);
  return {
    from: isoDay(addDays(now, -n)),
    prevFrom: isoDay(addDays(now, -2 * n)),
    prevTo: isoDay(addDays(now, -n - 1)),
  };
}

/** 1234567 -> "1.2M", 45300 -> "45.3K", 900 -> "900". Takes whole shillings, not cents. */
export function compact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const fmt = (v: number, suffix: string) => `${sign}${(Math.round(v * 10) / 10).toString().replace(/\.0$/, "")}${suffix}`;
  if (a >= 1_000_000_000) return fmt(a / 1_000_000_000, "B");
  if (a >= 1_000_000) return fmt(a / 1_000_000, "M");
  if (a >= 1_000) return fmt(a / 1_000, "K");
  return `${sign}${Math.round(a)}`;
}

/** Percent change from `before` to `now`. null when there is nothing to compare against. */
export function deltaPct(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || before <= 0) return null;
  return ((now - before) / before) * 100;
}

/** Round up to a "nice" axis maximum (1, 2, 2.5, 5 or 10 times a power of ten), same rule as the web chart. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

export interface Bar {
  key: string;
  label: string; // axis / tooltip label
  bySource: Record<string, number>;
  total: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parseDay = (s: string) => {
  const [y = 1970, m = 1, d = 1] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const shortDay = (s: string) => {
  const d = parseDay(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

function sum(a: Record<string, number>, b: Record<string, number>) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}
const total = (m: Record<string, number>) => Object.values(m).reduce((s, v) => s + v, 0);

/**
 * Turns the daily series into chart bars: 7 and 30 days stay daily (empty days are drawn as zero so the axis is
 * continuous), 90 days becomes weeks and all-time becomes months (last 12), so bars stay readable on a phone.
 */
export function buildBars(trend: TrendPoint[], range: AnalyticsRange, now: Date = new Date()): Bar[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const p of trend) byDay.set(p.day, sum(byDay.get(p.day) ?? {}, p.bySource));

  if (range === "7" || range === "30") {
    const n = Number(range);
    const out: Bar[] = [];
    for (let i = n; i >= 0; i--) {
      const day = isoDay(addDays(now, -i));
      const by = byDay.get(day) ?? {};
      out.push({ key: day, label: shortDay(day), bySource: by, total: total(by) });
    }
    return out;
  }

  const groups = new Map<string, { label: string; by: Record<string, number> }>();
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    const d = parseDay(day);
    let key: string;
    let label: string;
    if (range === "90") {
      const monday = addDays(d, -((d.getDay() + 6) % 7));
      key = isoDay(monday);
      label = `Wk ${shortDay(key)}`;
    } else {
      key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      label = `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    }
    const g = groups.get(key) ?? { label, by: {} };
    g.by = sum(g.by, byDay.get(day)!);
    groups.set(key, g);
  }
  const bars = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, g]) => ({ key, label: g.label, bySource: g.by, total: total(g.by) }));
  return range === "all" ? bars.slice(-12) : bars;
}

/** Revenue per channel type, for the split bar. Zero channels are dropped. */
export function channelTotals(rows: ChannelRow[]): { sourceType: string; revenueCents: number }[] {
  const t: Record<string, number> = {};
  for (const r of rows) t[r.sourceType] = (t[r.sourceType] ?? 0) + r.revenueCents;
  return Object.entries(t)
    .filter(([, v]) => v > 0)
    .map(([sourceType, revenueCents]) => ({ sourceType, revenueCents }));
}

export function humanize(s: string): string {
  const t = s.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
