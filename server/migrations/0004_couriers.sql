-- Phase 4: couriers (riders and organizations), package fees, courier costs, payouts, organization collections and
-- statements, and custody of shop cash.
--
-- Rules enforced here: 4 (a courier's payable = fees and approved costs earned and not yet paid), 5 (an organization's
-- receivable = what it collected and has not yet remitted), 11 (every dispatch has a package fee line, even if zero with
-- a reason), 12 (package fees and courier costs are never combined into one line). Amounts are integer cents.

-- ---------------------------------------------------------------- couriers: one registry, two kinds
CREATE TABLE couriers (
  id                  bigserial PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('rider', 'organization')),
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  phone               text,
  contact_person      text,         -- organizations
  id_number           text,         -- riders
  vehicle_plate       text,         -- riders
  agent_names         text[] NOT NULL DEFAULT '{}',  -- organizations: optional named agents
  collects_payment    boolean NOT NULL DEFAULT false, -- organizations only; riders never handle money
  overdue_limit_cents bigint CHECK (overdue_limit_cents IS NULL OR overdue_limit_cents >= 0),
  overdue_after_days  integer NOT NULL DEFAULT 14 CHECK (overdue_after_days > 0),
  active              boolean NOT NULL DEFAULT true,
  created_by          text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT riders_never_collect CHECK (kind = 'organization' OR collects_payment = false),
  CONSTRAINT rider_has_no_org_fields CHECK (kind = 'organization' OR (contact_person IS NULL AND agent_names = '{}' AND overdue_limit_cents IS NULL)),
  CONSTRAINT org_has_no_rider_fields CHECK (kind = 'rider' OR (id_number IS NULL AND vehicle_plate IS NULL))
);
CREATE UNIQUE INDEX couriers_name_per_kind ON couriers (kind, lower(name));

-- Couriers are deactivated, never deleted, so past orders keep their courier. A courier's kind never changes.
CREATE FUNCTION couriers_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'couriers cannot be deleted; deactivate them instead' USING ERRCODE = '55000';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a courier''s kind and history never change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER couriers_guard BEFORE UPDATE OR DELETE ON couriers FOR EACH ROW EXECUTE FUNCTION couriers_guard();
CREATE TRIGGER couriers_no_truncate BEFORE TRUNCATE ON couriers FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- The ledger learns which courier an entry concerns, so "what do we owe this rider" is read from the ledger itself
-- and cannot drift from a separate counter.
ALTER TABLE journal_entries ADD COLUMN courier_id bigint REFERENCES couriers (id);
CREATE INDEX journal_entries_courier ON journal_entries (courier_id);

-- ---------------------------------------------------------------- package fees (Rule 11)
CREATE TABLE package_fees (
  id            bigserial PRIMARY KEY,
  order_id      bigint NOT NULL UNIQUE REFERENCES orders (id),   -- one dispatch, one fee line
  order_ref     text NOT NULL REFERENCES order_refs (ref),
  courier_id    bigint NOT NULL REFERENCES couriers (id),
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  zero_reason   text,
  entry_id      bigint REFERENCES journal_entries (id),
  recorded_by   text NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT zero_fee_needs_reason CHECK (amount_cents > 0 OR (zero_reason IS NOT NULL AND length(trim(zero_reason)) > 0)),
  CONSTRAINT fee_has_entry_iff_positive CHECK ((amount_cents > 0) = (entry_id IS NOT NULL))
);
CREATE INDEX package_fees_courier ON package_fees (courier_id);
CREATE TRIGGER package_fees_immutable BEFORE UPDATE OR DELETE ON package_fees FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER package_fees_no_truncate BEFORE TRUNCATE ON package_fees FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- An order cannot become 'dispatched' unless it has a package fee line by the time the transaction commits.
CREATE FUNCTION orders_dispatch_needs_fee() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM package_fees WHERE order_id = NEW.id) THEN
    RAISE EXCEPTION 'order % cannot be dispatched without a package fee line (a zero fee needs a reason)', NEW.order_ref USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER orders_dispatch_needs_fee AFTER UPDATE OF status ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.status = 'dispatched' AND OLD.status = 'awaiting_dispatch')
  EXECUTE FUNCTION orders_dispatch_needs_fee();

-- ---------------------------------------------------------------- courier costs (kept apart from package fees: Rule 12)
CREATE TABLE courier_costs (
  id              bigserial PRIMARY KEY,
  courier_id      bigint NOT NULL REFERENCES couriers (id),
  order_ref       text REFERENCES order_refs (ref),
  kind            text NOT NULL CHECK (kind IN ('return_trip', 'fuel', 'airtime', 'handling', 'repair', 'other')),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  description     text NOT NULL CHECK (length(trim(description)) > 0),
  receipt_ref     text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  recorded_by     text NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  decided_by      text,
  decided_at      timestamptz,
  decision_reason text,
  entry_id        bigint REFERENCES journal_entries (id),
  CONSTRAINT approved_is_complete CHECK (status <> 'approved' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND entry_id IS NOT NULL)),
  CONSTRAINT rejected_has_reason CHECK (status <> 'rejected' OR (decided_by IS NOT NULL AND decision_reason IS NOT NULL AND length(trim(decision_reason)) > 0)),
  CONSTRAINT pending_is_undecided CHECK (status <> 'pending' OR (decided_by IS NULL AND entry_id IS NULL))
);
CREATE INDEX courier_costs_courier ON courier_costs (courier_id);

-- A cost is entered, then decided once. After that nothing about it changes.
CREATE FUNCTION courier_costs_guard() RETURNS trigger AS $$
DECLARE
  decided text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_reason', 'entry_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'courier costs cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a courier cost that has been decided never changes' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - decided) IS DISTINCT FROM (to_jsonb(OLD) - decided) THEN
    RAISE EXCEPTION 'a courier cost''s amount, courier and description never change; reject it and enter a new one' USING ERRCODE = '55000';
  END IF;
  IF NEW.decided_by IS NOT DISTINCT FROM NEW.recorded_by THEN
    RAISE EXCEPTION 'a courier cost must be approved or rejected by someone other than the person who entered it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER courier_costs_guard BEFORE UPDATE OR DELETE ON courier_costs FOR EACH ROW EXECUTE FUNCTION courier_costs_guard();
CREATE TRIGGER courier_costs_no_truncate BEFORE TRUNCATE ON courier_costs FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- payouts
CREATE TABLE courier_payouts (
  id           bigserial PRIMARY KEY,
  courier_id   bigint NOT NULL REFERENCES couriers (id),
  total_cents  bigint NOT NULL CHECK (total_cents > 0),
  method       text NOT NULL CHECK (method IN ('mpesa', 'bank', 'cash', 'netted_on_remittance')),
  payment_ref  text,
  paid_by      text NOT NULL CHECK (length(trim(paid_by)) > 0),
  paid_at      timestamptz NOT NULL DEFAULT now(),
  entry_id     bigint NOT NULL REFERENCES journal_entries (id),
  CONSTRAINT paid_methods_need_reference CHECK (method IN ('cash', 'netted_on_remittance') OR (payment_ref IS NOT NULL AND length(trim(payment_ref)) > 0))
);
-- Each line is one item and one kind of item, never a blend (Rule 12). An item can be paid once.
CREATE TABLE payout_items (
  id               bigserial PRIMARY KEY,
  payout_id        bigint NOT NULL REFERENCES courier_payouts (id),
  package_fee_id   bigint UNIQUE REFERENCES package_fees (id),
  courier_cost_id  bigint UNIQUE REFERENCES courier_costs (id),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  CONSTRAINT exactly_one_item CHECK ((package_fee_id IS NOT NULL)::int + (courier_cost_id IS NOT NULL)::int = 1)
);
CREATE INDEX payout_items_payout ON payout_items (payout_id);
CREATE TRIGGER courier_payouts_immutable BEFORE UPDATE OR DELETE ON courier_payouts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER courier_payouts_no_truncate BEFORE TRUNCATE ON courier_payouts FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payout_items_immutable BEFORE UPDATE OR DELETE ON payout_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payout_items_no_truncate BEFORE TRUNCATE ON payout_items FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- organization collections and statements (Rule 5)
CREATE TABLE org_collections (
  id            bigserial PRIMARY KEY,
  courier_id    bigint NOT NULL REFERENCES couriers (id),
  order_ref     text NOT NULL REFERENCES order_refs (ref),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  collected_on  date NOT NULL,
  entry_id      bigint NOT NULL REFERENCES journal_entries (id),
  recorded_by   text NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_collections_courier ON org_collections (courier_id, collected_on);
CREATE TRIGGER org_collections_immutable BEFORE UPDATE OR DELETE ON org_collections FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER org_collections_no_truncate BEFORE TRUNCATE ON org_collections FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- One statement = one settlement with an organization: expected (what it collected), charged (its charge, as entered by
-- staff), received (what it remitted), and our own record of the fees it is owed. Both variances are kept.
CREATE TABLE org_statements (
  id                      bigserial PRIMARY KEY,
  courier_id              bigint NOT NULL REFERENCES couriers (id),
  period_start            date NOT NULL,
  period_end              date NOT NULL CHECK (period_end >= period_start),
  collections_cents       bigint NOT NULL CHECK (collections_cents >= 0),  -- expected
  charge_entered_cents    bigint NOT NULL CHECK (charge_entered_cents >= 0), -- charged, per the organization
  fees_cents              bigint NOT NULL CHECK (fees_cents >= 0),           -- charged, per our package fee records
  remitted_cents          bigint NOT NULL CHECK (remitted_cents >= 0),       -- received
  charge_variance_cents   bigint NOT NULL,   -- entered charge minus our fee records
  cash_variance_cents     bigint NOT NULL,   -- expected minus our fee records minus received (left owing if positive)
  remittance_ref          text,
  payout_id               bigint REFERENCES courier_payouts (id),
  entry_id                bigint NOT NULL REFERENCES journal_entries (id),
  created_by              text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE org_statement_lines (
  id             bigserial PRIMARY KEY,
  statement_id   bigint NOT NULL REFERENCES org_statements (id),
  collection_id  bigint NOT NULL UNIQUE REFERENCES org_collections (id)   -- a parcel appears on one statement only
);
CREATE TRIGGER org_statements_immutable BEFORE UPDATE OR DELETE ON org_statements FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER org_statements_no_truncate BEFORE TRUNCATE ON org_statements FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER org_statement_lines_immutable BEFORE UPDATE OR DELETE ON org_statement_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER org_statement_lines_no_truncate BEFORE TRUNCATE ON org_statement_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- custody of shop cash
-- Cash taken at the shop is held by a named staff member until deposited.
CREATE TABLE custody_records (
  id              bigserial PRIMARY KEY,
  holder          text NOT NULL CHECK (length(trim(holder)) > 0),
  order_ref       text NOT NULL REFERENCES order_refs (ref),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  receipt_no      text REFERENCES payment_receipts (receipt_no),
  entry_id        bigint NOT NULL REFERENCES journal_entries (id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'deposited')),
  closed_by       text,
  closed_at       timestamptz,
  close_entry_id  bigint REFERENCES journal_entries (id),
  CONSTRAINT deposited_is_complete CHECK (status <> 'deposited' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND close_entry_id IS NOT NULL))
);
CREATE FUNCTION custody_guard() RETURNS trigger AS $$
DECLARE
  closing text[] := ARRAY['status', 'closed_by', 'closed_at', 'close_entry_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'custody records cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'a deposited custody record never changes' USING ERRCODE = '55000'; END IF;
  IF (to_jsonb(NEW) - closing) IS DISTINCT FROM (to_jsonb(OLD) - closing) THEN
    RAISE EXCEPTION 'who holds the cash, and how much, never changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER custody_guard BEFORE UPDATE OR DELETE ON custody_records FOR EACH ROW EXECUTE FUNCTION custody_guard();
CREATE TRIGGER custody_no_truncate BEFORE TRUNCATE ON custody_records FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
