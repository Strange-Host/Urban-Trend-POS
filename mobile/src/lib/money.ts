/** "1,250.50" or "1250" (shillings) -> integer cents. Returns null for anything that is not a plain amount. */
export function parseKesToCents(input: string): number | null {
  const t = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole = "0", frac = ""] = t.split(".");
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, "0") || "0", 10);
}

/** Integer cents -> "1250" or "1250.50" for an input box (no thousands separators, so it parses back). */
export function centsToInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}
