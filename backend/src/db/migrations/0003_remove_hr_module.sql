-- Remove the HR & back office module for good: attendance and clock-in, payroll and commission, employee onboarding,
-- requisitions and the end-of-day review. The code that used these tables is gone, so the tables go with it.
-- THIS DELETES DATA (payroll runs and payslips, attendance, signed agreements, requisitions). A copy of the database is
-- taken to backups/pre-migration-*.db before it runs; keep that file if you may ever need any of it.

PRAGMA defer_foreign_keys = ON;

-- Payroll and commission (children first). The lock triggers go with their tables.
DROP TABLE IF EXISTS payroll_item_lines;
DROP TABLE IF EXISTS commissioned_orders;
DROP TABLE IF EXISTS payroll_items;
DROP TABLE IF EXISTS payroll_runs;
DROP TABLE IF EXISTS payroll_adjustments;

-- Onboarding, attendance, end-of-day review and the reassignment log that only that review read.
DROP TABLE IF EXISTS employee_documents;
DROP TABLE IF EXISTS employee_agreements;
DROP TABLE IF EXISTS staff_attendance;
DROP TABLE IF EXISTS end_of_day_reviews;
DROP TABLE IF EXISTS assignment_moves;

-- Expenses used to point back at the requisition that created them. Rebuilt without that column (SQLite cannot drop a
-- column that carries a foreign key). Every other column, and every row, is copied across unchanged.
CREATE TABLE expenses_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              INTEGER REFERENCES stores(id),
  category_id           INTEGER NOT NULL REFERENCES expense_categories(id),
  amount                INTEGER NOT NULL CHECK (amount >= 0),
  description           TEXT,
  expense_date          TEXT NOT NULL,
  recorded_by_staff_id  INTEGER NOT NULL REFERENCES users(id),
  receipt_url           TEXT,
  status                TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by_staff_id  INTEGER REFERENCES users(id),
  reviewed_at           TEXT,
  review_note           TEXT,
  paid_from             TEXT NOT NULL DEFAULT 'main' CHECK (paid_from IN ('main','petty_cash')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT
);
INSERT INTO expenses_new (id, store_id, category_id, amount, description, expense_date, recorded_by_staff_id, receipt_url,
    status, reviewed_by_staff_id, reviewed_at, review_note, paid_from, created_at, updated_at, deleted_at)
  SELECT id, store_id, category_id, amount, description, expense_date, recorded_by_staff_id, receipt_url,
    status, reviewed_by_staff_id, reviewed_at, review_note, paid_from, created_at, updated_at, deleted_at FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

DROP TABLE IF EXISTS requisition_items;
DROP TABLE IF EXISTS requisitions;

-- Staff: the onboarding state and the pay terms (commission) columns.
ALTER TABLE users DROP COLUMN onboarding_status;
ALTER TABLE users DROP COLUMN commission_type;
ALTER TABLE users DROP COLUMN commission_fixed_cents;
ALTER TABLE users DROP COLUMN commission_percent_bp;

-- Settings that only the removed code read.
DELETE FROM settings WHERE key IN (
  'module_hr_enabled', 'attendance_workday_start_hour', 'attendance_late_fee_per_hour_kes', 'attendance_absence_fee_kes',
  'attendance_expected_hours', 'attendance_missing_hour_fee_kes', 'daily_retainer_kes', 'payroll_pay_day',
  'commission_below_70_percent_kes', 'commission_at_70_percent_kes', 'commission_at_80_percent_kes', 'commission_sales_target_kes',
  'employee_policy_version', 'employee_policy_text', 'telesales_cutoff_hour'
);
