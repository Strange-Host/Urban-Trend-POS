const db = require('../config/db');

// Known keys with sane defaults — anything not in this list can still be
// stored/read (the settings table is a generic key/value store), this just
// guarantees the Settings page always has something sensible to show.
const DEFAULTS = {
  // Optional modules (services/modules.service.js). Off until an admin switches them on.
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
  // How stock on hand is valued, and how the cost of each new sale is worked out: 'fifo' (oldest batch first) or 'average'
  // (moving average per store). Changing it does not rewrite the cost already recorded on past sales.
  inventory_valuation_method: 'fifo',
  // Batches expiring within this many days raise an "expiring soon" alert (0 = only alert once expired).
  expiry_alert_days: '30',
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
  // Clock-out gate. 'reason' = someone who still has orders undispatched or Nairobi payments unreconciled can clock
  // out only by writing why; 'block' = they cannot clock out until those are cleared.
  clockout_gate_mode: 'reason',
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
