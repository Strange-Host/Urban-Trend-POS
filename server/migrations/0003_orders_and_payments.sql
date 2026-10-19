-- Phase 3: orders, the order event log, delivery attempts, paybill payments, suspense handling.
--
-- Rules enforced here: 2 (an order's paid amount is never a stored counter; it comes from the ledger and receipts),
-- 6 (a paybill transaction code is recorded once; payments never exceed what is owed), 3 (money without an order
-- reference sits in suspense). Amounts are integer cents.

-- ---------------------------------------------------------------- orders
CREATE TABLE orders (
  id               bigserial PRIMARY KEY,
  order_ref        text NOT NULL UNIQUE REFERENCES order_refs (ref),
  status           text NOT NULL DEFAULT 'awaiting_dispatch'
                   CHECK (status IN ('awaiting_dispatch', 'dispatched', 'delivered', 'returning', 'cancelled')),
  customer_name    text NOT NULL CHECK (length(trim(customer_name)) > 0),
  customer_phone   text NOT NULL CHECK (length(trim(customer_phone)) > 0),
  phone_normalized text NOT NULL CHECK (phone_normalized ~ '^[0-9]{7,9}$'),
  subtotal_cents   bigint NOT NULL CHECK (subtotal_cents > 0),
  discount_cents   bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents      bigint NOT NULL CHECK (total_cents > 0),
  notes            text,
  assigned_to      text,
  created_by       text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz,
  delivered_at     timestamptz,
  -- Discount cap (Phase 0 carried into the new system): a discount can never exceed the sale value.
  CONSTRAINT discount_within_subtotal CHECK (discount_cents <= subtotal_cents),
  CONSTRAINT total_is_subtotal_minus_discount CHECK (total_cents = subtotal_cents - discount_cents)
);
CREATE INDEX orders_status ON orders (status);
CREATE INDEX orders_phone ON orders (phone_normalized);
-- One ACTIVE order per phone number, enforced by the database so two staff creating at once cannot both succeed.
CREATE UNIQUE INDEX orders_one_active_per_phone ON orders (phone_normalized) WHERE status IN ('awaiting_dispatch', 'dispatched');

CREATE TABLE order_items (
  id                bigserial PRIMARY KEY,
  order_id          bigint NOT NULL REFERENCES orders (id),
  sku               text,
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  quantity          integer NOT NULL CHECK (quantity > 0),
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents >= 0),
  discount_cents    bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  line_total_cents  bigint NOT NULL,
  CONSTRAINT line_discount_within_line CHECK (discount_cents <= unit_price_cents * quantity),
  CONSTRAINT line_total_correct CHECK (line_total_cents = unit_price_cents * quantity - discount_cents)
);
CREATE INDEX order_items_order ON order_items (order_id);

-- Only status, assignment and timestamps of an order may change, and status only along the legal paths.
CREATE FUNCTION orders_guard() RETURNS trigger AS $$
DECLARE
  movable text[] := ARRAY['status', 'updated_at', 'dispatched_at', 'delivered_at', 'assigned_to'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders cannot be deleted; cancel them instead' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - movable) IS DISTINCT FROM (to_jsonb(OLD) - movable) THEN
    RAISE EXCEPTION 'an order''s reference, customer, amounts and notes never change; only its status and assignment do' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'awaiting_dispatch' AND NEW.status IN ('dispatched', 'cancelled'))
    OR (OLD.status = 'dispatched'        AND NEW.status IN ('delivered', 'returning'))
  ) THEN
    RAISE EXCEPTION 'an order cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER orders_guard BEFORE UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION orders_guard();
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON orders FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_items_immutable BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_items_no_truncate BEFORE TRUNCATE ON order_items FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- append-only order event log
CREATE TABLE order_events (
  id         bigserial PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES orders (id),
  order_ref  text NOT NULL REFERENCES order_refs (ref),
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  actor      text NOT NULL CHECK (length(trim(actor)) > 0),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order ON order_events (order_id, id);
CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_events_no_truncate BEFORE TRUNCATE ON order_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- delivery attempts (every attempt is kept)
CREATE TABLE delivery_attempts (
  id              bigserial PRIMARY KEY,
  order_id        bigint NOT NULL REFERENCES orders (id),
  order_ref       text NOT NULL REFERENCES order_refs (ref),
  attempt_no      integer NOT NULL CHECK (attempt_no > 0),
  outcome         text NOT NULL CHECK (outcome IN ('delivered', 'not_claimed', 'refused', 'rescheduled')),
  reason          text,
  reschedule_for  date,
  courier_label   text,
  recorded_by     text NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, attempt_no),
  CONSTRAINT reason_unless_delivered CHECK (outcome = 'delivered' OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
  CONSTRAINT reschedule_date_iff_rescheduled CHECK ((outcome = 'rescheduled') = (reschedule_for IS NOT NULL))
);
CREATE TRIGGER delivery_attempts_immutable BEFORE UPDATE OR DELETE ON delivery_attempts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER delivery_attempts_no_truncate BEFORE TRUNCATE ON delivery_attempts FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- paybill payments
-- One row per M-Pesa notice, exactly as received and as matched. trans_code UNIQUE is Rule 6's "recorded once".
CREATE TABLE paybill_payments (
  id            bigserial PRIMARY KEY,
  trans_code    text NOT NULL UNIQUE CHECK (trans_code ~ '^[A-Z0-9]{6,20}$'),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  msisdn        text,
  payer_name    text,
  account_raw   text,
  received_at   timestamptz NOT NULL,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  outcome       text NOT NULL CHECK (outcome IN ('applied', 'part_paid', 'excess', 'suspense')),
  order_ref     text REFERENCES order_refs (ref),
  applied_cents bigint NOT NULL CHECK (applied_cents >= 0),
  entry_id      bigint NOT NULL REFERENCES journal_entries (id),
  receipt_no    text REFERENCES payment_receipts (receipt_no),
  CONSTRAINT applied_within_amount CHECK (applied_cents <= amount_cents)
);
CREATE INDEX paybill_payments_order ON paybill_payments (order_ref);
CREATE TRIGGER paybill_payments_immutable BEFORE UPDATE OR DELETE ON paybill_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER paybill_payments_no_truncate BEFORE TRUNCATE ON paybill_payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Money sitting in suspense: an unmatched payment, or the excess of an overpayment. It stays open until fully
-- applied to an order or refunded; the resolutions below are what close it.
CREATE TABLE payment_exceptions (
  id            bigserial PRIMARY KEY,
  payment_id    bigint NOT NULL UNIQUE REFERENCES paybill_payments (id),
  kind          text NOT NULL CHECK (kind IN ('unmatched', 'excess')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payment_exceptions_immutable BEFORE UPDATE OR DELETE ON payment_exceptions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payment_exceptions_no_truncate BEFORE TRUNCATE ON payment_exceptions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE exception_resolutions (
  id            bigserial PRIMARY KEY,
  exception_id  bigint NOT NULL REFERENCES payment_exceptions (id),
  kind          text NOT NULL CHECK (kind IN ('applied', 'refunded')),
  order_ref     text REFERENCES order_refs (ref),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  entry_id      bigint NOT NULL REFERENCES journal_entries (id),
  receipt_no    text REFERENCES payment_receipts (receipt_no),
  reason        text,
  actor         text NOT NULL CHECK (length(trim(actor)) > 0),
  at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applied_needs_order CHECK (kind <> 'applied' OR order_ref IS NOT NULL),
  CONSTRAINT refund_needs_reason CHECK (kind <> 'refunded' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);
CREATE INDEX exception_resolutions_exception ON exception_resolutions (exception_id);
CREATE TRIGGER exception_resolutions_immutable BEFORE UPDATE OR DELETE ON exception_resolutions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER exception_resolutions_no_truncate BEFORE TRUNCATE ON exception_resolutions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
