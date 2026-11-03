/** Compact age for lists: "4h", "35m", "2d". */
export function ageShort(iso: string, now: number = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
