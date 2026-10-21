-- Phase 5: pay profiles, commission plans, attendance, adjustments, payroll runs and their locking.
--
-- Rules enforced here: 8 (commission only on secure money; see src/payroll/commission.ts) and 9 (a locked payroll run
-- never changes). Amounts are integer cents. Staff are identified by the same key used elsewhere (orders.assigned_to,
-- actor names) until the user accounts of a later phase replace it.

-- ---------------------------------------------------------------- how much of an organization's collection is secure
-- A collection is secure only once the organization has remitted. A statement settles (remitted + fees netted) against its
-- parcels oldest-first, the same order ageing uses, so each line records how much of it is actually secured.
ALTER TABLE org_statement_lines ADD COLUMN secured_cents bigint NOT NULL DEFAULT 0 CHECK (secured_cents >= 0);

ALTER TABLE org_statement_lines DISABLE TRIGGER org_statement_lines_immutable;  -- one-time backfill of rows made before this column existed
WITH ranked AS (
  SELECT l.id, k.amount_cents AS amt, (s.remitted_cents + s.fees_cents) AS settled,
         COALESCE(sum(k.amount_cents) OVER (PARTITION BY l.statement_id ORDER BY k.collected_on, k.id
                                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM org_statement_lines l
    JOIN org_collections k ON k.id = l.collection_id
    JOIN org_statements s ON s.id = l.statement_id
)
UPDATE org_statement_lines l SET secured_cents = GREATEST(0, LEAST(r.amt, r.settled - r.before)) FROM ranked r WHERE r.id = l.id;
ALTER TABLE org_statement_lines ENABLE TRIGGER org_statement_lines_immutable;

-- ---------------------------------------------------------------- commission plans (versioned: a change is a new row)
CREATE TABLE commission_plans (
  id                  bigserial PRIMARY KEY,
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  target_cents        bigint NOT NULL CHECK (target_cents > 0),     -- sales target per payroll period
  rate_below_70_cents bigint NOT NULL CHECK (rate_below_70_cents >= 0), -- paid PER UNIT sold, by how much of the target was achieved
  rate_70_cents       bigint NOT NULL CHECK (rate_70_cents >= 0),
  rate_80_cents       bigint NOT NULL CHECK (rate_80_cents >= 0),
  created_by          text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER commission_plans_immutable BEFORE UPDATE OR DELETE ON commission_plans FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER commission_plans_no_truncate BEFORE TRUNCATE ON commission_plans FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- pay profiles (versioned by effective date)
CREATE TABLE pay_profiles (
  id                      bigserial PRIMARY KEY,
  staff_key               text NOT NULL CHECK (length(trim(staff_key)) > 0),
  effective_from          date NOT NULL,
  daily_retainer_cents    bigint NOT NULL CHECK (daily_retainer_cents >= 0),
  commission_plan_id      bigint REFERENCES commission_plans (id),   -- null: this person earns no commission
  workday_start_minute    integer NOT NULL DEFAULT 480 CHECK (workday_start_minute BETWEEN 0 AND 1439), -- 480 = 08:00 shop time
  expected_minutes        integer NOT NULL DEFAULT 480 CHECK (expected_minutes > 0),
  late_fee_per_hour_cents bigint NOT NULL DEFAULT 0 CHECK (late_fee_per_hour_cents >= 0),
  absence_fee_cents       bigint NOT NULL DEFAULT 0 CHECK (absence_fee_cents >= 0),
  missing_hour_fee_cents  bigint NOT NULL DEFAULT 0 CHECK (missing_hour_fee_cents >= 0),
  created_by              text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_key, effective_from)
);
CREATE TRIGGER pay_profiles_immutable BEFORE UPDATE OR DELETE ON pay_profiles FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pay_profiles_no_truncate BEFORE TRUNCATE ON pay_profiles FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- attendance
-- One row per person per shop day: either a clock-in (with an optional clock-out) or an explicit absence with a reason.
CREATE TABLE attendance_records (
  id              bigserial PRIMARY KEY,
  staff_key       text NOT NULL CHECK (length(trim(staff_key)) > 0),
  work_date       date NOT NULL,
  clock_in_at     timestamptz,
  clock_out_at    timestamptz,
  absence_reason  text,
  recorded_by     text NOT NULL CHECK (length(trim(recorded_by)) > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_key, work_date),
  CONSTRAINT clocked_in_or_absent CHECK ((clock_in_at IS NOT NULL) <> (absence_reason IS NOT NULL AND length(trim(absence_reason)) > 0)),
  CONSTRAINT clock_out_needs_clock_in CHECK (clock_out_at IS NULL OR (clock_in_at IS NOT NULL AND clock_out_at > clock_in_at))
);
-- A clock-out can be set once; nothing else about a day ever changes.
CREATE FUNCTION attendance_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'attendance records cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF (to_jsonb(NEW) - 'clock_out_at') IS DISTINCT FROM (to_jsonb(OLD) - 'clock_out_at') OR OLD.clock_out_at IS NOT NULL THEN
    RAISE EXCEPTION 'attendance never changes once recorded (a clock-out can be added once)' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_guard BEFORE UPDATE OR DELETE ON attendance_records FOR EACH ROW EXECUTE FUNCTION attendance_guard();
CREATE TRIGGER attendance_no_truncate BEFORE TRUNCATE ON attendance_records FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- adjustments: advances, loss deductions, bonuses
CREATE TABLE payroll_adjustments (
  id              bigserial PRIMARY KEY,
  staff_key       text NOT NULL CHECK (length(trim(staff_key)) > 0),
  type            text NOT NULL CHECK (type IN ('salary_advance', 'loss_deduction', 'bonus')),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),   -- always positive; the type says whether it is taken off or added
  effective_date  date NOT NULL,
  reason          text NOT NULL CHECK (length(trim(reason)) > 0),
  created_by      text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_adjustments_staff ON payroll_adjustments (staff_key, effective_date);
CREATE TRIGGER payroll_adjustments_immutable BEFORE UPDATE OR DELETE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payroll_adjustments_no_truncate BEFORE TRUNCATE ON payroll_adjustments FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- payroll runs (Rule 9)
-- draft: can be regenerated.  approved: locked, numbers frozen, awaiting payment.  paid: locked and paid.
CREATE TABLE payroll_runs (
  id             bigserial PRIMARY KEY,
  period_start   date NOT NULL,
  period_end     date NOT NULL CHECK (period_end >= period_start),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
  created_by     text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    text,
  approved_at    timestamptz,
  checksum       text,                       -- fingerprint of every figure in the run at approval; re-verified nightly
  paid_by        text,
  paid_at        timestamptz,
  payment_method text CHECK (payment_method IS NULL OR payment_method IN ('mpesa', 'bank', 'cash')),
  payment_ref    text,
  CONSTRAINT approved_is_complete CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND checksum IS NOT NULL)),
  CONSTRAINT paid_is_complete CHECK (status <> 'paid' OR (paid_by IS NOT NULL AND paid_at IS NOT NULL AND payment_method IS NOT NULL)),
  CONSTRAINT draft_has_no_approval CHECK (status <> 'draft' OR (approved_by IS NULL AND checksum IS NULL AND paid_by IS NULL))
);
CREATE UNIQUE INDEX payroll_one_draft_per_period ON payroll_runs (period_start, period_end) WHERE status = 'draft';
-- Two locked runs can never cover the same day, so nobody is paid twice for it.
ALTER TABLE payroll_runs ADD CONSTRAINT payroll_locked_periods_dont_overlap
  EXCLUDE USING gist (daterange(period_start, period_end, '[]') WITH &&) WHERE (status <> 'draft');

CREATE FUNCTION payroll_runs_guard() RETURNS trigger AS $$
DECLARE
  approving text[] := ARRAY['status', 'approved_by', 'approved_at', 'checksum'];
  paying    text[] := ARRAY['status', 'paid_by', 'paid_at', 'payment_method', 'payment_ref'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a locked payroll run (%) can never be deleted', OLD.status USING ERRCODE = '55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    IF (to_jsonb(NEW) - approving) IS DISTINCT FROM (to_jsonb(OLD) - approving) THEN
      RAISE EXCEPTION 'approving a payroll run cannot change anything else about it' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'paid' THEN
    IF (to_jsonb(NEW) - paying) IS DISTINCT FROM (to_jsonb(OLD) - paying) THEN
      RAISE EXCEPTION 'paying a payroll run cannot change anything else about it' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'a payroll run that is % cannot be changed to %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION payroll_runs_guard();
CREATE TRIGGER payroll_runs_no_truncate BEFORE TRUNCATE ON payroll_runs FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE TABLE payroll_items (
  id                       bigserial PRIMARY KEY,
  run_id                   bigint NOT NULL REFERENCES payroll_runs (id),
  staff_key                text NOT NULL,
  days_worked              integer NOT NULL CHECK (days_worked >= 0),
  retainer_cents           bigint NOT NULL CHECK (retainer_cents >= 0),
  units_sold               integer NOT NULL CHECK (units_sold >= 0),
  achieved_sales_cents     bigint NOT NULL CHECK (achieved_sales_cents >= 0),
  target_cents             bigint NOT NULL CHECK (target_cents >= 0),
  achievement_bp           integer NOT NULL CHECK (achievement_bp >= 0),   -- achievement in basis points (10000 = 100%): no floating point
  tier                     text CHECK (tier IS NULL OR tier IN ('<70%', '70-80%', '>=80%')),
  rate_cents               bigint NOT NULL CHECK (rate_cents >= 0),
  commission_cents         bigint NOT NULL CHECK (commission_cents >= 0),
  bonuses_cents            bigint NOT NULL CHECK (bonuses_cents >= 0),
  late_cents               bigint NOT NULL CHECK (late_cents >= 0),
  absence_cents            bigint NOT NULL CHECK (absence_cents >= 0),
  missing_hours_cents      bigint NOT NULL CHECK (missing_hours_cents >= 0),
  advances_cents           bigint NOT NULL CHECK (advances_cents >= 0),
  loss_deductions_cents    bigint NOT NULL CHECK (loss_deductions_cents >= 0),
  gross_cents              bigint NOT NULL,
  deductions_cents         bigint NOT NULL,
  net_cents                bigint NOT NULL,
  payable_cents            bigint NOT NULL CHECK (payable_cents >= 0),     -- what is actually paid out
  shortfall_cents          bigint NOT NULL CHECK (shortfall_cents >= 0),   -- when deductions exceed earnings: what the person owes back
  UNIQUE (run_id, staff_key),
  CONSTRAINT commission_is_units_times_rate CHECK (commission_cents = units_sold * rate_cents),
  CONSTRAINT gross_is_sum CHECK (gross_cents = retainer_cents + commission_cents + bonuses_cents),
  CONSTRAINT deductions_is_sum CHECK (deductions_cents = late_cents + absence_cents + missing_hours_cents + advances_cents + loss_deductions_cents),
  CONSTRAINT net_is_gross_minus_deductions CHECK (net_cents = gross_cents - deductions_cents),
  CONSTRAINT payable_and_shortfall CHECK (payable_cents = GREATEST(net_cents, 0) AND shortfall_cents = GREATEST(-net_cents, 0))
);
CREATE TABLE payroll_item_lines (
  id            bigserial PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES payroll_items (id),
  kind          text NOT NULL CHECK (kind IN ('retainer_day', 'commission_order', 'bonus', 'late', 'absence', 'missing_hours', 'salary_advance', 'loss_deduction')),
  ref_date      date,
  ref_text      text,           -- the order reference, or the reason
  quantity      integer,        -- hours late, hours missing, units sold
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0)
);
CREATE INDEX payroll_item_lines_item ON payroll_item_lines (item_id);

-- Every order commissioned in a locked run, once. The primary key means an order can never earn commission twice.
CREATE TABLE commissioned_orders (
  order_ref    text PRIMARY KEY REFERENCES order_refs (ref),
  run_id       bigint NOT NULL REFERENCES payroll_runs (id),
  staff_key    text NOT NULL,
  units        integer NOT NULL CHECK (units > 0),
  total_cents  bigint NOT NULL CHECK (total_cents > 0),
  secured_at   timestamptz NOT NULL
);

-- Items and lines can only be written while their run is a draft; once it is approved they are frozen (Rule 9).
CREATE FUNCTION payroll_children_guard() RETURNS trigger AS $$
DECLARE
  rid bigint;
  st text;
BEGIN
  IF TG_TABLE_NAME = 'payroll_items' THEN
    rid := COALESCE(NEW.run_id, OLD.run_id);
  ELSIF TG_TABLE_NAME = 'payroll_item_lines' THEN
    SELECT run_id INTO rid FROM payroll_items WHERE id = COALESCE(NEW.item_id, OLD.item_id);
  ELSE
    rid := COALESCE(NEW.run_id, OLD.run_id);
  END IF;
  SELECT status INTO st FROM payroll_runs WHERE id = rid;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'payroll run % is % and locked: its figures never change', rid, COALESCE(st, 'missing') USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payroll_items_locked BEFORE INSERT OR UPDATE OR DELETE ON payroll_items FOR EACH ROW EXECUTE FUNCTION payroll_children_guard();
CREATE TRIGGER payroll_item_lines_locked BEFORE INSERT OR UPDATE OR DELETE ON payroll_item_lines FOR EACH ROW EXECUTE FUNCTION payroll_children_guard();
CREATE TRIGGER commissioned_orders_locked BEFORE INSERT ON commissioned_orders FOR EACH ROW EXECUTE FUNCTION payroll_children_guard();
CREATE TRIGGER commissioned_orders_immutable BEFORE UPDATE OR DELETE ON commissioned_orders FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payroll_items_no_truncate BEFORE TRUNCATE ON payroll_items FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER payroll_item_lines_no_truncate BEFORE TRUNCATE ON payroll_item_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER commissioned_orders_no_truncate BEFORE TRUNCATE ON commissioned_orders FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
