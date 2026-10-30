-- Urban Trends POS — Core Schema
-- SQLite (WAL mode). Designed to map cleanly onto Postgres later:
-- no SQLite-only tricks beyond AUTOINCREMENT / TEXT-for-datetime.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- STORES  (multi-location ready from day one)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  address             TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  shopify_location_id TEXT,                     -- matches this store to a Shopify location
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- USERS  (employees who log into registers)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER REFERENCES stores(id),
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT,                       -- Staff module (§5): reuses this table, doesn't duplicate identity
  password_hash  TEXT NOT NULL,
  pin_code_hash  TEXT,                       -- fast register login (4-6 digit PIN)
  role           TEXT NOT NULL CHECK (role IN ('admin','manager','cashier','store')),
  is_active      INTEGER NOT NULL DEFAULT 1, -- Staff "soft delete": DELETE sets this to 0, never removes the row
  -- Phase 7 (employee onboarding & e-signature): defaults to 'active' so
  -- every EXISTING staff member and every account made through the plain
  -- admin-facing POST /api/staff endpoint is completely unaffected — this
  -- gating is opt-in, only for staff hired through POST
  -- /api/employees/onboard (see employees.service.js), which explicitly
  -- starts new hires at 'pending_documents' with is_active = 0.
  onboarding_status TEXT NOT NULL DEFAULT 'active' CHECK (onboarding_status IN ('pending_documents','pending_signature','active')),
  token_version  INTEGER NOT NULL DEFAULT 1, -- bumped on password change/reset/deactivation to revoke outstanding JWTs
  -- 2.1 — set on the seeded admin account (a random one-time password, not
  -- the old hardcoded one) and on any account an admin creates with a
  -- temporary password; cleared the moment the user successfully changes
  -- it via POST /api/auth/change-password. Enforced in middleware/auth.js:
  -- while this is 1, every authenticated route except change-password/
  -- logout/me is blocked, so a temporary password can't be used to
  -- actually operate the account, only to set a real one.
  must_change_password INTEGER NOT NULL DEFAULT 0,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,  -- SMS sign-in code (twoFactor.service.js); opt-in per account
  -- Login protection: after too many wrong passwords/PINs the account locks for a while (services/loginGuard.service.js).
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  pin_failed_count   INTEGER NOT NULL DEFAULT 0,   -- PIN attempts are counted and locked separately, so guessing a till PIN can't lock someone out of password sign-in
  pin_locked_until   TEXT,
  password_changed_at TEXT,                     -- used to refuse reusing the same password and to show 'last changed'
  erased_at          TEXT,                      -- set when a former staff member's personal data was wiped (records kept)

  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_store ON users(store_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

-- ---------------------------------------------------------------------
-- REFRESH TOKENS  (long-lived, rotated on use, revocable)
-- ---------------------------------------------------------------------
-- Access tokens (JWTs) are now short-lived (see ACCESS_TOKEN_EXPIRES_IN) —
-- a stolen one is only useful for a few minutes. Staying logged in beyond
-- that goes through this table instead: the raw refresh token is only ever
-- returned to the client once, at login/rotation time; only its hash is
-- stored, so a leaked database doesn't hand out working session tokens.
-- Rotated on every use (old one revoked, new one issued) so a stolen
-- refresh token that gets used by someone else breaks the legitimate
-- user's session too — a visible sign something's wrong, not a silent leak.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  token_hash      TEXT NOT NULL UNIQUE,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  replaced_by_id  INTEGER REFERENCES refresh_tokens(id),
  session_id      INTEGER REFERENCES auth_sessions(id),   -- every refresh token belongs to one sign-in (session)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);

-- ---------------------------------------------------------------------
-- AUTH SESSIONS  (one row per sign-in on one device)
-- ---------------------------------------------------------------------
-- The session is what has an idle timeout and a hard maximum lifetime; refresh tokens rotate inside it
-- but can never extend it past absolute_expires_at. All times are ISO-8601 UTC written by the app.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  remember            INTEGER NOT NULL DEFAULT 0,      -- 'remember this device' was ticked at sign-in
  user_agent          TEXT,
  ip                  TEXT,
  created_at          TEXT NOT NULL,
  last_activity_at    TEXT NOT NULL,                   -- real use of the app (not background polling)
  reauth_at           TEXT NOT NULL,                   -- last time the password/PIN was typed: sensitive actions need this to be recent
  absolute_expires_at TEXT NOT NULL,
  revoked_at          TEXT,
  revoked_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at);

-- ---------------------------------------------------------------------
-- SECURITY EVENTS  (what the Security page shows: lockouts, resets, erasures, large refunds...)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','urgent')),
  title       TEXT NOT NULL,
  detail      TEXT,
  actor_id    INTEGER,          -- who did it (no foreign key: a row must outlive a deleted account)
  subject_id  INTEGER,          -- who it was done to / about
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(id DESC);

-- ---------------------------------------------------------------------
-- SETTINGS  (simple key/value store for POS-wide configuration —
-- business info, receipt text, tax defaults, feature toggles, etc.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- INCOME SOURCES  (every external channel money comes in from — the
-- store's own Shopify, and now any number of additional Shopify or
-- WooCommerce shops. `stores.id` is still the physical/POS location;
-- an income source optionally maps to one so its sales and inventory
-- attribute to a place. Credentials are per-source, never shared, and
-- nothing here ever touches `products`/`sales` until a sync is run.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS income_sources (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,                 -- display label, e.g. "Urban Trends – Shopify"
  platform            TEXT NOT NULL CHECK (platform IN ('shopify','woocommerce')),
  store_id            INTEGER REFERENCES stores(id), -- which POS location this channel's sales/stock attribute to
  is_active           INTEGER NOT NULL DEFAULT 1,

  -- Shopify — post-Jan-2026 apps are created in the Shopify Dev Dashboard and
  -- authenticate via OAuth rather than a copy-pasted Admin API token. We support
  -- both: paste a token from an existing/legacy custom app, or connect via OAuth.
  shop_domain         TEXT,          -- e.g. urban-trends.myshopify.com
  api_key             TEXT,          -- OAuth Client ID from the Dev Dashboard app
  api_secret          TEXT,          -- OAuth Client secret (also used to verify OAuth state)
  access_token        TEXT,          -- Admin API access token, however it was obtained
  api_version          TEXT DEFAULT '2026-01',
  oauth_scopes         TEXT,
  oauth_state           TEXT,        -- unused by the current client-credentials flow; kept for schema stability
  token_expires_at       TEXT,       -- client-credentials tokens expire every 24h and must be refreshed

  -- WooCommerce — REST API key/secret generated in WooCommerce → Settings → Advanced → REST API
  site_url             TEXT,
  consumer_key          TEXT,
  consumer_secret        TEXT,

  live_sync_enabled      INTEGER NOT NULL DEFAULT 0,
  webhook_secret         TEXT,
  last_webhook_at        TEXT,
  last_poll_at           TEXT,
  last_poll_error        TEXT,
  last_synced_at         TEXT,       -- last product catalog sync
  last_sales_synced_at    TEXT,      -- last order/sales sync
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_income_sources_platform ON income_sources(platform, is_active);

-- ---------------------------------------------------------------------
-- CATEGORIES  (self-referencing for subcategories)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES categories(id),
  is_archived INTEGER NOT NULL DEFAULT 0,   -- hidden from pickers but kept for old products/reports; can be restored
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- PRODUCTS  (indexed for search over thousands of SKUs)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                         TEXT NOT NULL UNIQUE,
  barcode                     TEXT UNIQUE,
  name                        TEXT NOT NULL,
  description                 TEXT,
  category_id                 INTEGER REFERENCES categories(id),
  brand                       TEXT,
  cost_price                  INTEGER NOT NULL DEFAULT 0,    -- what you paid, smallest KES subunit (cents), never float
  sell_price                  INTEGER NOT NULL,              -- what customer pays, smallest KES subunit (cents), never float
  tax_rate                    REAL NOT NULL DEFAULT 0,        -- e.g. 0.16 for 16% VAT
  image_url                   TEXT,
  is_active                   INTEGER NOT NULL DEFAULT 1,
  shopify_product_id          TEXT,             -- external product id this row was created/updated from
  shopify_variant_id          TEXT,             -- external variant/product id — uniqueness is scoped per income
                                                  -- source below (idx_products_variant_per_source), NOT globally:
                                                  -- two different connected stores can legitimately both have
                                                  -- their own "product 15".
  shopify_inventory_item_id   TEXT,             -- needed for future inventory-level pushes
  shopify_synced_at           TEXT,             -- last time this row was pulled/approved from a connected store
  income_source_id            INTEGER REFERENCES income_sources(id), -- which connected store shopify_variant_id belongs
                                                                       -- to (NULL = legacy single-store env-var setup, or
                                                                       -- a locally-created product with no external link).
                                                                       -- Needed because Shopify/WooCommerce ids are only
                                                                       -- unique WITHIN one store, not across stores — two
                                                                       -- different WooCommerce sites both number their
                                                                       -- own products 1, 2, 3..., so without this a sync
                                                                       -- from one store could match against and silently
                                                                       -- overwrite a product that actually belongs to a
                                                                       -- different connected store.
  -- Approval of products proposed by staff who may not create them outright (the storekeeper). A proposal is saved
  -- with is_active = 0 so every existing screen that only lists active products (till, orders, stock) ignores it
  -- until a manager approves it. Everything that existed before this column keeps the default 'approved'.
  approval_status             TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('approved','pending','rejected')),
  submitted_by_staff_id       INTEGER REFERENCES users(id),
  reviewed_by_staff_id        INTEGER REFERENCES users(id),
  reviewed_at                 TEXT,
  review_note                 TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_variant_per_source ON products(
  COALESCE(income_source_id, 0), shopify_variant_id
) WHERE shopify_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
-- sku/barcode already indexed via UNIQUE

-- ---------------------------------------------------------------------
-- INVENTORY  (cached quantity per store — source of truth is the ledger)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  quantity       INTEGER NOT NULL DEFAULT 0,
  reorder_level  INTEGER NOT NULL DEFAULT 5,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_store ON inventory(store_id);
CREATE INDEX IF NOT EXISTS idx_inventory_low ON inventory(quantity, reorder_level);

-- ---------------------------------------------------------------------
-- INVENTORY MOVEMENTS  (append-only ledger — the real audit trail)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  change_qty     INTEGER NOT NULL,             -- negative for sale/dispatch, positive for restock/return
  reason         TEXT NOT NULL CHECK (reason IN (
    'sale','restock','adjustment','return','void','requisition',
    'dispatch',           -- online order dispatched — stock deducted (reference_type='order')
    'return_resellable'   -- online order return inspected good — stock reinstated (reference_type='order')
  )),
  reference_type TEXT CHECK (reference_type IN ('sale','order','requisition','adjustment')),
  reference_id   INTEGER,                      -- e.g. sale_id or order_id, disambiguated by reference_type
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON inventory_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_reference ON inventory_movements(reference_type, reference_id);

-- ---------------------------------------------------------------------
-- CUSTOMERS  (optional attach to sale, loyalty-ready)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  phone            TEXT,
  phone_normalized TEXT,        -- last 9 digits, digits only — same convention as leads.phone_normalized;
                                 -- how online orders find "does this customer already exist" by phone
  email            TEXT,
  city             TEXT,        -- City/Town (§2 Online Order Management) — also drives Nairobi vs.
                                 -- outside-Nairobi delivery-timeline messaging once that's wired up
  loyalty_points   INTEGER NOT NULL DEFAULT 0,
  -- Customer Risk Management (§3): 'none' by default; a service function bumps this
  -- based on COD-rejection/no-pickup history, never set directly by request input.
  risk_flag        TEXT NOT NULL DEFAULT 'none',   -- 'none' | 'watch' | 'high'
  prepay_required  INTEGER NOT NULL DEFAULT 0,     -- repeat offenders forced to prepay (§3)
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_phone_norm ON customers(phone_normalized);

-- ---------------------------------------------------------------------
-- CASH DRAWER SESSIONS  (open/close reconciliation per cashier shift)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        INTEGER NOT NULL REFERENCES stores(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  opening_amount  INTEGER NOT NULL,     -- smallest KES subunit (cents), never float
  closing_amount  INTEGER,              -- smallest KES subunit (cents), never float
  expected_amount INTEGER,              -- smallest KES subunit (cents), never float
  opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_user ON cash_sessions(user_id, closed_at);

-- ---------------------------------------------------------------------
-- SALES  (header)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id         INTEGER NOT NULL REFERENCES stores(id),
  cashier_id       INTEGER NOT NULL REFERENCES users(id),
  customer_id      INTEGER REFERENCES customers(id),
  cash_session_id  INTEGER REFERENCES cash_sessions(id),
  subtotal         INTEGER NOT NULL,          -- smallest KES subunit (cents), never float
  tax_total        INTEGER NOT NULL,          -- smallest KES subunit (cents), never float — always 0, see CHANGES.md
  discount_total   INTEGER NOT NULL DEFAULT 0, -- smallest KES subunit (cents), never float
  total            INTEGER NOT NULL,          -- smallest KES subunit (cents), never float
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('cash','card','mobile_money','split')),
  status           TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded','voided')),
  -- Channel attribution — where the sale actually happened. 'local' is the
  -- register (default, unchanged from before). 'shopify'/'woocommerce' sales
  -- are pulled in read-only from an income source and never touch local stock.
  source_type            TEXT NOT NULL DEFAULT 'local' CHECK (source_type IN ('local','shopify','woocommerce')),
  income_source_id       INTEGER REFERENCES income_sources(id),
  external_order_id      TEXT,     -- the platform's own order id (dedup key alongside income_source_id)
  external_order_number  TEXT,     -- human-friendly number, e.g. "#1023"
  synced_at               TEXT,    -- when this row was pulled in (NULL for local sales)
  -- Offline register support: a UUID the CLIENT generates before it ever
  -- tries to send a sale, so a sale queued offline (or sent but never
  -- acknowledged, e.g. the response was lost) can be safely retried
  -- forever without ever creating a duplicate. checkout() looks this up
  -- first and returns the existing sale untouched if it's already here —
  -- see sales.service.js. NULL for sales rung up while online, which
  -- never needed a retry.
  client_sale_id          TEXT,
  external_updated_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_store_date ON sales(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_cashier ON sales(cashier_id);
CREATE INDEX IF NOT EXISTS idx_sales_source ON sales(source_type, income_source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_external_dedup ON sales(income_source_id, external_order_id) WHERE external_order_id IS NOT NULL;
-- Offline-sale idempotency. Unique so that even a genuine race (two retries
-- of the same queued sale landing simultaneously from a flaky connection)
-- can't both insert — the second hits this constraint rather than creating
-- a duplicate sale that double-deducts stock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_client_sale_id ON sales(client_sale_id) WHERE client_sale_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- SALE ITEMS  (line items)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id      INTEGER NOT NULL REFERENCES sales(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  quantity     INTEGER NOT NULL,
  unit_price   INTEGER NOT NULL,    -- price at time of sale, smallest KES subunit (cents), never float
  tax_rate     REAL NOT NULL,
  discount     INTEGER NOT NULL DEFAULT 0, -- smallest KES subunit (cents), never float
  line_total   INTEGER NOT NULL    -- smallest KES subunit (cents), never float
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

-- ---------------------------------------------------------------------
-- PAYMENTS  (supports split payments per sale)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     INTEGER NOT NULL REFERENCES sales(id),
  method      TEXT NOT NULL CHECK (method IN ('cash','card','mobile_money')),
  amount      INTEGER NOT NULL,  -- smallest KES subunit (cents), never float
  reference   TEXT,               -- e.g. M-Pesa code, card auth code
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- ORDERS  (Phase 1 of the POS -> inventory-management conversion — the
-- online/COD order lifecycle. Deliberately a separate table from `sales`,
-- not a repurposing of it: a `sale` is created complete, paid, and stock-
-- deducted in one step (POS checkout, unchanged); an `order` is created
-- long before any of that is true and moves through a state machine as
-- it's dispatched, paid, and possibly returned. See orders.service.js for
-- the transition table and CHANGES.md for why this isn't just a new
-- `sales.status` value.
--
-- Stock is deducted the moment an order is dispatched (transition into
-- 'dispatched_unpaid'), never at order creation ('awaiting_dispatch' never
-- touches stock — matches the "Awaiting Dispatch does NOT affect stock"
-- requirement). Stock is reinstated only on 'returned_resellable', never
-- on 'returned_damaged' (blocked from resale, per the RMA requirement).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id            INTEGER NOT NULL REFERENCES stores(id),
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  lead_id             INTEGER REFERENCES leads(id),        -- set when this order came from a converted lead
  assigned_staff_id   INTEGER REFERENCES users(id),         -- telesales rep handling this order
  channel             TEXT NOT NULL DEFAULT 'manual' CHECK (channel IN ('shopify','wordpress','manual')),
  external_order_id   TEXT,                                -- Shopify/WordPress order id, once that sync exists
  status              TEXT NOT NULL DEFAULT 'awaiting_dispatch' CHECK (status IN (
    'awaiting_dispatch',            -- keyed in, NOT yet dispatched — no stock deduction
    'dispatched_unpaid',            -- dispatched, stock deducted, nothing paid yet
    'dispatched_partial',           -- dispatched, partially paid
    'dispatched_paid',              -- dispatched, fully paid
    'returned_in_transit',          -- heading back to shop (rejected/unreachable/customer return)
    'returned_awaiting_inspection', -- physically back at shop, not yet inspected
    'returned_resellable',          -- inspected good — stock reinstated to available (terminal)
    'returned_damaged',             -- inspected damaged — blocked from resale (terminal)
    'cancelled'                     -- cancelled before dispatch — stock was never touched (terminal)
  )),
  subtotal            INTEGER NOT NULL DEFAULT 0,  -- smallest KES subunit (cents), never float
  discount_total       INTEGER NOT NULL DEFAULT 0, -- smallest KES subunit (cents), never float
  total               INTEGER NOT NULL DEFAULT 0,  -- smallest KES subunit (cents), never float
  amount_paid         INTEGER NOT NULL DEFAULT 0,  -- smallest KES subunit (cents), never float — running total from order_payments
  -- Phase 2 (courier, dispatch & COD confirmation gate):
  payment_type        TEXT NOT NULL DEFAULT 'cod' CHECK (payment_type IN ('cod','prepaid','g4s_pickup_pay')),
  courier_type        TEXT CHECK (courier_type IN ('boda','g4s')),        -- auto-suggested from delivery_zone, overridable
  delivery_zone       TEXT CHECK (delivery_zone IN ('nairobi','outside')), -- derived from customer.city at creation time
  delivery_fee        INTEGER NOT NULL DEFAULT 0,   -- smallest KES subunit (cents) — tiered: flat under threshold, % above
  cod_confirmed_at    TEXT,                          -- mandatory telesales confirmation before dispatch, COD orders only
  cod_confirmed_by    INTEGER REFERENCES users(id),
  cod_confirmation_expires_at TEXT,                  -- unconfirmed COD orders auto-cancel after this (see orders.service.js)
  -- Phase 3 (payment reconciliation): generated at creation, given to the
  -- customer to quote when paying — how an incoming M-Pesa/KCB payment gets
  -- matched back to this exact order (see payment_notifications below and
  -- CHANGES.md for why this beats matching on name+amount alone).
  product_code        TEXT,
  notes               TEXT,
  dispatched_at       TEXT,
  returned_at         TEXT,
  -- Phase 4 (RMA): why the parcel is coming back, captured when the return
  -- starts (markReturnedInTransit) — distinct from inspection_result below,
  -- which is the physical condition found once it's actually back at the
  -- shop. A parcel can be "rejected" (customer refused it) and still turn
  -- out to be in perfectly good condition, or vice versa.
  return_reason       TEXT CHECK (return_reason IN ('rejected','damaged','wrong_item')),
  inspected_at        TEXT,
  inspected_by        INTEGER REFERENCES users(id),
  inspection_result   TEXT CHECK (inspection_result IN ('good','damaged')),
  -- Phase 4 (RMA — owner write-off/disposal decision): a 'damaged'
  -- inspection blocks resale automatically (see orders.service.js), but
  -- the requirement is explicit that a human owner still has to decide
  -- what physically happens to it — this doesn't happen on its own just
  -- because the status is terminal.
  owner_notified_at   TEXT,                                          -- set the instant inspection lands on 'damaged' — the "notification" IS entering this queue (see GET /api/orders/pending-owner-decision), there's no SMS/email/WhatsApp send here yet
  owner_decision       TEXT CHECK (owner_decision IN ('write_off','dispose')),
  owner_decision_by    INTEGER REFERENCES users(id),
  owner_decision_at    TEXT,
  owner_decision_notes TEXT,
  -- Phase 8 (Dispute Management §10): dispute_status is nullable — NULL
  -- means "no dispute has ever been raised", not "resolved"; a dispute
  -- always starts 'open' and moves to 'resolved' exactly once (see
  -- disputes.service.js). Independent of the order's own lifecycle status
  -- — a dispute can be raised on a dispatched_paid order just as easily
  -- as a returned one.
  dispute_status        TEXT CHECK (dispute_status IN ('open','resolved')),
  dispute_reason        TEXT,
  dispute_outcome       TEXT CHECK (dispute_outcome IN ('refund','redelivered','closed')),
  dispute_opened_by     INTEGER REFERENCES users(id),
  dispute_opened_at     TEXT,
  dispute_resolved_by   INTEGER REFERENCES users(id),
  dispute_resolved_at   TEXT,
  dispute_resolution_notes TEXT,
  cancelled_at        TEXT,
courier_id          INTEGER REFERENCES couriers(id),  -- a NAMED courier; courier_type stays the fee/zone source of truth
income_source_id    INTEGER REFERENCES income_sources(id),  -- which Shopify/WooCommerce connection an imported order came from
sale_id             INTEGER REFERENCES sales(id),           -- the Sales-history record of the SAME online order; reports count revenue from the sale, never from both
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_assigned ON orders(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_orders_deleted ON orders(deleted_at);
-- product_code can't be an inline UNIQUE column (SQLite won't allow adding
-- a UNIQUE column via ALTER TABLE ADD COLUMN on an existing database, so
-- schema.sql and the additive migration path have to agree on the same
-- approach) — a partial unique index gets the same guarantee for both.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_product_code ON orders(product_code) WHERE product_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  quantity     INTEGER NOT NULL,
  unit_price   INTEGER NOT NULL,          -- price at time of order, smallest KES subunit (cents)
  discount     INTEGER NOT NULL DEFAULT 0,
  line_total   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

-- Append-only, mirrors lead_status_history — every transition timestamped
-- and attributed, which is what "all confirmations/movements logged with
-- timestamp and staff ID" (§1, §8) actually means at the data layer.
CREATE TABLE IF NOT EXISTS order_status_history (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id              INTEGER NOT NULL REFERENCES orders(id),
  from_status           TEXT,
  to_status             TEXT NOT NULL,
  notes                 TEXT,
  changed_by_staff_id   INTEGER REFERENCES users(id),
  changed_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id);

-- ---------------------------------------------------------------------
-- PAYMENT NOTIFICATIONS  (Phase 3 — the raw feed of incoming M-Pesa/KCB
-- payment events, kept separate from payment_records. payment_records is
-- the confirmed ledger — money that's definitely been matched to a sale or
-- order; payment_notifications is everything that arrived, matched or not,
-- which is what makes "flag unmatched payments for follow-up" (§2)
-- possible at all. A matched notification also gets a payment_records row
-- (via orders.service.js recordPayment) — this table doesn't replace that,
-- it's the audit trail of what was received and how it got resolved.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_notifications (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id            INTEGER REFERENCES stores(id),
  source              TEXT NOT NULL CHECK (source IN ('kcb','mpesa','manual')),
  method              TEXT NOT NULL CHECK (method IN ('mobile_money','bank_transfer','cash')),
  amount              INTEGER NOT NULL CHECK (amount > 0),  -- smallest KES subunit
  -- 'incoming' (default): a customer payment, matched against an order by
  -- product code (unchanged behavior). 'outgoing': money the business paid
  -- OUT via KCB/M-Pesa (supplier, courier, till withdrawal, etc.) — never
  -- matched to an order; auto-mirrored into `expenses` instead so it's not
  -- silently invisible to profit reporting. See paymentReconciliation.service.js.
  direction           TEXT NOT NULL DEFAULT 'incoming' CHECK (direction IN ('incoming','outgoing')),
  external_reference  TEXT,      -- the M-Pesa/KCB transaction code, for dedup/audit
  matched_code        TEXT,      -- the product_code extracted from the payment narrative/account number, if any
  payer_name          TEXT,      -- raw payer name — handles "spouse pays on the customer's behalf" (§ WhatsApp log)
  order_id            INTEGER REFERENCES orders(id),  -- set once matched, auto or manual (incoming only)
  expense_id          INTEGER REFERENCES expenses(id), -- set once mirrored to an expense (outgoing only)
  status              TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','ignored')),
  raw_payload         TEXT,      -- full JSON of what the webhook received, for debugging a bad match
  resolved_by         INTEGER REFERENCES users(id),
  resolved_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_notifications_status ON payment_notifications(status);
CREATE INDEX IF NOT EXISTS idx_payment_notifications_order ON payment_notifications(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_notifications_dedup ON payment_notifications(source, external_reference) WHERE external_reference IS NOT NULL;

-- ---------------------------------------------------------------------
-- PAYMENT GATEWAY CREDENTIALS  (Settings → M-Pesa / KCB API config)
-- Same encrypted-at-rest pattern as income_sources (see utils/crypto.js) —
-- ENCRYPTED_FIELDS in paymentGatewayCredentials.service.js decides which
-- of these columns actually get encrypt()'d; the rest (shortcode, account
-- number, environment) aren't secrets and stay plaintext.
--
-- NOTE on the KCB fields specifically: there's no real KCB API
-- documentation available (same gap noted throughout Phase 3) — this
-- shape is a reasonable guess (client id/key/secret + account number,
-- the common pattern for this kind of bank API) and will very likely need
-- adjusting once real KCB developer access exists.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_gateway_credentials (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id                  INTEGER REFERENCES stores(id),
  provider                  TEXT NOT NULL CHECK (provider IN ('mpesa','kcb')),
  is_active                 INTEGER NOT NULL DEFAULT 1,
  environment               TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production')),

  -- M-Pesa (Safaricom Daraja API)
  mpesa_shortcode           TEXT,          -- Paybill/Till number — published to customers, not a secret
  mpesa_consumer_key        TEXT,
  mpesa_consumer_secret     TEXT,
  mpesa_passkey             TEXT,
  mpesa_initiator_name      TEXT,          -- needed for B2C (money OUT) — a username, not a secret
  mpesa_initiator_password  TEXT,

  -- KCB — see the table-level comment above on why this is a best guess
  kcb_account_number        TEXT,
  kcb_client_id             TEXT,
  kcb_api_key               TEXT,
  kcb_api_secret            TEXT,

  -- Per-provider webhook shared secret — once set, takes precedence over
  -- the single global PAYMENT_WEBHOOK_SECRET env var (see middleware/webhookAuth.js)
  webhook_secret            TEXT,

  last_synced_at            TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_gateway_credentials_provider ON payment_gateway_credentials(store_id, provider);

-- STK push (Lipa Na M-Pesa Online) tracking. C2B payments carry the
-- account reference (product code) directly in the callback — STK's
-- callback does NOT echo AccountReference back, only whatever the
-- customer's phone/Safaricom itself returns (receipt number, amount,
-- phone, timestamp). So the account reference has to be remembered at
-- push-initiation time and looked up by checkout_request_id when the
-- callback arrives — that's what this table is for.
CREATE TABLE IF NOT EXISTS stk_push_requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              INTEGER NOT NULL REFERENCES stores(id),
  checkout_request_id   TEXT NOT NULL UNIQUE,
  merchant_request_id   TEXT,
  account_reference     TEXT NOT NULL,       -- the product code this push was for
  phone                 TEXT NOT NULL,
  amount                INTEGER NOT NULL,    -- cents, at initiation time
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  result_code            INTEGER,
  result_desc            TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_stk_push_requests_status ON stk_push_requests(status);

-- ---------------------------------------------------------------------
-- SHOPIFY STAGING  (pulled products land here — nothing touches the live
-- catalog until a manager/admin reviews and approves it, per the same
-- "no silent overwrite, human review before publish" rule as everywhere
-- else in this system)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopify_staging_products (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  platform                  TEXT NOT NULL DEFAULT 'shopify' CHECK (platform IN ('shopify','woocommerce')),
  income_source_id          INTEGER REFERENCES income_sources(id), -- NULL means the legacy env-var (.env) source
  shopify_product_id        TEXT NOT NULL,
  shopify_variant_id        TEXT NOT NULL,
  shopify_inventory_item_id TEXT,
  sku                       TEXT,
  barcode                   TEXT,
  name                      TEXT NOT NULL,        -- product title + variant title (e.g. "Crew Tee — Blue / M")
  sell_price                INTEGER NOT NULL,  -- smallest KES subunit (cents), never float
  inventory_qty             INTEGER NOT NULL DEFAULT 0,
  image_url                 TEXT,
  raw_json                  TEXT NOT NULL,          -- full Shopify payload, for audit / re-review
  match_status              TEXT NOT NULL DEFAULT 'new' CHECK (match_status IN ('new','update','unchanged')),
  matched_product_id        INTEGER REFERENCES products(id), -- set when match_status is 'update'
  category_id               INTEGER REFERENCES categories(id), -- assigned by a reviewer before approving; never touched by a re-sync
  review_status             TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
  fetched_at                TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at               TEXT,
  reviewed_by               INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_staging_review ON shopify_staging_products(review_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_variant_per_source ON shopify_staging_products(
  platform, COALESCE(income_source_id, 0), shopify_variant_id
);

-- ---------------------------------------------------------------------
-- STAFF LOGS  (write-only audit trail — never edited/deleted via the API.
-- Supersedes the old, never-wired-up `audit_log` table.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  entity_type TEXT NOT NULL,          -- 'lead','requisition','expense','payment','staff' (approvals/rejections are 'update' rows whose diff shows the status change)
  entity_id   INTEGER NOT NULL,
  changes     TEXT NOT NULL DEFAULT '{}', -- JSON diff (or full snapshot on delete)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_logs_entity ON staff_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_staff_logs_staff ON staff_logs(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_logs_created ON staff_logs(created_at);

-- ---------------------------------------------------------------------
-- STAFF ATTENDANCE  (Phase 5/6/8 shared foundation — clock-in/out is what
-- "logged in" and "marked present" actually mean at the data layer for
-- telesales distribution (§3), payroll deductions (§12), and absence
-- detection (§11) alike. One row per staff member per calendar day —
-- clock_in_at set on the day's first clock-in, clock_out_at on clock-out.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_attendance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER NOT NULL REFERENCES users(id),
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  work_date    TEXT NOT NULL,   -- YYYY-MM-DD, local server date
  clock_in_at  TEXT,
  clock_out_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_attendance_staff_date ON staff_attendance(staff_id, work_date);
CREATE INDEX IF NOT EXISTS idx_staff_attendance_store_date ON staff_attendance(store_id, work_date);

-- ---------------------------------------------------------------------
-- PAYROLL ADJUSTMENTS  (Phase 6 — event-based deductions/credits that
-- can't be derived from attendance alone: salary/personal advances
-- (auto-posted here when a 'salary_advance' requisition is approved — see
-- requisitions.service.js) and employee-caused loss deductions (§ Loss
-- Deductions). Attendance-based deductions (absence/late/missing-hours)
-- and commission are deliberately NOT stored rows here — they're
-- calculated fresh from staff_attendance + orders every time
-- payroll.service.js builds a summary, so there's no ledger to keep in
-- sync or risk double-posting.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id       INTEGER NOT NULL REFERENCES users(id),
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  type           TEXT NOT NULL CHECK (type IN ('salary_advance','loss_deduction')),
  amount         INTEGER NOT NULL CHECK (amount > 0),  -- smallest KES subunit — always a deduction, never negative
  requisition_id INTEGER REFERENCES requisitions(id),   -- set when this came from an approved salary-advance requisition
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_staff ON payroll_adjustments(staff_id);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_created ON payroll_adjustments(created_at);

-- ---------------------------------------------------------------------
-- EMPLOYEE ONBOARDING & E-SIGNATURE  (Phase 7)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_documents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id       INTEGER NOT NULL REFERENCES users(id),
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('national_id','cv','contract')),
  file_reference TEXT NOT NULL,   -- a path/URL to wherever the file actually lives — this app has no
                                    -- binary file storage of its own; that's an external/frontend concern
  uploaded_by    INTEGER REFERENCES users(id),
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_documents_staff_type ON employee_documents(staff_id, doc_type);

-- One row per (staff, policy_version) — re-signing a NEW version is a new
-- row; nothing is overwritten, so there's a permanent record of exactly
-- which version of the rules someone agreed to and when (§13 Audit log:
-- "employee name, timestamp, rules version/effective date").
CREATE TABLE IF NOT EXISTS employee_agreements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id       INTEGER NOT NULL REFERENCES users(id),
  policy_version TEXT NOT NULL,
  signed_name    TEXT NOT NULL,  -- typed full name — the lightweight "signature" this app can actually capture
  signed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_agreements_staff_version ON employee_agreements(staff_id, policy_version);

-- ---------------------------------------------------------------------
-- CRM — LEADS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id            INTEGER REFERENCES stores(id),
  name                TEXT NOT NULL,
  phone               TEXT NOT NULL,
  phone_normalized    TEXT NOT NULL,     -- last 9 digits, digits only — for duplicate detection
  email               TEXT,
  source              TEXT NOT NULL CHECK (source IN ('whatsapp','walk_in','referral','shopify','other')),
  status              TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','rescheduled','converted','cancelled')),
  assigned_staff_id   INTEGER REFERENCES users(id),
  notes               TEXT,
  follow_up_date      TEXT,             -- required when status = 'rescheduled'
  converted_order_id  INTEGER REFERENCES orders(id),   -- the order this lead became (was wrongly sales(id) before Phase 0)
external_id         TEXT,                  -- the web form's own entry id: makes a re-delivered webhook idempotent
form_name           TEXT,
raw_payload         TEXT,                  -- exactly what the form sent, so nothing is lost to a mapping gap
interested_product_id INTEGER REFERENCES products(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_phone_norm ON leads(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_leads_deleted ON leads(deleted_at);

CREATE TABLE IF NOT EXISTS lead_activities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id),
  type        TEXT NOT NULL CHECK (type IN ('call','message','meeting','note','status_change')),
  content     TEXT,
  staff_id    INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id);

CREATE TABLE IF NOT EXISTS lead_status_history (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id               INTEGER NOT NULL REFERENCES leads(id),
  from_status           TEXT,
  to_status             TEXT NOT NULL,
  changed_by_staff_id   INTEGER REFERENCES users(id),
  changed_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_status_history_lead ON lead_status_history(lead_id);

-- ---------------------------------------------------------------------
-- REQUISITIONS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requisitions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id                INTEGER REFERENCES stores(id),
  requested_by_staff_id   INTEGER NOT NULL REFERENCES users(id),
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  -- Phase 6 (Commission, Salaries & Requisitions §10): 'shop_operational' is
  -- the original product-request flow below (requisition_items), untouched.
  -- 'salary_advance' skips requisition_items entirely and uses `amount`
  -- instead — approving one auto-posts a payroll_adjustments row (see
  -- requisitions.service.js), which is what "automatically deducted from
  -- salary" actually means at the data layer.
  type                    TEXT NOT NULL DEFAULT 'shop_operational' CHECK (type IN ('shop_operational','salary_advance')),
  amount                  INTEGER,  -- smallest KES subunit — only used for type='salary_advance'
  reviewed_by_staff_id    INTEGER REFERENCES users(id),
  reviewed_at             TEXT,
  rejection_reason        TEXT,
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_requisitions_status ON requisitions(status);
CREATE INDEX IF NOT EXISTS idx_requisitions_requester ON requisitions(requested_by_staff_id);

CREATE TABLE IF NOT EXISTS requisition_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id       INTEGER NOT NULL REFERENCES requisitions(id),
  product_id           INTEGER NOT NULL REFERENCES products(id),
  quantity_requested   INTEGER NOT NULL CHECK (quantity_requested > 0),
  quantity_approved    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requisition_items_req ON requisition_items(requisition_id);

-- ---------------------------------------------------------------------
-- EXPENSES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS expenses (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              INTEGER REFERENCES stores(id),
  category_id           INTEGER NOT NULL REFERENCES expense_categories(id),
  amount                INTEGER NOT NULL CHECK (amount >= 0), -- smallest KES subunit (cents), never float
  description           TEXT,
  expense_date          TEXT NOT NULL,   -- calendar date (YYYY-MM-DD), distinct from created_at
  recorded_by_staff_id  INTEGER NOT NULL REFERENCES users(id),
  receipt_url           TEXT,
  -- Approval workflow. Rows that existed before it was introduced default to 'approved' (they were already counted).
  status                TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by_staff_id  INTEGER REFERENCES users(id),
  reviewed_at           TEXT,
  review_note           TEXT,
  paid_from             TEXT NOT NULL DEFAULT 'main' CHECK (paid_from IN ('main','petty_cash')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT
);

-- Money put into the petty-cash float. Spending from it is an ordinary expense with paid_from = 'petty_cash', so it
-- flows through the same approval and the same profit figures; the float balance is top-ups minus those expenses.
CREATE TABLE IF NOT EXISTS petty_cash_topups (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              INTEGER NOT NULL REFERENCES stores(id),
  amount                INTEGER NOT NULL CHECK (amount > 0),       -- smallest KES subunit (cents)
  note                  TEXT,
  topup_date            TEXT NOT NULL,
  recorded_by_staff_id  INTEGER NOT NULL REFERENCES users(id),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by_staff_id  INTEGER REFERENCES users(id),
  reviewed_at           TEXT,
  review_note           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_petty_cash_topups_store ON petty_cash_topups(store_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

-- ---------------------------------------------------------------------
-- PAYMENT RECORDS  (interpretation B: distinct recording action — layaway /
-- partial customer payments and outgoing supplier payments. NOT the same
-- table as `payments` above, which is Terminal's own per-sale checkout
-- record; that table stays untouched and out of scope for this module.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_records (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              INTEGER REFERENCES stores(id),
  direction             TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  sale_id               INTEGER REFERENCES sales(id),      -- set for incoming POS customer/layaway payments
  order_id              INTEGER REFERENCES orders(id),     -- set for incoming online-order payments (§2 Payments & Reconciliation)
  supplier_name         TEXT,                                -- set for outgoing supplier payments
  method                TEXT NOT NULL CHECK (method IN ('cash','card','mobile_money','bank_transfer')),
  amount                INTEGER NOT NULL CHECK (amount > 0), -- smallest KES subunit
  status                TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded','failed')),
  reference             TEXT,
  notes                 TEXT,
  recorded_by_staff_id  INTEGER NOT NULL REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_records_sale ON payment_records(sale_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_order ON payment_records(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_status ON payment_records(status);
CREATE INDEX IF NOT EXISTS idx_payment_records_date ON payment_records(created_at);

-- ---------------------------------------------------------------------
-- CUSTOMER SMS  (Zettatel). Credentials are encrypted at rest with the same
-- AES-256-GCM helper as the payment gateways. The outbox is the only way a
-- message leaves the app: business code INSERTs a 'queued' row inside its own
-- DB transaction (so a rolled-back order never sends an SMS), and a timer
-- drains the queue with retry/backoff after commit.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_credentials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL UNIQUE REFERENCES stores(id),
  provider       TEXT NOT NULL DEFAULT 'zettatel',
  user_id_enc    TEXT,                 -- encrypted
  password_enc   TEXT,                 -- encrypted
  sender_id      TEXT,                 -- shown to the recipient anyway, so stored plaintext
  is_active      INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_outbox (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id           INTEGER NOT NULL REFERENCES stores(id),
  to_phone           TEXT NOT NULL,      -- 2547XXXXXXXX / 2541XXXXXXXX
  template           TEXT NOT NULL,      -- order_received | payment_received | test
  body               TEXT NOT NULL,
  related_type       TEXT,
  related_id         INTEGER,
  dedupe_key         TEXT,               -- e.g. "order_received:123" — a second enqueue with the same key is a no-op
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','expired')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_error         TEXT,
  provider_response  TEXT,               -- truncated raw reply, so the first real send can be inspected
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_outbox_dedupe ON sms_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_outbox_due ON sms_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_related ON sms_outbox(related_type, related_id);

-- ---------------------------------------------------------------------
-- IN-APP NOTIFICATIONS. One row PER RECIPIENT (a notice for "all managers"
-- fans out to one row each) so read-state and ownership checks are trivial:
-- a user can only ever see or mark their own rows.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,           -- lead_follow_up_due | lead_assigned | damaged_return | unmatched_payment | low_stock
  title        TEXT NOT NULL,
  body         TEXT,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','urgent')),
  entity_type  TEXT,                    -- lead | order | payment_notification | product
  entity_id    INTEGER,
  dedupe_key   TEXT,                    -- one notice per (user, key); cleared when the underlying condition resolves
  read_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- PER-USER PERMISSION OVERRIDES (see config/permissions.js). A row only
-- exists where an admin has deliberately granted or revoked one permission
-- for one person; everyone else follows their role's defaults.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  permission  TEXT NOT NULL,
  granted     INTEGER NOT NULL CHECK (granted IN (0,1)),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, permission)
);

-- ---------------------------------------------------------------------
-- COURIERS — named riders / agents, so unpaid-parcel accountability and
-- payouts attach to a real person instead of just the 'boda'/'g4s' type.
-- orders.courier_id (additive column) points here; orders.courier_type
-- stays the source of truth for fee/zone logic.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS couriers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  name          TEXT NOT NULL,
  phone         TEXT,
  vehicle       TEXT,                  -- e.g. "KMEB 123X" / "Honda 150cc"
  courier_type  TEXT NOT NULL DEFAULT 'boda' CHECK (courier_type IN ('boda','g4s')),
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- Organizations (e.g. a courier firm that collects the customer's payment and remits it later).
  -- A rider never handles customer money. kind never changes after creation (enforced in couriers.service.js).
  kind               TEXT NOT NULL DEFAULT 'rider' CHECK (kind IN ('rider','organization')),
  collects_payment   INTEGER NOT NULL DEFAULT 0,
  contact_person     TEXT,
  overdue_limit      INTEGER CHECK (overdue_limit IS NULL OR overdue_limit >= 0),  -- cents; NULL = no limit
  overdue_after_days INTEGER NOT NULL DEFAULT 14 CHECK (overdue_after_days > 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_couriers_store ON couriers(store_id, is_active);

-- ---------------------------------------------------------------------
-- RIDER PAYABLES — what the business owes riders, kept apart from customer money.
--   package_fees  (defined with the organizations below) what a courier earns per dispatch. Entered at dispatch and
--                  owed whether or not the customer collects, so a return never cancels it. A rider's fee is paid here;
--                  an organization's fee is netted off its remittance instead (courier_payouts, statements).
--   courier_costs  extras (fuel, return trip, airtime...). Entered by one person, approved or rejected by ANOTHER;
--                  only an approved cost is owed.
--   rider_payouts / rider_payout_items  (separate from courier_payouts, which only nets organization fees) a payout lists every fee and cost it settles as its own line, and each item can
--                  be settled once (the UNIQUE indexes), so nothing is paid twice. Amounts are cents.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courier_costs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id         INTEGER NOT NULL REFERENCES stores(id),
  courier_id       INTEGER NOT NULL REFERENCES couriers(id),
  order_id         INTEGER REFERENCES orders(id),
  kind             TEXT NOT NULL CHECK (kind IN ('return_trip','fuel','airtime','handling','repair','other')),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  description      TEXT NOT NULL,
  receipt_ref      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  recorded_by      INTEGER NOT NULL REFERENCES users(id),
  decided_by       INTEGER REFERENCES users(id),
  decided_at       TEXT,
  decision_reason  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (decided_by IS NULL OR decided_by != recorded_by)   -- the second pair of eyes, enforced in the database too
);
CREATE INDEX IF NOT EXISTS idx_courier_costs_courier ON courier_costs(courier_id, status);

CREATE TABLE IF NOT EXISTS rider_payouts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id            INTEGER NOT NULL REFERENCES stores(id),
  courier_id          INTEGER NOT NULL REFERENCES couriers(id),
  fees_total          INTEGER NOT NULL CHECK (fees_total >= 0),
  costs_total         INTEGER NOT NULL CHECK (costs_total >= 0),
  total               INTEGER NOT NULL CHECK (total > 0),
  method              TEXT NOT NULL CHECK (method IN ('mpesa','bank','cash')),
  payment_ref         TEXT,
  paid_by             INTEGER NOT NULL REFERENCES users(id),
  fees_expense_id     INTEGER REFERENCES expenses(id),   -- mirrored into expenses, fees and costs on separate lines
  costs_expense_id    INTEGER REFERENCES expenses(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rider_payouts_courier ON rider_payouts(courier_id, created_at);

CREATE TABLE IF NOT EXISTS rider_payout_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id        INTEGER NOT NULL REFERENCES rider_payouts(id),
  package_fee_id   INTEGER UNIQUE REFERENCES package_fees(id),
  courier_cost_id  INTEGER UNIQUE REFERENCES courier_costs(id),
  amount           INTEGER NOT NULL CHECK (amount >= 0),
  CHECK ((package_fee_id IS NULL) != (courier_cost_id IS NULL))   -- exactly one of the two
);
CREATE INDEX IF NOT EXISTS idx_rider_payout_items_payout ON rider_payout_items(payout_id);

-- ---------------------------------------------------------------------
-- TWO-FACTOR (SMS one-time codes) for users with users.two_factor_enabled = 1.
-- Codes are never stored: only an HMAC (keyed with JWT_SECRET) of token+code,
-- so a leaked database can't be turned back into valid codes.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_challenges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  token         TEXT NOT NULL UNIQUE,     -- random, handed to the browser to identify THIS login attempt
  code_hmac     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  resend_count  INTEGER NOT NULL DEFAULT 0,
  consumed_at   TEXT,
  sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_challenges(user_id, created_at);

-- ---------------------------------------------------------------------
-- WEB-FORM LEAD ROUTING (WordPress/WPForms etc.). A form's NAME maps to the
-- product it advertises and, optionally, a fixed rep. Replaces the older
-- system's implicit "form name must equal product name" rule with an explicit,
-- editable mapping.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_form_routes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id          INTEGER NOT NULL REFERENCES stores(id),
  form_name         TEXT NOT NULL,
  product_id        INTEGER REFERENCES products(id),
  assigned_staff_id INTEGER REFERENCES users(id),
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_form_routes_name ON lead_form_routes(store_id, lower(form_name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external ON leads(store_id, source, external_id) WHERE external_id IS NOT NULL;

-- One imported online order can only ever become ONE fulfilment order per connection.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external ON orders(income_source_id, external_order_id)
  WHERE income_source_id IS NOT NULL AND external_order_id IS NOT NULL;

-- Replaced by idx_orders_external (per connection). The old key (channel, external id) made two
-- WooCommerce sites collide whenever they both had an order with the same number (#700 on each).
DROP INDEX IF EXISTS idx_orders_external_dedup;

-- ---------------------------------------------------------------------
-- LIVE SYNC. Webhooks we have registered on a store (so we can remove them again), and a log of
-- every delivery we received (so "is live sync working?" has an answer, and a replayed delivery
-- is recognised and ignored).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS income_source_webhooks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  income_source_id INTEGER NOT NULL REFERENCES income_sources(id) ON DELETE CASCADE,
  topic            TEXT NOT NULL,
  remote_id        TEXT,                       -- the store's id for the webhook
  address          TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (income_source_id, topic)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  income_source_id INTEGER REFERENCES income_sources(id) ON DELETE CASCADE,
  topic            TEXT NOT NULL,
  delivery_id      TEXT,                       -- the store's own id for this delivery (a retry reuses it)
  status           TEXT NOT NULL CHECK (status IN ('processed','ignored','failed','duplicate')),
  detail           TEXT,                       -- what happened, or why it failed
  received_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_delivery ON webhook_events(income_source_id, delivery_id) WHERE delivery_id IS NOT NULL AND status IN ('processed','ignored');
CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(income_source_id, received_at);

-- ---------------------------------------------------------------------
-- STOCK CAN NEVER BE SOLD BELOW ZERO  (last line of defence)
-- The application checks stock before every sale/dispatch; these triggers make the
-- database itself refuse any change that would take a quantity below zero, whichever
-- code path tries it. A row that is ALREADY negative (older data) can still be raised
-- towards zero by a restock - only a further decrease into/within negative is blocked.
-- ---------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_inventory_no_oversell
BEFORE UPDATE OF quantity ON inventory
WHEN NEW.quantity < 0 AND NEW.quantity < OLD.quantity
BEGIN
  SELECT RAISE(ABORT, 'Insufficient stock: quantity cannot go below zero.');
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_no_negative_insert
BEFORE INSERT ON inventory
WHEN NEW.quantity < 0
BEGIN
  SELECT RAISE(ABORT, 'Insufficient stock: quantity cannot go below zero.');
END;


-- ---------------------------------------------------------------------
-- COURIER ORGANIZATIONS — firms that collect the customer's payment and remit it later.
-- Ported from the update branch's server/src/couriers/organizations.ts, without its ledger:
-- an organization's receivable is COLLECTED minus (REMITTED + FEES NETTED) over its statements,
-- read from these tables (see services/courierOrganizations.service.js). All amounts are cents.
-- ---------------------------------------------------------------------

-- The fee we owe a courier organization for one dispatched parcel. One dispatch, one fee line;
-- a zero fee needs a reason. Written by orders.dispatch() when the order's courier is an organization.
CREATE TABLE IF NOT EXISTS package_fees (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  order_id     INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  courier_id   INTEGER NOT NULL REFERENCES couriers(id),
  amount       INTEGER NOT NULL CHECK (amount >= 0),
  zero_reason  TEXT,
  recorded_by  INTEGER NOT NULL REFERENCES users(id),
  recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount > 0 OR (zero_reason IS NOT NULL AND length(trim(zero_reason)) > 0))
);
CREATE INDEX IF NOT EXISTS idx_package_fees_courier ON package_fees(courier_id);

-- Money the organization collected from the customer for an order and now holds. Never edited or deleted.
CREATE TABLE IF NOT EXISTS org_collections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  courier_id    INTEGER NOT NULL REFERENCES couriers(id),
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  collected_on  TEXT NOT NULL,              -- the shop's calendar date, YYYY-MM-DD
  recorded_by   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_org_collections_courier ON org_collections(courier_id, collected_on);
CREATE INDEX IF NOT EXISTS idx_org_collections_order ON org_collections(order_id);
CREATE TRIGGER IF NOT EXISTS org_collections_no_update BEFORE UPDATE ON org_collections BEGIN SELECT RAISE(ABORT, 'org_collections are immutable'); END;
CREATE TRIGGER IF NOT EXISTS org_collections_no_delete BEFORE DELETE ON org_collections BEGIN SELECT RAISE(ABORT, 'org_collections are immutable'); END;

-- The package fees we owe, settled by netting them off a remittance. payout_items.package_fee_id is UNIQUE so a fee is paid once.
CREATE TABLE IF NOT EXISTS courier_payouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id),
  courier_id   INTEGER NOT NULL REFERENCES couriers(id),
  total        INTEGER NOT NULL CHECK (total > 0),
  method       TEXT NOT NULL CHECK (method IN ('netted_on_remittance')),
  payment_ref  TEXT,
  paid_by      INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payout_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id       INTEGER NOT NULL REFERENCES courier_payouts(id),
  package_fee_id  INTEGER NOT NULL UNIQUE REFERENCES package_fees(id),
  amount          INTEGER NOT NULL CHECK (amount > 0)
);

-- A settlement: expected (collections), charged (entered by staff vs our own fee records), received (remitted) and variance.
CREATE TABLE IF NOT EXISTS org_statements (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id             INTEGER NOT NULL REFERENCES stores(id),
  courier_id           INTEGER NOT NULL REFERENCES couriers(id),
  period_start         TEXT NOT NULL,
  period_end           TEXT NOT NULL,
  collections          INTEGER NOT NULL,
  charge_entered       INTEGER NOT NULL CHECK (charge_entered >= 0),
  fees                 INTEGER NOT NULL CHECK (fees >= 0),
  remitted             INTEGER NOT NULL CHECK (remitted >= 0),
  charge_variance      INTEGER NOT NULL,   -- charge entered - our package fees
  cash_variance        INTEGER NOT NULL,   -- collections - our fees - remitted; positive = still owed by the organization
  remittance_ref       TEXT,
  payout_id            INTEGER REFERENCES courier_payouts(id),
  created_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_org_statements_courier ON org_statements(courier_id);
CREATE TABLE IF NOT EXISTS org_statement_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id   INTEGER NOT NULL REFERENCES org_statements(id),
  collection_id  INTEGER NOT NULL UNIQUE REFERENCES org_collections(id),  -- a parcel is on one statement only
  secured        INTEGER NOT NULL CHECK (secured >= 0)  -- what this statement actually secured of the parcel (oldest first)
);
CREATE TRIGGER IF NOT EXISTS org_statements_no_update BEFORE UPDATE ON org_statements BEGIN SELECT RAISE(ABORT, 'org_statements are immutable'); END;
CREATE TRIGGER IF NOT EXISTS org_statements_no_delete BEFORE DELETE ON org_statements BEGIN SELECT RAISE(ABORT, 'org_statements are immutable'); END;

-- ---------------------------------------------------------------------
-- SHOP CASH CUSTODY. Cash taken at the shop is held by the staff member who took it until it is deposited
-- or handed to the till. Ported from the update branch's orders/custody.ts (no ledger here). Open custody
-- ages on the money-at-risk page. The amount, holder and order never change, and a deposited record is
-- closed for good; records are never deleted.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custody_records (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id           INTEGER NOT NULL REFERENCES stores(id),
  holder_staff_id    INTEGER NOT NULL REFERENCES users(id),
  order_id           INTEGER NOT NULL REFERENCES orders(id),
  payment_record_id  INTEGER NOT NULL UNIQUE REFERENCES payment_records(id),
  amount             INTEGER NOT NULL CHECK (amount > 0),     -- integer cents
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','deposited')),
  opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deposited_by       INTEGER REFERENCES users(id),
  deposited_at       TEXT,
  CHECK ((status = 'open' AND deposited_by IS NULL AND deposited_at IS NULL)
      OR (status = 'deposited' AND deposited_by IS NOT NULL AND deposited_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_custody_open ON custody_records(store_id, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_custody_order ON custody_records(order_id);
CREATE TRIGGER IF NOT EXISTS custody_closed_never_changes BEFORE UPDATE ON custody_records WHEN OLD.status = 'deposited'
BEGIN SELECT RAISE(ABORT, 'a deposited custody record never changes'); END;
CREATE TRIGGER IF NOT EXISTS custody_fields_never_change BEFORE UPDATE ON custody_records
WHEN NEW.amount <> OLD.amount OR NEW.holder_staff_id <> OLD.holder_staff_id OR NEW.order_id <> OLD.order_id
  OR NEW.store_id <> OLD.store_id OR NEW.payment_record_id <> OLD.payment_record_id OR NEW.opened_at <> OLD.opened_at OR NEW.reason <> OLD.reason
BEGIN SELECT RAISE(ABORT, 'custody amount, holder and order never change'); END;
CREATE TRIGGER IF NOT EXISTS custody_no_delete BEFORE DELETE ON custody_records
BEGIN SELECT RAISE(ABORT, 'custody records cannot be deleted'); END;

-- ---------------------------------------------------------------------
-- LOCKED PAYROLL RUNS. Ported from the update branch's payroll/runs.ts (Rule 9: a locked run never changes).
-- Until now payroll was computed live and kept no snapshot, so last month's pay moved whenever settings or
-- records changed. A run covers one period for everyone on payroll:
--   draft     calculated and saved; can be regenerated as often as you like
--   approved  LOCKED: figures frozen, fingerprinted (checksum), and every order commissioned is recorded so
--             none can ever earn commission twice
--   paid      LOCKED and paid
-- SQLite has no exclusion constraints or row-to-json diffing, so the guards below are triggers. All amounts
-- are integer cents; staff are users.id.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  period_start   TEXT NOT NULL,                -- shop date, YYYY-MM-DD
  period_end     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT,
  checksum       TEXT,                         -- sha256 of every figure in the run at approval; re-verifiable any time
  paid_by        INTEGER REFERENCES users(id),
  paid_at        TEXT,
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('mpesa','bank','cash')),
  payment_ref    TEXT,
  CHECK (period_end >= period_start),
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND checksum IS NOT NULL)),
  CHECK (status <> 'paid' OR (paid_by IS NOT NULL AND paid_at IS NOT NULL AND payment_method IS NOT NULL)),
  CHECK (status <> 'draft' OR (approved_by IS NULL AND checksum IS NULL AND paid_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_one_draft_per_period ON payroll_runs(store_id, period_start, period_end) WHERE status = 'draft';

CREATE TABLE IF NOT EXISTS payroll_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL REFERENCES payroll_runs(id),
  staff_id              INTEGER NOT NULL REFERENCES users(id),
  staff_name            TEXT NOT NULL,
  days_worked           INTEGER NOT NULL CHECK (days_worked >= 0),
  retainer              INTEGER NOT NULL CHECK (retainer >= 0),
  units_sold            INTEGER NOT NULL CHECK (units_sold >= 0),
  achieved_sales        INTEGER NOT NULL CHECK (achieved_sales >= 0),   -- secured money only (Rule 8)
  target                INTEGER NOT NULL CHECK (target >= 0),
  achievement_bp        INTEGER NOT NULL CHECK (achievement_bp >= 0),   -- basis points, 10000 = 100%: no floating point
  tier                  TEXT CHECK (tier IS NULL OR tier IN ('<70%','70-80%','>=80%')),
  rate                  INTEGER NOT NULL CHECK (rate >= 0),             -- per unit, as it was when approved
  commission            INTEGER NOT NULL CHECK (commission >= 0),
  late                  INTEGER NOT NULL CHECK (late >= 0),
  absence               INTEGER NOT NULL CHECK (absence >= 0),
  missing_hours         INTEGER NOT NULL CHECK (missing_hours >= 0),
  advances              INTEGER NOT NULL CHECK (advances >= 0),
  loss_deductions       INTEGER NOT NULL CHECK (loss_deductions >= 0),
  gross                 INTEGER NOT NULL,
  deductions            INTEGER NOT NULL,
  net                   INTEGER NOT NULL,
  payable               INTEGER NOT NULL CHECK (payable >= 0),          -- what is actually paid out
  shortfall             INTEGER NOT NULL CHECK (shortfall >= 0),        -- deductions beyond earnings: what the person owes back
  UNIQUE (run_id, staff_id),
  CHECK (commission = units_sold * rate),
  CHECK (gross = retainer + commission),
  CHECK (deductions = late + absence + missing_hours + advances + loss_deductions),
  CHECK (net = gross - deductions),
  CHECK (payable = MAX(net, 0) AND shortfall = MAX(-net, 0))
);
CREATE TABLE IF NOT EXISTS payroll_item_lines (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id   INTEGER NOT NULL REFERENCES payroll_items(id),
  kind      TEXT NOT NULL CHECK (kind IN ('retainer_day','commission_order','late','absence','missing_hours','salary_advance','loss_deduction')),
  ref_date  TEXT,
  ref_text  TEXT,      -- the order reference, or the reason
  quantity  INTEGER,   -- hours late, hours missing, units sold
  amount    INTEGER NOT NULL CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_payroll_item_lines_item ON payroll_item_lines(item_id);

-- Every order commissioned in a locked run, once. The primary key means an order can never earn commission twice.
CREATE TABLE IF NOT EXISTS commissioned_orders (
  order_id    INTEGER PRIMARY KEY REFERENCES orders(id),
  run_id      INTEGER NOT NULL REFERENCES payroll_runs(id),
  staff_id    INTEGER NOT NULL REFERENCES users(id),
  units       INTEGER NOT NULL CHECK (units > 0),
  total       INTEGER NOT NULL CHECK (total > 0),
  secured_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commissioned_orders_run ON commissioned_orders(run_id);

-- A locked run can never be deleted.
CREATE TRIGGER IF NOT EXISTS payroll_runs_no_delete BEFORE DELETE ON payroll_runs WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'a locked payroll run can never be deleted'); END;
-- A paid run never changes again.
CREATE TRIGGER IF NOT EXISTS payroll_runs_paid_is_final BEFORE UPDATE ON payroll_runs WHEN OLD.status = 'paid'
BEGIN SELECT RAISE(ABORT, 'a paid payroll run never changes'); END;
-- Draft -> approved changes only the approval columns.
CREATE TRIGGER IF NOT EXISTS payroll_runs_approve_only BEFORE UPDATE ON payroll_runs WHEN OLD.status = 'draft'
  AND (NEW.status <> 'approved' OR NEW.store_id <> OLD.store_id OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.paid_by IS NOT NULL OR NEW.paid_at IS NOT NULL
       OR NEW.payment_method IS NOT NULL OR NEW.payment_ref IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'a draft payroll run can only be approved; approving cannot change anything else'); END;
-- Approved -> paid changes only the payment columns.
CREATE TRIGGER IF NOT EXISTS payroll_runs_pay_only BEFORE UPDATE ON payroll_runs WHEN OLD.status = 'approved'
  AND (NEW.status <> 'paid' OR NEW.store_id <> OLD.store_id OR NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.approved_by IS NOT OLD.approved_by
       OR NEW.approved_at IS NOT OLD.approved_at OR NEW.checksum IS NOT OLD.checksum)
BEGIN SELECT RAISE(ABORT, 'an approved payroll run can only be marked paid; paying cannot change anything else'); END;
-- Two locked runs can never cover the same day, so nobody is paid twice for it (the Postgres version used an exclusion constraint).
CREATE TRIGGER IF NOT EXISTS payroll_runs_locked_periods_dont_overlap BEFORE UPDATE ON payroll_runs
  WHEN OLD.status = 'draft' AND NEW.status = 'approved'
   AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.id <> NEW.id AND r.store_id = NEW.store_id AND r.status <> 'draft'
                  AND r.period_start <= NEW.period_end AND r.period_end >= NEW.period_start)
BEGIN SELECT RAISE(ABORT, 'PERIOD_LOCKED: another locked payroll run already covers part of this period'); END;
-- Items, lines and commissioned orders can only be written while their run is a draft; once approved they are frozen.
CREATE TRIGGER IF NOT EXISTS payroll_items_ins_locked BEFORE INSERT ON payroll_items
  WHEN (SELECT status FROM payroll_runs WHERE id = NEW.run_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'this payroll run is locked: its figures never change'); END;
CREATE TRIGGER IF NOT EXISTS payroll_items_upd_locked BEFORE UPDATE ON payroll_items
  WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) IS NOT 'draft' OR NEW.run_id <> OLD.run_id
BEGIN SELECT RAISE(ABORT, 'this payroll run is locked: its figures never change'); END;
CREATE TRIGGER IF NOT EXISTS payroll_items_del_locked BEFORE DELETE ON payroll_items
  WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'this payroll run is locked: its figures never change'); END;
CREATE TRIGGER IF NOT EXISTS payroll_item_lines_ins_locked BEFORE INSERT ON payroll_item_lines
  WHEN (SELECT r.status FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id WHERE i.id = NEW.item_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'this payroll run is locked: its figures never change'); END;
CREATE TRIGGER IF NOT EXISTS payroll_item_lines_upd_locked BEFORE UPDATE ON payroll_item_lines
  WHEN (SELECT r.status FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id WHERE i.id = OLD.item_id) IS NOT 'draft' OR NEW.item_id <> OLD.item_id
BEGIN SELECT RAISE(ABORT, 'this payroll run is locked: its figures never change'); END;
CREATE TRIGGER IF NOT EXISTS payroll_item_lines_del_locked BEFORE DELETE ON payroll_item_lines
  WHEN (SELECT r.status FROM payroll_items i JOIN payroll_runs r ON r.id = i.run_id WHERE i.id = OLD.item_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'this payroll run is locked: its figures never change'); END;
CREATE TRIGGER IF NOT EXISTS commissioned_orders_ins_locked BEFORE INSERT ON commissioned_orders
  WHEN (SELECT status FROM payroll_runs WHERE id = NEW.run_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'this payroll run is locked: its figures never change'); END;
CREATE TRIGGER IF NOT EXISTS commissioned_orders_no_update BEFORE UPDATE ON commissioned_orders BEGIN SELECT RAISE(ABORT, 'commissioned orders never change'); END;
CREATE TRIGGER IF NOT EXISTS commissioned_orders_no_delete BEFORE DELETE ON commissioned_orders BEGIN SELECT RAISE(ABORT, 'commissioned orders never change'); END;

-- ---------------------------------------------------------------------
-- NIGHTLY INTEGRITY RUNS. One row per run of integrity/checks.js (ported from the update branch's integrity job):
-- whether every data rule held, the violations it found, and what it looked at. Kept so the history is visible
-- and so a restart does not repeat a check that already ran today.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integrity_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at           TEXT NOT NULL DEFAULT (datetime('now')),
  source           TEXT NOT NULL DEFAULT 'nightly' CHECK (source IN ('nightly','cli')),
  ok               INTEGER NOT NULL CHECK (ok IN (0,1)),
  violation_count  INTEGER NOT NULL CHECK (violation_count >= 0),
  violations       TEXT NOT NULL,   -- JSON array
  counts           TEXT NOT NULL,   -- JSON object
  duration_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integrity_runs_ran_at ON integrity_runs(ran_at);

-- ---------------------------------------------------------------------
-- RATE LIMITS. The per-address counters behind the sign-in limiter (utils/sqliteRateLimitStore.js), kept in the
-- database so a restart does not reset them and every process sharing this file shares the count. A key is
-- "<scope>:<address>"; the window runs from the first hit and a hit after it ends starts a new one.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  key             TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,   -- epoch milliseconds
  count           INTEGER NOT NULL CHECK (count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start_ms);
