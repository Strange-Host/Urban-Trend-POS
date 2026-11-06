-- Draft receipts (redesign Phase 5).
--
-- A storekeeper can save a delivery half-entered and finish it later. A draft is NOT a receipt: it lives in its own table
-- as the request that would be sent to POST /api/stock/receipts, so nothing in it can touch stock, batches, costing or
-- reports. Submitting a draft runs the ordinary receive (stock goes in then) and deletes the draft in the same transaction.
--
-- Buying prices are never kept here for someone who may not see them: the service drops unit_cost before saving.

CREATE TABLE IF NOT EXISTS stock_receipt_drafts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id             INTEGER NOT NULL REFERENCES stores(id),
  created_by_staff_id  INTEGER NOT NULL REFERENCES users(id),
  supplier_id          INTEGER REFERENCES suppliers(id),   -- copied out of body for the list; body is the source of truth
  reference            TEXT,                               -- the supplier's delivery note / invoice number
  received_on          TEXT,                               -- YYYY-MM-DD; blank = the day it is submitted
  line_count           INTEGER NOT NULL DEFAULT 0,
  body                 TEXT NOT NULL,                      -- JSON: { supplier_id?, new_supplier?, reference?, note?, received_on?, items: [...] }
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_drafts_store ON stock_receipt_drafts(store_id, created_by_staff_id);
