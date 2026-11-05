import type { BulkChange, BulkSkipped } from "../api/typesV11";

// The same arithmetic the server uses for a bulk price change (backend/src/services/bulkPricing.service.js): the result is
// rounded to the nearest whole shilling, halves up. The server is the authority (the app only previews what the server
// returns); this copy lets the offline mock behave identically and lets the form show a sample before the first preview.

const SHILLING = 100;

export const toShilling = (cents: number): number => Math.floor(cents / SHILLING + 0.5 + 1e-9) * SHILLING;

export function newPrice(oldCents: number, mode: "percent" | "fixed", value: number): number {
  const raw = mode === "percent" ? (oldCents * (100 + value)) / 100 : oldCents + value;
  return toShilling(raw);
}

export interface PlanProduct {
  id: number;
  name: string;
  sku: string;
  sellPriceCents: number;
}

/** Splits products into the ones that change and the ones skipped (zero or less, or no change). */
export function planBulk(products: PlanProduct[], change: Pick<BulkChange, "mode" | "value">) {
  const items: { productId: number; name: string; sku: string; oldPriceCents: number; newPriceCents: number; deltaCents: number }[] = [];
  const skipped: BulkSkipped[] = [];
  for (const p of products) {
    const np = newPrice(p.sellPriceCents, change.mode, change.value);
    if (np <= 0) skipped.push({ productId: p.id, name: p.name, reason: "PRICE_NOT_POSITIVE" });
    else if (np === p.sellPriceCents) skipped.push({ productId: p.id, name: p.name, reason: "UNCHANGED" });
    else items.push({ productId: p.id, name: p.name, sku: p.sku, oldPriceCents: p.sellPriceCents, newPriceCents: np, deltaCents: np - p.sellPriceCents });
  }
  return { items, skipped };
}

/** A one-line description of a change for lists and confirmations: "+10%" or "-KES 50". */
export function describeChange(mode: string, value: number): string {
  if (mode === "percent") return `${value > 0 ? "+" : ""}${value}%`;
  if (mode === "fixed") {
    const whole = Math.round(Math.abs(value) / 100);
    return `${value < 0 ? "-" : "+"}KES ${whole}`;
  }
  return "Revert";
}
