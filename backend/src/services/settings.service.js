const db = require('../config/db');

// Known keys with sane defaults — anything not in this list can still be
// stored/read (the settings table is a generic key/value store), this just
// guarantees the Settings page always has something sensible to show.
const DEFAULTS = {
  // Optional modules (services/modules.service.js). Off until an admin switches them on.
  module_hr_enabled: '0',
  module_control_enabled: '0',
  business_name: 'Urban Trends',
  business_currency: 'KES',
  business_phone: '',
  business_pin: '',                              // KRA PIN, printed on invoices
  vat_rate_percent: '16',                        // used by the VAT report: prices are treated as VAT-inclusive at this rate
  // Largest discount a cashier may give, as a percent of the goods' list value (0 = no limit).
  // Managers and admins are not held to it.
  max_discount_percent: '0',
  business_address: '',
  receipt_footer: 'Thank you for shopping with us!',
  low_stock_default_reorder_level: '5',
  // Online orders (§1/§7): tiered courier delivery fee — flat under the
  // threshold, percentage above it. Values in whole KES, not cents (this
  // table is a plain string key/value store; orders.service.js converts).
  delivery_fee_threshold_kes: '5000',
  delivery_fee_flat_kes: '300',
  delivery_fee_percent: '5',
  // Delivery fee from the delivery-area table (Joyfull Cargo rates) when the customer's town matches one;
  // '1' = use it, '0' = always use the flat/percent rule above.
  delivery_use_area_rates: '1',
  // Office contacts included in delivery-timeline messaging (§1/§9) —
  // separate numbers for Nairobi vs. everywhere else.
  office_contact_nairobi: '',
  office_contact_main: '',
  // COD Confirmation Gate (§1): how long an order can sit unconfirmed
  // before it auto-cancels.
  cod_confirmation_window_minutes: '120',
  // Phase 6 (attendance-based payroll deductions §12):
  attendance_workday_start_hour: '8',          // late fee kicks in after this hour
  attendance_late_fee_per_hour_kes: '50',
  attendance_absence_fee_kes: '300',
  attendance_expected_hours: '8',              // a full clocked day — short of this incurs the missing-hours fee
  attendance_missing_hour_fee_kes: '30',
  daily_retainer_kes: '300',                   // paid for every day logged in, on top of commission
  // Pay cycle: a calendar month's work is paid on this day of the following month (1-28; the 3rd).
  payroll_pay_day: '3',
  // Commission tiers — BEST GUESS pending confirmation (see CHANGES.md):
  // the source requirements gave two different numbers for this before
  // landing on this one, which has an odd wrinkle (below AND at 70% pay
  // the same rate) that's very possibly a typo. Confirm before relying on
  // this in a real payroll run.
  commission_below_70_percent_kes: '30',        // per unit sold, achievement < 70% of target
  commission_at_70_percent_kes: '30',           // per unit sold, achievement >= 70% and < 80%
  commission_at_80_percent_kes: '50',           // per unit sold, achievement >= 80%
  commission_sales_target_kes: '50000',         // per staff member, per payroll period — configure per your actual targets
  // Phase 7 (employee onboarding & e-signature §13):
  employee_policy_version: '1',
  employee_policy_text: '',                     // shown at first login — set this before onboarding anyone for real
  // Phase 5 (telesales distribution §3):
  telesales_cutoff_hour: '10',                   // the "10:00 AM Rule" — configurable in case your actual cutoff differs
  // Off-site email backups (see backup.service.js) — comma-separated list
  // of recipient emails. SMTP connection details stay in .env (secrets);
  // this is just who gets the backup, which isn't a secret and is exactly
  // the kind of thing an admin wants to change without touching a server file.
  backup_email_recipients: '',
  // How customers are told to pay (used in SMS and receipts). Left blank on
  // purpose — the older system hardcoded paybill 522533 in SMS but 522522 in
  // its receipt fallback, so confirm the real number before filling this in.
  paybill_number: '',
  kcb_account_prefix: '',                        // e.g. "8025631" -> customers pay account "8025631#UT000123"; blank = bare code
  // Customer SMS (see services/sms.service.js). Master switch is OFF until
  // Zettatel credentials are saved and a test message has been sent.
  sms_enabled: '0',
  sms_send_order_received: '1',
  sms_send_payment_received: '1',
  sms_message_type: 'unicode',                   // the value the live older system uses; 'text' halves SMS cost if Zettatel accepts it — verify with a test send first
  sms_delivery_promise: 'It will be delivered within the next 24 hours.',
  sms_catalog_url: '',
  // Live sync with Shopify / WooCommerce (services/liveSync.service.js)
  live_poll_minutes: '10',                       // safety-net check for changes a webhook missed; 0 = off
  online_auto_import_orders: '1',                // new to-ship online orders are added to the Orders page by themselves
  // Sign-in security (services/sessions.service.js, loginGuard.service.js, securityAlerts.service.js).
  // Edited by an admin in the Security page, never by hand.
  security_lockout_attempts: '5',                // wrong passwords/PINs in a row before that account (or PIN) locks
  security_lockout_minutes: '15',
  security_lock_minutes_cashier: '5',            // idle minutes before the screen locks (password or PIN to carry on)
  security_lock_minutes_manager: '10',
  security_lock_minutes_admin: '10',
  security_idle_signout_minutes_cashier: '30',   // idle minutes before the session ends for good (not for remembered devices)
  security_idle_signout_minutes_manager: '60',
  security_idle_signout_minutes_admin: '30',
  security_max_session_hours_cashier: '12',      // the longest any one sign-in can last, however active
  security_max_session_hours_manager: '168',
  security_max_session_hours_admin: '24',
  security_unremembered_max_hours: '12',         // cap when "remember this device" is NOT ticked
  security_reauth_minutes: '5',                  // risky actions need the password/PIN typed within this many minutes
  security_alert_refund_kes: '3000',             // refunds and voids at or above this alert the admins
  security_alert_stock_units: '25',              // stock adjustments of this many units or more alert the admins
  security_alert_price_percent: '15',            // price changes of this percent or more alert the admins
};

function getAll() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...DEFAULTS, ...stored };
}

function setMany(updates, userId) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_by) VALUES (@key, @value, @updated_by)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')
  `);
  const txn = db.transaction((entries) => {
    for (const [key, value] of entries) {
      upsert.run({ key, value: String(value ?? ''), updated_by: userId || null });
    }
  });
  txn(Object.entries(updates));
  return getAll();
}

module.exports = { getAll, setMany, DEFAULTS };
