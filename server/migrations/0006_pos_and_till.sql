-- Phase 6: POS sales, discounts, the till and the audit trail. Checkout, void, refund and close-out all post to the ledger.
--
-- Amounts are integer cents. Percentages are basis points (10000 = 100%). People are identified by the text key used
-- elsewhere (the login system of a later phase replaces it); roles are passed in and checked against the policy tables.

-- ---------------------------------------------------------------- accounts for the shop floor
INSERT INTO accounts (code, name, type) VALUES
  ('MOBILE_MONEY_TILL', 'Mobile money taken at the till', 'asset'),
  ('CARD_CLEARING',     'Card payments awaiting settlement', 'asset'),
  ('SAFE',              'Safe',                              'asset'),
  ('SALES_DISCOUNTS',   'Sales discounts given',             'expense'),
  ('CASH_OVER_SHORT',   'Till over and short',               'expense'),
  ('PETTY_EXPENSES',    'Petty cash paid out',               'expense');

-- ---------------------------------------------------------------- the audit trail
-- Written automatically, in the same transaction as the action it records, so an action and its audit row stand or fall together.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL CHECK (length(trim(actor)) > 0),
  actor_role    text,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  amount_cents  bigint,
  risk          smallint NOT NULL DEFAULT 0 CHECK (risk BETWEEN 0 AND 2),  -- 0 routine, 1 notable, 2 risky
  details       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_actor ON audit_log (actor, at);
CREATE INDEX audit_log_action ON audit_log (action, at);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- discount reason codes and role limits
CREATE TABLE discount_reasons (
  code    text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]*$'),
  label   text NOT NULL CHECK (length(trim(label)) > 0),
  active  boolean NOT NULL DEFAULT true
);
INSERT INTO discount_reasons (code, label) VALUES
  ('price_match', 'Matched a competitor''s price'), ('damaged_item', 'Damaged or display item'), ('loyalty', 'Loyal customer'),
  ('staff_purchase', 'Staff purchase'), ('promotion', 'Running promotion'), ('bulk_purchase', 'Bulk purchase'), ('manager_goodwill', 'Manager goodwill');
CREATE FUNCTION discount_reasons_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'discount reasons cannot be deleted; deactivate them' USING ERRCODE = '55000'; END IF;
  IF NEW.code <> OLD.code OR NEW.label <> OLD.label THEN RAISE EXCEPTION 'a discount reason''s code and label never change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER discount_reasons_guard BEFORE UPDATE OR DELETE ON discount_reasons FOR EACH ROW EXECUTE FUNCTION discount_reasons_guard();

-- Versioned, never edited. free_limit_bp: the most a role may discount, as a share of the sale's value, WITHOUT approval.
-- approve_ceiling_bp: the most a role may APPROVE for someone else (0 = this role cannot approve anything).
CREATE TABLE discount_policies (
  id                  bigserial PRIMARY KEY,
  role                text NOT NULL CHECK (role ~ '^[a-z][a-z_]*$'),
  free_limit_bp       integer NOT NULL CHECK (free_limit_bp BETWEEN 0 AND 10000),
  approve_ceiling_bp  integer NOT NULL CHECK (approve_ceiling_bp BETWEEN 0 AND 10000),
  effective_from      date NOT NULL,
  created_by          text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, effective_from),
  CONSTRAINT cannot_approve_less_than_free CHECK (approve_ceiling_bp = 0 OR approve_ceiling_bp >= free_limit_bp)
);
INSERT INTO discount_policies (role, free_limit_bp, approve_ceiling_bp, effective_from, created_by) VALUES
  ('cashier', 500, 0, '2000-01-01', 'system'), ('manager', 2000, 5000, '2000-01-01', 'system'), ('admin', 10000, 10000, '2000-01-01', 'system');
CREATE TRIGGER discount_policies_immutable BEFORE UPDATE OR DELETE ON discount_policies FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER discount_policies_no_truncate BEFORE TRUNCATE ON discount_policies FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- the till
CREATE TABLE cash_sessions (
  id                  bigserial PRIMARY KEY,
  cashier             text NOT NULL CHECK (length(trim(cashier)) > 0),
  opening_float_cents bigint NOT NULL CHECK (opening_float_cents >= 0),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'signed_off')),
  closed_at           timestamptz,
  variance_reason     text,
  signoff_required    boolean NOT NULL DEFAULT false,
  signed_off_by       text,
  signed_off_at       timestamptz,
  CONSTRAINT closed_is_complete CHECK (status = 'open' OR closed_at IS NOT NULL),
  CONSTRAINT signed_off_is_complete CHECK (status <> 'signed_off' OR (signoff_required AND signed_off_by IS NOT NULL AND signed_off_at IS NOT NULL))
);
-- One open session per cashier.
CREATE UNIQUE INDEX cash_sessions_one_open_per_cashier ON cash_sessions (cashier) WHERE status = 'open';
CREATE FUNCTION cash_sessions_guard() RETURNS trigger AS $$
DECLARE
  closing text[] := ARRAY['status', 'closed_at', 'variance_reason', 'signoff_required'];
  signing text[] := ARRAY['status', 'signed_off_by', 'signed_off_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cash sessions cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF (to_jsonb(NEW) - closing) IS DISTINCT FROM (to_jsonb(OLD) - closing) THEN RAISE EXCEPTION 'closing a session cannot change anything else about it' USING ERRCODE = '55000'; END IF;
  ELSIF OLD.status = 'closed' AND NEW.status = 'signed_off' THEN
    IF (to_jsonb(NEW) - signing) IS DISTINCT FROM (to_jsonb(OLD) - signing) THEN RAISE EXCEPTION 'signing off a session cannot change anything else about it' USING ERRCODE = '55000'; END IF;
  ELSE
    RAISE EXCEPTION 'a cash session that is % cannot be changed to %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_sessions_guard BEFORE UPDATE OR DELETE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION cash_sessions_guard();
CREATE TRIGGER cash_sessions_no_truncate BEFORE TRUNCATE ON cash_sessions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- What was expected and what was counted at close-out, per payment method.
CREATE TABLE cash_session_counts (
  session_id     bigint NOT NULL REFERENCES cash_sessions (id),
  method         text NOT NULL CHECK (method IN ('cash', 'card', 'mobile_money')),
  expected_cents bigint NOT NULL,
  counted_cents  bigint NOT NULL CHECK (counted_cents >= 0),
  variance_cents bigint NOT NULL,
  entry_id       bigint REFERENCES journal_entries (id),   -- the ledger entry that brought the books to the count
  PRIMARY KEY (session_id, method),
  CONSTRAINT variance_is_counted_minus_expected CHECK (variance_cents = counted_cents - expected_cents)
);
CREATE TRIGGER cash_session_counts_immutable BEFORE UPDATE OR DELETE ON cash_session_counts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cash_session_counts_no_truncate BEFORE TRUNCATE ON cash_session_counts FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Paid-outs, drops and top-ups: each needs a reason and a SECOND person's approval.
CREATE TABLE cash_movements (
  id            bigserial PRIMARY KEY,
  session_id    bigint NOT NULL REFERENCES cash_sessions (id),
  kind          text NOT NULL CHECK (kind IN ('paid_out', 'drop', 'top_up')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  requested_by  text NOT NULL CHECK (length(trim(requested_by)) > 0),
  approved_by   text NOT NULL CHECK (length(trim(approved_by)) > 0),
  entry_id      bigint NOT NULL REFERENCES journal_entries (id),
  at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approver_is_someone_else CHECK (approved_by <> requested_by)
);
CREATE INDEX cash_movements_session ON cash_movements (session_id);
CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER cash_movements_no_truncate BEFORE TRUNCATE ON cash_movements FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- sales
CREATE TABLE sale_counters (period text PRIMARY KEY CHECK (period ~ '^[0-9]{4}$'), last_no integer NOT NULL CHECK (last_no > 0));

CREATE TABLE sales (
  id                  bigserial PRIMARY KEY,
  sale_no             text NOT NULL UNIQUE CHECK (sale_no ~ '^S-[0-9]{4}-[0-9]{6}$'),
  session_id          bigint NOT NULL REFERENCES cash_sessions (id),
  cashier             text NOT NULL CHECK (length(trim(cashier)) > 0),
  cashier_role        text NOT NULL,
  status              text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  gross_cents         bigint NOT NULL CHECK (gross_cents > 0),
  line_discount_cents bigint NOT NULL DEFAULT 0 CHECK (line_discount_cents >= 0),
  sale_discount_cents bigint NOT NULL DEFAULT 0 CHECK (sale_discount_cents >= 0),
  total_cents         bigint NOT NULL CHECK (total_cents > 0),
  discount_reason     text REFERENCES discount_reasons (code),
  client_sale_id      text UNIQUE,         -- makes a retried or offline-queued sale safe to send twice
  entry_id            bigint NOT NULL REFERENCES journal_entries (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  voided_by           text,
  voided_at           timestamptz,
  void_reason         text,
  void_entry_id       bigint REFERENCES journal_entries (id),
  -- Server-side discount caps (Phase 0, now in the database): a discount can never exceed the sale, and needs a reason.
  CONSTRAINT discounts_within_gross CHECK (line_discount_cents + sale_discount_cents < gross_cents),
  CONSTRAINT total_is_gross_minus_discounts CHECK (total_cents = gross_cents - line_discount_cents - sale_discount_cents),
  CONSTRAINT discount_needs_reason CHECK (line_discount_cents + sale_discount_cents = 0 OR discount_reason IS NOT NULL),
  CONSTRAINT void_is_complete CHECK (status <> 'voided' OR (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL AND void_entry_id IS NOT NULL))
);
CREATE INDEX sales_session ON sales (session_id);
CREATE INDEX sales_cashier ON sales (cashier, created_at);
CREATE FUNCTION sales_guard() RETURNS trigger AS $$
DECLARE voiding text[] := ARRAY['status', 'voided_by', 'voided_at', 'void_reason', 'void_entry_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sales cannot be deleted; void them' USING ERRCODE = '55000'; END IF;
  IF OLD.status <> 'completed' OR NEW.status <> 'voided' OR (to_jsonb(NEW) - voiding) IS DISTINCT FROM (to_jsonb(OLD) - voiding) THEN
    RAISE EXCEPTION 'a sale never changes, except to be voided once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER sales_guard BEFORE UPDATE OR DELETE ON sales FOR EACH ROW EXECUTE FUNCTION sales_guard();
CREATE TRIGGER sales_no_truncate BEFORE TRUNCATE ON sales FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE sale_items (
  id               bigserial PRIMARY KEY,
  sale_id          bigint NOT NULL REFERENCES sales (id),
  sku              text,
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  discount_cents   bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  line_total_cents bigint NOT NULL,
  CONSTRAINT line_discount_within_line CHECK (discount_cents <= unit_price_cents * quantity),
  CONSTRAINT line_total_correct CHECK (line_total_cents = unit_price_cents * quantity - discount_cents)
);
CREATE INDEX sale_items_sale ON sale_items (sale_id);
CREATE TRIGGER sale_items_immutable BEFORE UPDATE OR DELETE ON sale_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER sale_items_no_truncate BEFORE TRUNCATE ON sale_items FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE sale_payments (
  id           bigserial PRIMARY KEY,
  sale_id      bigint NOT NULL REFERENCES sales (id),
  method       text NOT NULL CHECK (method IN ('cash', 'card', 'mobile_money')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reference    text,
  UNIQUE (sale_id, method)
);
CREATE TRIGGER sale_payments_immutable BEFORE UPDATE OR DELETE ON sale_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER sale_payments_no_truncate BEFORE TRUNCATE ON sale_payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- The payments must add up to the sale's total, checked at commit (the same technique as the ledger's balance rule).
CREATE FUNCTION sale_payments_add_up() RETURNS trigger AS $$
DECLARE sid bigint; paid bigint; due bigint;
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN sid := NEW.id; ELSE sid := NEW.sale_id; END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO paid FROM sale_payments WHERE sale_id = sid;
  SELECT total_cents INTO due FROM sales WHERE id = sid;
  IF paid <> due THEN RAISE EXCEPTION 'sale % is for % cents but its payments add up to % cents', sid, due, paid USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER sale_payments_match_total AFTER INSERT ON sales DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sale_payments_add_up();
CREATE CONSTRAINT TRIGGER sale_payments_match_total_p AFTER INSERT ON sale_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sale_payments_add_up();

-- A discount above the cashier's own limit is only allowed with a manager's approval, recorded here.
CREATE TABLE discount_approvals (
  id             bigserial PRIMARY KEY,
  sale_id        bigint NOT NULL UNIQUE REFERENCES sales (id),
  approver       text NOT NULL CHECK (length(trim(approver)) > 0),
  approver_role  text NOT NULL,
  discount_bp    integer NOT NULL CHECK (discount_bp > 0),
  reason_code    text NOT NULL REFERENCES discount_reasons (code),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER discount_approvals_immutable BEFORE UPDATE OR DELETE ON discount_approvals FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER discount_approvals_no_truncate BEFORE TRUNCATE ON discount_approvals FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- refunds
CREATE TABLE sale_refunds (
  id             bigserial PRIMARY KEY,
  sale_id        bigint NOT NULL REFERENCES sales (id),
  session_id     bigint NOT NULL REFERENCES cash_sessions (id),   -- the session the money went back out of
  method         text NOT NULL CHECK (method IN ('cash', 'card', 'mobile_money')),
  gross_cents    bigint NOT NULL CHECK (gross_cents > 0),
  discount_cents bigint NOT NULL CHECK (discount_cents >= 0),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),        -- paid back to the customer
  reason         text NOT NULL CHECK (length(trim(reason)) > 0),
  requested_by   text NOT NULL CHECK (length(trim(requested_by)) > 0),
  approved_by    text NOT NULL CHECK (length(trim(approved_by)) > 0),
  entry_id       bigint NOT NULL REFERENCES journal_entries (id),
  at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_is_gross_minus_discount CHECK (amount_cents = gross_cents - discount_cents),
  CONSTRAINT refund_approver_is_someone_else CHECK (approved_by <> requested_by)
);
CREATE INDEX sale_refunds_sale ON sale_refunds (sale_id);
CREATE TABLE sale_refund_items (
  id           bigserial PRIMARY KEY,
  refund_id    bigint NOT NULL REFERENCES sale_refunds (id),
  sale_item_id bigint NOT NULL REFERENCES sale_items (id),
  quantity     integer NOT NULL CHECK (quantity > 0)
);
CREATE INDEX sale_refund_items_item ON sale_refund_items (sale_item_id);
-- Nothing can be refunded more times than it was sold.
CREATE FUNCTION sale_refund_items_within_sold() RETURNS trigger AS $$
DECLARE sold integer; already integer;
BEGIN
  SELECT quantity INTO sold FROM sale_items WHERE id = NEW.sale_item_id;
  SELECT COALESCE(sum(quantity), 0) INTO already FROM sale_refund_items WHERE sale_item_id = NEW.sale_item_id;
  IF already + NEW.quantity > sold THEN
    RAISE EXCEPTION 'cannot refund % of sale item % (% sold, % already refunded)', NEW.quantity, NEW.sale_item_id, sold, already USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER sale_refund_items_within_sold BEFORE INSERT ON sale_refund_items FOR EACH ROW EXECUTE FUNCTION sale_refund_items_within_sold();
CREATE TRIGGER sale_refunds_immutable BEFORE UPDATE OR DELETE ON sale_refunds FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER sale_refunds_no_truncate BEFORE TRUNCATE ON sale_refunds FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER sale_refund_items_immutable BEFORE UPDATE OR DELETE ON sale_refund_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER sale_refund_items_no_truncate BEFORE TRUNCATE ON sale_refund_items FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
