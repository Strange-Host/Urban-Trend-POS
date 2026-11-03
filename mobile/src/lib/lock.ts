/** True when the app has been in the background longer than the auto-lock limit. */
export function shouldLock(
  backgroundedAt: number | null,
  now: number,
  limitSeconds: number,
): boolean {
  if (backgroundedAt === null) return false;
  return now - backgroundedAt >= limitSeconds * 1000;
}
