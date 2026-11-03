/** Kenyan numbers to international digits for wa.me: 0712 345 678 -> 254712345678. */
export function toInternational(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (d.startsWith("254") && d.length === 12) return d;
  if (d.startsWith("0") && d.length === 10) return `254${d.slice(1)}`;
  if ((d.startsWith("7") || d.startsWith("1")) && d.length === 9) return `254${d}`;
  return d.length >= 10 ? d : null;
}

export const telUrl = (raw: string) => `tel:${raw.replace(/[^\d+]/g, "")}`;

export function whatsappUrl(raw: string): string | null {
  const n = toInternational(raw);
  return n ? `https://wa.me/${n}` : null;
}
