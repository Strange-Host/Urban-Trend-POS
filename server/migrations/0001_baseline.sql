-- Baseline. The real tables arrive phase by phase (ledger in phase 2, orders in phase 3, and so on).
-- This only proves the migration path end to end on an empty database.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
