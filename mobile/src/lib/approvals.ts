/**
 * Does approving this amount need fingerprint or face? The server decides (BIOMETRIC_REQUIRED) with this same rule:
 * at or above the owner's limit. A limit of null means the owner never asks.
 */
export function needsBiometric(amountCents: number | null | undefined, limitCents: number | null | undefined): boolean {
  if (limitCents === null || limitCents === undefined) return false;
  return (amountCents ?? 0) >= limitCents;
}
