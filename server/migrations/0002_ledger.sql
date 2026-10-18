-- Phase 2: the double-entry ledger, order references, receipts, idempotency keys and integrity-run history.
--
-- Money rules enforced HERE, in the database, so no code path (including a future bug or a hand-run
-- script) can break them quietly:
--   Rule 1   every journal entry's lines sum to zero (deferred constraint trigger, checked at commit)
--   Rule 7   ledger, receipt and reference rows are immutable: UPDATE, DELETE and TRUNCATE are refused;
--            a correction is a new reversing entry carrying a reason and an actor
--   Rule 10  an order reference is unique, immutable and never reused (primary key + immutability)
-- Amounts are integer cents. Debits are positive, credits negative.

CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % refused: these records are immutable (correct with a reversing entry, never an edit)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- accounts
CREATE TABLE accounts (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A starter chart built from the money paths in the plan. Accounts can be added later; a code or type never changes.
INSERT INTO accounts (code, name, type) VALUES
  ('CUSTOMER_RECEIVABLE',  'Customer receivable',             'asset'),
  ('PAYBILL_CLEARING',     'Paybill clearing',                'asset'),
  ('ORG_RECEIVABLE',       'Receivable from organizations',   'asset'),
  ('STAFF_CASH_IN_HAND',   'Staff cash in hand',              'asset'),
  ('TILL',                 'Till',                            'asset'),
  ('BANK',                 'Bank',                            'asset'),
  ('SUSPENSE',             'Suspense (unmatched money)',      'liability'),
  ('COURIER_PAYABLE',      'Courier payable',                 'liability'),
  ('COURIER_PACKAGE_FEES', 'Courier package fees',            'expense'),
  ('COURIER_COSTS',        'Courier costs',                   'expense'),
  ('SALES',                'Sales',                           'income');

CREATE FUNCTION accounts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounts cannot be deleted; deactivate instead' USING ERRCODE = '55000';
  END IF;
  IF NEW.code <> OLD.code OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'an account''s code and type never change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounts_guard BEFORE UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_guard();

-- ---------------------------------------------------------------- order references (Rule 10)
-- A reference is allocated once, tied to an order in phase 3, and never edited, deleted or reused, even for a
-- cancelled order. Existing codes such as UT000123 live on as permanent aliases in legacy_ref.
CREATE SEQUENCE order_ref_seq MINVALUE 1 MAXVALUE 34359738367 NO CYCLE; -- 2^35 - 1: the 7-character space

CREATE TABLE order_refs (
  ref           text PRIMARY KEY CHECK (ref ~ '^UT-[2-9A-HJ-NP-Z]{8}$'),
  legacy_ref    text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^UT[0-9]{6,}$'),
  allocated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER order_refs_immutable BEFORE UPDATE OR DELETE ON order_refs FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER order_refs_no_truncate BEFORE TRUNCATE ON order_refs FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- journal (Rules 1 and 7)
CREATE TABLE journal_entries (
  id                 bigserial PRIMARY KEY,
  posted_at          timestamptz NOT NULL DEFAULT now(),
  description        text NOT NULL CHECK (length(trim(description)) > 0),
  order_ref          text REFERENCES order_refs (ref),
  actor              text NOT NULL CHECK (length(trim(actor)) > 0),
  reverses_entry_id  bigint UNIQUE REFERENCES journal_entries (id), -- UNIQUE: an entry can be reversed only once
  reason             text,
  idempotency_key    text UNIQUE,
  idempotency_hash   text,
  created_tx         xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT reversal_needs_reason CHECK (reverses_entry_id IS NULL OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
  CONSTRAINT idempotency_pair CHECK ((idempotency_key IS NULL) = (idempotency_hash IS NULL))
);
CREATE INDEX journal_entries_order_ref ON journal_entries (order_ref);

CREATE TABLE journal_lines (
  id            bigserial PRIMARY KEY,
  entry_id      bigint NOT NULL REFERENCES journal_entries (id),
  account_id    bigint NOT NULL REFERENCES accounts (id),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0)
);
CREATE INDEX journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX journal_lines_account ON journal_lines (account_id);

-- Rule 1. Deferred so an entry's lines can be inserted one at a time; checked when the transaction commits
-- (or earlier, when the service runs SET CONSTRAINTS ... IMMEDIATE). Fires from both tables so an entry
-- with NO lines is caught too.
CREATE FUNCTION journal_check_balanced() RETURNS trigger AS $$
DECLARE
  eid bigint;
  total bigint;
  n integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT COALESCE(sum(amount_cents), 0), count(*) INTO total, n FROM journal_lines WHERE entry_id = eid;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % needs at least two lines (has %)', eid, n USING ERRCODE = '23514';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'journal entry % does not balance: its lines sum to % cents, not 0', eid, total USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_check_balanced();

-- Lines may only be added in the same transaction that created their entry; a posted entry is never extended.
CREATE FUNCTION journal_lines_same_tx() RETURNS trigger AS $$
BEGIN
  IF (SELECT created_tx FROM journal_entries WHERE id = NEW.entry_id) IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'cannot add lines to journal entry %: it is already posted', NEW.entry_id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER journal_lines_same_tx BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_same_tx();

-- Rule 7.
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- receipts
-- RC-YYMM-NNNNNN: numbered per month, gapless (the counter row is locked and rolls back with the receipt).
CREATE TABLE receipt_counters (
  period   text PRIMARY KEY CHECK (period ~ '^[0-9]{4}$'),
  last_no  integer NOT NULL CHECK (last_no > 0)
);

CREATE TABLE payment_receipts (
  id                bigserial PRIMARY KEY,
  receipt_no        text NOT NULL UNIQUE CHECK (receipt_no ~ '^RC-[0-9]{4}-[0-9]{6}$'),
  order_ref         text NOT NULL REFERENCES order_refs (ref),
  journal_entry_id  bigint NOT NULL UNIQUE REFERENCES journal_entries (id),
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  method            text NOT NULL CHECK (method IN ('mpesa_paybill', 'organization_remittance', 'cash', 'bank')),
  external_ref      text,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  actor             text NOT NULL CHECK (length(trim(actor)) > 0)
);
CREATE INDEX payment_receipts_order_ref ON payment_receipts (order_ref);

-- A receipt must point at a ledger entry for the same order reference.
CREATE FUNCTION receipts_match_entry() RETURNS trigger AS $$
DECLARE entry_ref text;
BEGIN
  SELECT order_ref INTO entry_ref FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF entry_ref IS DISTINCT FROM NEW.order_ref THEN
    RAISE EXCEPTION 'receipt order reference % does not match ledger entry % (%)', NEW.order_ref, NEW.journal_entry_id, COALESCE(entry_ref, 'none')
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER receipts_match_entry BEFORE INSERT ON payment_receipts FOR EACH ROW EXECUTE FUNCTION receipts_match_entry();
CREATE TRIGGER payment_receipts_immutable BEFORE UPDATE OR DELETE ON payment_receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payment_receipts_no_truncate BEFORE TRUNCATE ON payment_receipts FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- idempotency keys
-- A retried request (a double tap, a re-sent webhook) returns the first result instead of running twice.
CREATE TABLE idempotency_keys (
  scope         text NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  response      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- ---------------------------------------------------------------- small facts and integrity history
CREATE TABLE app_meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

CREATE TABLE integrity_runs (
  id          bigserial PRIMARY KEY,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  violations  jsonb NOT NULL DEFAULT '[]',
  counts      jsonb NOT NULL DEFAULT '{}'
);
