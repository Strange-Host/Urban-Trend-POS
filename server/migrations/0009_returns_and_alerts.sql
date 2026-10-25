-- Step 3: returned parcels, and alerts for a manager.

-- ---------------------------------------------------------------- returned orders
-- An order whose delivery failed sits in "returning" until the parcel is physically back. Receiving it moves it to "returned".
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('awaiting_dispatch', 'dispatched', 'delivered', 'returning', 'returned', 'cancelled'));

CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger AS $$
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
    OR (OLD.status = 'returning'         AND NEW.status = 'returned')
  ) THEN
    RAISE EXCEPTION 'an order cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- What came back, per line: how many went back on the shelf, how many were damaged. The rest never came back (lost in transit).
CREATE TABLE order_returns (
  id                    bigserial PRIMARY KEY,
  order_id              bigint NOT NULL UNIQUE REFERENCES orders (id),
  order_ref             text NOT NULL REFERENCES order_refs (ref),
  received_by           text NOT NULL CHECK (length(trim(received_by)) > 0),
  received_at           timestamptz NOT NULL DEFAULT now(),
  notes                 text,
  unpaid_written_off_cents bigint NOT NULL DEFAULT 0 CHECK (unpaid_written_off_cents >= 0),
  entry_id              bigint REFERENCES journal_entries (id),
  CONSTRAINT writeoff_has_entry CHECK (unpaid_written_off_cents = 0 OR entry_id IS NOT NULL)
);
CREATE TABLE order_return_items (
  id               bigserial PRIMARY KEY,
  return_id        bigint NOT NULL REFERENCES order_returns (id),
  order_item_id    bigint NOT NULL REFERENCES order_items (id),
  restocked        integer NOT NULL DEFAULT 0 CHECK (restocked >= 0),
  damaged          integer NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  missing          integer NOT NULL DEFAULT 0 CHECK (missing >= 0),
  UNIQUE (return_id, order_item_id)
);
CREATE TRIGGER order_returns_immutable BEFORE UPDATE OR DELETE ON order_returns FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_returns_no_truncate BEFORE TRUNCATE ON order_returns FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_return_items_immutable BEFORE UPDATE OR DELETE ON order_return_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_return_items_no_truncate BEFORE TRUNCATE ON order_return_items FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- alerts for a manager
-- Something a manager must look at (today: the nightly integrity check failing). Stays open until someone acknowledges it.
CREATE TABLE alerts (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL,
  severity         text NOT NULL DEFAULT 'high' CHECK (severity IN ('info', 'high')),
  title            text NOT NULL CHECK (length(trim(title)) > 0),
  body             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  note             text,
  CONSTRAINT ack_is_complete CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL))
);
CREATE INDEX alerts_open ON alerts (created_at) WHERE acknowledged_at IS NULL;
-- At most one open alert of each kind, so a problem that persists does not raise a new alert every night.
CREATE UNIQUE INDEX alerts_one_open_per_kind ON alerts (kind) WHERE acknowledged_at IS NULL;
CREATE FUNCTION alerts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'alerts cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD.acknowledged_at IS NOT NULL OR (to_jsonb(NEW) - ARRAY['acknowledged_by', 'acknowledged_at', 'note']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['acknowledged_by', 'acknowledged_at', 'note']) THEN
    RAISE EXCEPTION 'an alert can only be acknowledged, once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER alerts_guard BEFORE UPDATE OR DELETE ON alerts FOR EACH ROW EXECUTE FUNCTION alerts_guard();
