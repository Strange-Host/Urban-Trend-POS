// The shop works in East Africa Time (UTC+3, no daylight saving). Pay periods, work days and "late" are all measured on
// the shop's clock, in whole seconds (no floating point, so exactly 08:00:00 is never charged as late).
const EAT_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

export const isDateString = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** The shop's calendar date (YYYY-MM-DD) for an instant. */
export function shopDate(at: Date): string {
  return new Date(at.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Seconds since midnight, shop time. */
export function shopSecondsOfDay(at: Date): number {
  const local = at.getTime() + EAT_OFFSET_MS;
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 1000);
}

/** The instant a shop day begins (00:00 shop time), as a UTC Date. */
export function shopDayStart(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - EAT_OFFSET_MS);
}

/** The instant just after a shop day ends (the start of the next day). */
export function shopDayEnd(date: string): Date {
  return new Date(shopDayStart(date).getTime() + DAY_MS);
}

export const ceilDiv = (a: number, b: number) => Math.ceil(a / b);
