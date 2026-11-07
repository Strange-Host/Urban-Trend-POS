// Small pure helpers for the telesales screens (kept out of the components so they can be tested).

export interface Countdown {
  /** Whole minutes left, never below zero. */
  minutes: number;
  expired: boolean;
  /** Under 30 minutes: show it as urgent. */
  urgent: boolean;
  label: string;
}

/**
 * Time left to confirm an order. `serverTime` is the server's clock when the data was fetched and `fetchedAt` the phone's clock
 * at that moment, so a phone with a wrong clock still counts down correctly.
 */
export function countdown(confirmBy: string | null, serverTime: string | null, fetchedAt: number, now: number = Date.now()): Countdown | null {
  if (!confirmBy) return null;
  const offset = serverTime ? Date.parse(serverTime) - fetchedAt : 0;
  const left = Date.parse(confirmBy) - (now + offset);
  if (Number.isNaN(left)) return null;
  if (left <= 0) return { minutes: 0, expired: true, urgent: true, label: "Window ended" };
  const minutes = Math.ceil(left / 60_000);
  const label = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`;
  return { minutes, expired: false, urgent: minutes < 30, label };
}

/** The callback times offered on Reschedule: quick picks that are always in the future. */
export function callbackChoices(now: Date = new Date()): { label: string; at: Date }[] {
  const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const tomorrow9 = new Date(now);
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  const tomorrow14 = new Date(tomorrow9);
  tomorrow14.setHours(14, 0, 0, 0);
  return [
    { label: "In 1 hour", at: inHours(1) },
    { label: "In 3 hours", at: inHours(3) },
    { label: "Tomorrow 9:00", at: tomorrow9 },
    { label: "Tomorrow 14:00", at: tomorrow14 },
  ];
}

/** YYYY-MM-DD for a follow-up date picked by days from today (local calendar day). */
export function followUpIn(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const isDueToday = (followUpDate: string | null, now: Date = new Date()): boolean => followUpDate !== null && followUpDate <= followUpIn(0, now);

export const REASON_LABEL = { rejected: "Customer refused it", damaged: "Arrived damaged", wrong_item: "Wrong item sent" } as const;
export const DECISION_LABEL = { restock: "Back on sale", write_off: "Written off", dispose: "Disposed" } as const;
