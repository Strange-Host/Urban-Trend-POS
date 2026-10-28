-- Phase D step 1: adding items to an order that has not left the shop yet (the legacy "merge items" / duplicate-phone merge).
--
-- An order's amounts used to be frozen the moment it was created. A merge needs the total to grow, so the guard now allows exactly one
-- kind of amount change: while the order is awaiting dispatch (before and after), the subtotal and total may go UP by the same amount
-- (discount untouched). Anything else about the amounts is still refused, a decrease included, and every other field is still frozen.
-- The money side is unchanged: each merge posts its own receivable/sales entry, and the nightly check proves the lines add up to the subtotal.

CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger AS $$
DECLARE
  movable text[] := ARRAY['status', 'updated_at', 'dispatched_at', 'delivered_at', 'assigned_to'];
  growable text[] := ARRAY['subtotal_cents', 'total_cents'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orders cannot be deleted; cancel them instead' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - movable - growable) IS DISTINCT FROM (to_jsonb(OLD) - movable - growable) THEN
    RAISE EXCEPTION 'an order''s reference, customer, amounts and notes never change; only its status and assignment do' USING ERRCODE = '55000';
  END IF;
  IF NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents OR NEW.total_cents IS DISTINCT FROM OLD.total_cents THEN
    IF NOT (OLD.status = 'awaiting_dispatch' AND NEW.status = 'awaiting_dispatch'
            AND NEW.subtotal_cents > OLD.subtotal_cents
            AND NEW.total_cents - OLD.total_cents = NEW.subtotal_cents - OLD.subtotal_cents) THEN
      RAISE EXCEPTION 'an order''s reference, customer, amounts and notes never change; only its status and assignment do (items can be added, and only while it awaits dispatch)' USING ERRCODE = '55000';
    END IF;
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
