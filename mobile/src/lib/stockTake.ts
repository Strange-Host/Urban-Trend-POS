import type { StockTakeLine } from "../api/typesV11";

// Counting logic that must not depend on the screen: what a difference is, which ones need a decision, and how the sheet
// on the phone and the sheet on the server are merged so that nothing counted is ever lost.

/** What was counted minus what the system thinks is there: negative = missing stock. */
export const varianceOf = (counted: number, system: number): number => counted - system;

/** A difference bigger than the approval limit (in units) waits for an owner or manager. */
export const needsApproval = (variance: number, limitUnits: number): boolean => Math.abs(variance) > limitUnits;

/** One counted product as the phone holds it. `dirty` = typed on the phone and not yet confirmed saved on the server. */
export interface LocalLine {
  productId: number;
  name: string;
  sku: string;
  barcode: string | null;
  countedQty: number;
  systemQty: number;
  dirty: boolean;
}

/**
 * Merge the server's draft with the phone's copy.
 *  - a line the phone has changed and not saved (dirty) wins: it is newer than what the server knows
 *  - otherwise the server's line wins (it may have been counted on another phone, or already saved)
 *  - a line only the phone has is kept (the save may still be on its way)
 */
export function mergeDraft(server: StockTakeLine[], local: LocalLine[]): LocalLine[] {
  const out = new Map<number, LocalLine>();
  for (const l of server) {
    out.set(l.productId, { productId: l.productId, name: l.name, sku: l.sku, barcode: l.barcode, countedQty: l.countedQty, systemQty: l.systemQty, dirty: false });
  }
  for (const l of local) {
    const s = out.get(l.productId);
    if (!s) out.set(l.productId, { ...l });
    else if (l.dirty) out.set(l.productId, { ...s, countedQty: l.countedQty, dirty: true });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.productId - b.productId);
}

/** The lines still to be sent to the server, in batches the server accepts (it takes up to 500 per call). */
export function pendingBatches(lines: LocalLine[], size = 200): { productId: number; countedQty: number }[][] {
  const todo = lines.filter((l) => l.dirty).map((l) => ({ productId: l.productId, countedQty: l.countedQty }));
  const out: { productId: number; countedQty: number }[][] = [];
  for (let i = 0; i < todo.length; i += size) out.push(todo.slice(i, i + size));
  return out;
}

/** After a successful save of `sent`, mark those lines clean - unless they were changed again while the save was in flight. */
export function markSaved(lines: LocalLine[], sent: { productId: number; countedQty: number }[]): LocalLine[] {
  const was = new Map(sent.map((s) => [s.productId, s.countedQty]));
  return lines.map((l) => (was.has(l.productId) && was.get(l.productId) === l.countedQty ? { ...l, dirty: false } : l));
}

export function summarize(lines: Pick<LocalLine, "countedQty" | "systemQty">[], limitUnits: number) {
  let short = 0;
  let over = 0;
  let matching = 0;
  let needs = 0;
  for (const l of lines) {
    const v = varianceOf(l.countedQty, l.systemQty);
    if (v < 0) short += -v;
    else if (v > 0) over += v;
    else matching += 1;
    if (v !== 0 && needsApproval(v, limitUnits)) needs += 1;
  }
  return { counted: lines.length, unitsShort: short, unitsOver: over, matching, needsApproval: needs };
}

/** AsyncStorage key for one person's draft of one sheet. */
export const draftKey = (userId: number, takeId: number) => `ut.stocktake.draft.v1.${userId}.${takeId}`;
