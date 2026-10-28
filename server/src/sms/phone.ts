/** The last nine digits: +254712345678, 0712 345 678 and 712345678 are the same number. */
export const last9 = (phone: unknown): string => String(phone ?? '').replace(/\D/g, '').slice(-9);

/**
 * A Kenyan mobile number in the form SMS gateways want (2547XXXXXXXX or 2541XXXXXXXX), or null. Never a guess: a number that does not
 * look like a Kenyan mobile is skipped, instead of paying for a message that cannot arrive.
 */
export function toMsisdn(phone: unknown): string | null {
  const nine = last9(phone);
  return /^[17]\d{8}$/.test(nine) ? `254${nine}` : null;
}

/** 25471****678: enough to recognise, not enough to misuse, for logs and screens. */
export function maskPhone(msisdn: unknown): string {
  const s = String(msisdn ?? '');
  return s.length > 6 ? `${s.slice(0, 5)}****${s.slice(-3)}` : '****';
}
