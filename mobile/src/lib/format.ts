/** Integer cents -> "142,300" (no currency prefix, sign kept). */
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const whole = Math.round(Math.abs(cents) / 100);
  return sign + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export const formatKes = (cents: number) => `KES ${formatAmount(cents)}`;

export function timeAgo(iso: string, now: number = Date.now()): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Numeric dotted-version compare: <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
