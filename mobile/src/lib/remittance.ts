import type { CourierCollection } from "../api/typesV11";

// What a courier organization should hand over for the parcels you tick: everything they collected, minus the package fees
// we owe them for those parcels (the server nets the fees off). Anything different from that is a variance to explain.

export function selectionTotals(all: CourierCollection[], selected: Set<number>) {
  let collections = 0;
  let fees = 0;
  let count = 0;
  for (const c of all) {
    if (!selected.has(c.collectionId)) continue;
    collections += c.amountCents;
    fees += c.feeCents;
    count += 1;
  }
  return { count, collectionsCents: collections, feesCents: fees, expectedCents: collections - fees };
}

export type VarianceKind = "exact" | "short" | "over";
export function remittanceVariance(receivedCents: number, expectedCents: number): { diffCents: number; kind: VarianceKind } {
  const diff = expectedCents - receivedCents; // positive = the courier handed over less than expected
  return { diffCents: diff, kind: diff === 0 ? "exact" : diff > 0 ? "short" : "over" };
}

/** The server refuses to settle more than was collected (cash + fees): catch it before the request. */
export const exceedsCollections = (receivedCents: number, t: { collectionsCents: number; feesCents: number }): boolean =>
  receivedCents + t.feesCents > t.collectionsCents;
