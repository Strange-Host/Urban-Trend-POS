const fs = require('fs');
const path = require('path');
const db = require('../config/db');

// Columns added after the original table was created. `CREATE TABLE IF NOT
// EXISTS` is a no-op on a table that already exists, so anyone with an
// existing database needs these backfilled by hand — this does it safely,
// column by column, without ever touching existing data.
const ADDITIVE_COLUMNS = {
  users: [
    `token_version INTEGER NOT NULL DEFAULT 1`,
    // Phase 7 (employee onboarding & e-signature) — 'active' default keeps
    // every existing user and everyone made via the plain POST /api/staff
    // endpoint unaffected; only POST /api/employees/onboard starts someone
    // at 'pending_documents'.
    `onboarding_status TEXT NOT NULL DEFAULT 'active' CHECK (onboarding_status IN ('pending_documents','pending_signature','active'))`,
    // 2.1 — defaults to 0 so every existing account (which already has a
    // real password someone chose) is completely unaffected; only newly
    // seeded/reset accounts with a one-time password get this set to 1.
    `must_change_password INTEGER NOT NULL DEFAULT 0`,
    // SMS one-time code at login (see services/twoFactor.service.js). Opt-in
    // per account, default off — nobody is affected until an admin enables it.
    `two_factor_enabled INTEGER NOT NULL DEFAULT 0`,
  ],
  leads: [
    // Web-form intake (services/leadIntake.service.js): the form's own entry
    // id makes a re-delivered webhook idempotent; the raw payload is kept so
    // nothing the customer typed is ever lost to a mapping gap.
    `external_id TEXT`,
    `form_name TEXT`,
    `raw_payload TEXT`,
    `interested_product_id INTEGER REFERENCES products(id)`,
  ],
  sales: [
    `external_updated_at TEXT`,   // the store's own 'last changed' time of the order - lets us ignore a stale, out-of-order webhook
    `source_type TEXT NOT NULL DEFAULT 'local'`,
    `income_source_id INTEGER REFERENCES income_sources(id)`,
    `external_order_id TEXT`,
    `external_order_number TEXT`,
    `synced_at TEXT`,
    // Offline register support — no inline UNIQUE (SQLite can't add a
    // UNIQUE column via ALTER TABLE); the guarantee comes from
    // idx_sales_client_sale_id in schema.sql, created by the index pass below.
    `client_sale_id TEXT`,
  ],
  shopify_staging_products: [
    `platform TEXT NOT NULL DEFAULT 'shopify'`,
    `income_source_id INTEGER REFERENCES income_sources(id)`,
    `category_id INTEGER REFERENCES categories(id)`,
  ],
  income_sources: [
    `token_expires_at TEXT`,
    // Live sync (services/liveSync.service.js): the store tells us about changes the moment they happen.
    `live_sync_enabled INTEGER NOT NULL DEFAULT 0`,
    `webhook_secret TEXT`,          // WooCommerce signs deliveries with a per-store secret we generate (encrypted at rest)
    `last_webhook_at TEXT`,
    `last_poll_at TEXT`,            // the safety-net poll (catches anything a webhook missed)
    `last_poll_error TEXT`,
  ],
  // Online-order Phase 1 (POS -> inventory management conversion, §2/§3):
  customers: [
    `phone_normalized TEXT`,
    `city TEXT`,
    `risk_flag TEXT NOT NULL DEFAULT 'none'`,
    `prepay_required INTEGER NOT NULL DEFAULT 0`,
    // No DEFAULT here deliberately — SQLite's ALTER TABLE ADD COLUMN rejects
    // a non-constant default like datetime('now') (unlike CREATE TABLE,
    // which allows it fine; that's why schema.sql's fresh-install version of
    // this column has one and this additive one doesn't). Backfilled by the
    // UPDATE just below instead; every future write goes through service
    // code that sets updated_at explicitly anyway.
    `updated_at TEXT`,
  ],
  payment_records: [
    `order_id INTEGER REFERENCES orders(id)`,
  ],
  // Phase 2 (courier, dispatch & COD confirmation gate):
  orders: [
    `payment_type TEXT NOT NULL DEFAULT 'cod' CHECK (payment_type IN ('cod','prepaid','g4s_pickup_pay'))`,
    `courier_type TEXT CHECK (courier_type IN ('boda','g4s'))`,
    `delivery_zone TEXT CHECK (delivery_zone IN ('nairobi','outside'))`,
    `delivery_fee INTEGER NOT NULL DEFAULT 0`,
    `courier_id INTEGER REFERENCES couriers(id)`, // a NAMED courier (couriers table); courier_type stays the fee/zone source of truth
    `income_source_id INTEGER REFERENCES income_sources(id)`,
    `sale_id INTEGER REFERENCES sales(id)`,
    `cod_confirmed_at TEXT`,
    `cod_confirmed_by INTEGER REFERENCES users(id)`,
    `cod_confirmation_expires_at TEXT`,
    // Phase 3 (payment reconciliation) — no inline UNIQUE (SQLite won't
    // allow adding a UNIQUE column via ALTER TABLE ADD COLUMN); the unique
    // guarantee comes from idx_orders_product_code in schema.sql instead.
    `product_code TEXT`,
    // Phase 4 (RMA — return reason codes & owner write-off/disposal decision):
    `return_reason TEXT CHECK (return_reason IN ('rejected','damaged','wrong_item'))`,
    `owner_notified_at TEXT`,
    `owner_decision TEXT CHECK (owner_decision IN ('write_off','dispose'))`,
    `owner_decision_by INTEGER REFERENCES users(id)`,
    `owner_decision_at TEXT`,
    `owner_decision_notes TEXT`,
    // Phase 8 (dispute management):
    `dispute_status TEXT CHECK (dispute_status IN ('open','resolved'))`,
    `dispute_reason TEXT`,
    `dispute_outcome TEXT CHECK (dispute_outcome IN ('refund','redelivered','closed'))`,
    `dispute_opened_by INTEGER REFERENCES users(id)`,
    `dispute_opened_at TEXT`,
    `dispute_resolved_by INTEGER REFERENCES users(id)`,
    `dispute_resolved_at TEXT`,
    `dispute_resolution_notes TEXT`,
  ],
  // Phase 6 (salary-advance requisitions §10):
  requisitions: [
    `type TEXT NOT NULL DEFAULT 'shop_operational' CHECK (type IN ('shop_operational','salary_advance'))`,
    `amount INTEGER`,
  ],
  // Payment gateway credentials (M-Pesa/KCB in Settings) + outgoing-money mirroring:
  payment_notifications: [
    `direction TEXT NOT NULL DEFAULT 'incoming' CHECK (direction IN ('incoming','outgoing'))`,
    `expense_id INTEGER REFERENCES expenses(id)`,
  ],
};

function ensureColumn(table, columnDef) {
  const columnName = columnDef.trim().split(/\s+/)[0];
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  const hasColumn = existing.some((c) => c.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    console.log(`  + added ${table}.${columnName}`);
  }
}

function tableExists(name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

// products.shopify_variant_id originally had an inline `UNIQUE` constraint —
// global across every connected store. Two different WooCommerce stores can
// legitimately both have a "product 15" (their ids are small, per-site
// sequential numbers, unlike Shopify's globally-unique ones), so a plain
// global UNIQUE either blocks importing the second store's product outright,
// or — before the income_source_id scoping fix that goes with this — could
// silently match and overwrite a different store's product entirely. Fixed
// by a composite unique index scoped by (income_source_id, shopify_variant_id).
//
// SQLite can't ALTER a column to drop an inline UNIQUE constraint — it has to
// be a full table rebuild. This is the standard SQLite-documented procedure
// for schema changes on a table other tables have foreign keys pointing at
// (https://www.sqlite.org/lang_altertable.html, "Making Other Kinds Of Table
// Schema Changes") — verified against this project's actual data shape
// (products -> inventory/sale_items/etc.) before shipping, because the
// naive approach (rename products out of the way, recreate fresh) silently
// rewrites every OTHER table's foreign key clause to point at the
// renamed-away copy instead, which then breaks when that copy is dropped.
// The fix is ordering: build the new shape under a temp name FIRST (old
// `products` untouched throughout), copy the data across, only THEN drop
// the old table and rename the temp one into place — foreign key clauses in
// dependent tables are never rewritten because `products` (the name they
// actually reference) is never the thing being renamed away.
function needsProductsRebuild() {
  if (!tableExists('products')) return false; // fresh install — schema.sql below creates it correctly already
  const indexes = db.prepare(`PRAGMA index_list(products)`).all();
  return indexes.some((idx) => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all();
    return cols.length === 1 && cols[0].name === 'shopify_variant_id';
  });
}

function rebuildProductsTable() {
  console.log('  Rebuilding products table to scope shopify_variant_id uniqueness per connected store...');
  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE products_pre_scoped_uniqueness_new (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        sku                         TEXT NOT NULL UNIQUE,
        barcode                     TEXT UNIQUE,
        name                        TEXT NOT NULL,
        description                 TEXT,
        category_id                 INTEGER REFERENCES categories(id),
        brand                       TEXT,
        cost_price                  REAL NOT NULL DEFAULT 0,
        sell_price                  REAL NOT NULL,
        tax_rate                    REAL NOT NULL DEFAULT 0,
        image_url                   TEXT,
        is_active                   INTEGER NOT NULL DEFAULT 1,
        shopify_product_id          TEXT,
        shopify_variant_id          TEXT,
        shopify_inventory_item_id   TEXT,
        shopify_synced_at           TEXT,
        income_source_id            INTEGER REFERENCES income_sources(id),
        created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const oldColumns = db.prepare(`PRAGMA table_info(products)`).all().map((c) => c.name);
    const cols = oldColumns.join(', '); // income_source_id (and any other new column) is absent from the
                                          // old table and so defaults to NULL — correctly meaning "not linked
                                          // to any specific connected store" for every pre-existing product.
    db.exec(`INSERT INTO products_pre_scoped_uniqueness_new (${cols}) SELECT ${cols} FROM products`);
    db.exec('DROP TABLE products');
    db.exec('ALTER TABLE products_pre_scoped_uniqueness_new RENAME TO products');
  });
  txn();

  const violations = db.pragma('foreign_key_check');
  if (violations.length > 0) {
    // Should be unreachable given the ordering above, but never silently
    // continue with broken referential integrity if it somehow happens.
    throw new Error(`products table rebuild left foreign key violations: ${JSON.stringify(violations)}`);
  }

  if (wasForeignKeysOn) db.pragma('foreign_keys = ON');
  console.log('  + products table rebuilt, all existing products preserved, foreign keys verified intact');
}

// inventory_movements.reason had an inline CHECK that didn't yet know about
// 'dispatch' / 'return_resellable' (added for the online-order lifecycle,
// §1 Phase 1), and reference_type is a brand-new column. Same story as
// products above: SQLite can't ALTER a CHECK constraint or add a CHECK to
// an existing column in place, so this is a table rebuild — same
// build-under-a-temp-name-first, copy, drop, rename ordering, for the same
// reason (other tables don't reference this one by FK, but the table name
// itself must never be vacated except for the instant between DROP and
// RENAME, in case anything ever does).
function needsInventoryMovementsRebuild() {
  if (!tableExists('inventory_movements')) return false; // fresh install — schema.sql creates it correctly already
  const columns = db.prepare(`PRAGMA table_info(inventory_movements)`).all();
  return !columns.some((c) => c.name === 'reference_type');
}

function rebuildInventoryMovementsTable() {
  console.log('  Rebuilding inventory_movements table to add reference_type and new dispatch/return reasons...');
  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE inventory_movements_add_reference_type_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id     INTEGER NOT NULL REFERENCES products(id),
        store_id       INTEGER NOT NULL REFERENCES stores(id),
        change_qty     INTEGER NOT NULL,
        reason         TEXT NOT NULL CHECK (reason IN (
          'sale','restock','adjustment','return','void','requisition',
          'dispatch','return_resellable'
        )),
        reference_type TEXT CHECK (reference_type IN ('sale','order','requisition','adjustment')),
        reference_id   INTEGER,
        created_by     INTEGER REFERENCES users(id),
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const oldColumns = db.prepare(`PRAGMA table_info(inventory_movements)`).all().map((c) => c.name);
    const cols = oldColumns.join(', '); // reference_type absent from the old table -> NULL for every
                                          // existing row, backfilled just below based on `reason`.
    db.exec(`INSERT INTO inventory_movements_add_reference_type_new (${cols}) SELECT ${cols} FROM inventory_movements`);
    db.exec('DROP TABLE inventory_movements');
    db.exec('ALTER TABLE inventory_movements_add_reference_type_new RENAME TO inventory_movements');

    // Backfill: existing rows only ever came from a sale (reason 'sale'/'void')
    // or a requisition (reason 'requisition') — 'restock'/'adjustment'/'return'
    // predate any reference_id convention worth guessing at, so they stay NULL.
    db.exec(`UPDATE inventory_movements SET reference_type = 'sale' WHERE reason IN ('sale','void')`);
    db.exec(`UPDATE inventory_movements SET reference_type = 'requisition' WHERE reason = 'requisition'`);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_movements_product ON inventory_movements(product_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_movements_reference ON inventory_movements(reference_type, reference_id)`);
  });
  txn();

  const violations = db.pragma('foreign_key_check');
  if (violations.length > 0) {
    throw new Error(`inventory_movements rebuild left foreign key violations: ${JSON.stringify(violations)}`);
  }
  if (wasForeignKeysOn) db.pragma('foreign_keys = ON');
  console.log('  + inventory_movements rebuilt: reference_type added and backfilled, dispatch/return_resellable reasons available');
}

// Currency columns were REAL (float dollars/KES) — moving to INTEGER cents
// (multiply by 100, round, store as a true integer) avoids float drift in
// SQL-level SUM() aggregations over many rows (reports.controller.js does
// this a lot) and removes the "REAL vs INTEGER money column" inconsistency
// that existed between this table and expenses/payment_records, which
// already used cents. The API layer converts back to decimal on the way
// out (see utils/money.js) — this is purely a storage-layer change, no
// API contract or frontend change needed.
//
// Rather than hand-transcribing each table's full CREATE TABLE DDL (risk
// of a transcription slip on a table this important), this pulls the
// table's actual current DDL straight from sqlite_master and surgically
// swaps REAL -> INTEGER only for the named currency columns, preserving
// every CHECK/DEFAULT/FK/UNIQUE clause exactly as SQLite itself has them.
// Same "build under a temp name first, rename into place last" ordering
// as rebuildProductsTable() above, and for the same reason: other tables'
// FK clauses reference this table by name, and that name must never be
// vacated except for the instant between DROP and RENAME.
const CURRENCY_COLUMNS = {
  products: ['cost_price', 'sell_price'],
  cash_sessions: ['opening_amount', 'closing_amount', 'expected_amount'],
  sales: ['subtotal', 'tax_total', 'discount_total', 'total'],
  sale_items: ['unit_price', 'discount', 'line_total'],
  payments: ['amount'],
  shopify_staging_products: ['sell_price'],
};

function migrateCurrencyColumnToCents(tableName, currencyColumns) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
  if (!row) return; // table doesn't exist yet — schema.sql below creates it correctly already

  const tempName = `${tableName}_cents_migration_tmp`;
  let newSql = row.sql.replace(new RegExp(`CREATE TABLE ${tableName}\\b`), `CREATE TABLE ${tempName}`);
  let anyChanged = false;
  for (const col of currencyColumns) {
    const pattern = new RegExp(`(\\b${col}\\s+)REAL\\b`);
    if (pattern.test(newSql)) {
      newSql = newSql.replace(pattern, '$1INTEGER');
      anyChanged = true;
    }
  }
  if (!anyChanged) return; // already migrated (or columns not found) — nothing to do

  console.log(`  Converting ${tableName}.[${currencyColumns.join(', ')}] from REAL to INTEGER cents...`);
  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');

  const txn = db.transaction(() => {
    db.exec(newSql);
    const oldColumns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
    const selectCols = oldColumns
      .map((c) => (currencyColumns.includes(c) ? `CAST(ROUND(${c} * 100) AS INTEGER) AS ${c}` : c))
      .join(', ');
    const insertCols = oldColumns.join(', ');
    db.exec(`INSERT INTO ${tempName} (${insertCols}) SELECT ${selectCols} FROM ${tableName}`);
    db.exec(`DROP TABLE ${tableName}`);
    db.exec(`ALTER TABLE ${tempName} RENAME TO ${tableName}`);
  });
  txn();

  const violations = db.pragma('foreign_key_check');
  if (violations.length > 0) {
    throw new Error(`${tableName} currency migration left foreign key violations: ${JSON.stringify(violations)}`);
  }
  if (wasForeignKeysOn) db.pragma('foreign_keys = ON');
  console.log(`  + ${tableName} currency columns converted, all rows preserved, foreign keys verified intact`);
}

// Phase 3 (payments): the Shopify integration originally had exactly one
// shop, configured via SHOPIFY_SHOP/SHOPIFY_ACCESS_TOKEN env vars —
// products.income_source_id and shopify_staging_products.income_source_id
// were NULL for everything it touched (see schema.sql's comment on
// products.income_source_id). Once income_sources (multi-store OAuth)
// shipped, BOTH paths stayed live side by side: syncing the same physical
// shop from the old env-var route AND from a configured income_sources
// row created two DIFFERENT keys (idx_products_variant_per_source scopes
// uniqueness by COALESCE(income_source_id, 0)) for the literal same
// Shopify variant — approving both created two separate product rows for
// one real item. Fixed by giving the env-var shop a real income_sources
// row (if it doesn't already have one) and re-pointing every orphaned
// NULL-income_source_id Shopify row at it, so there is only ever ONE id
// in play for that shop from here on — see routes/shopify.routes.js and
// controllers/shopify.controller.js, which now resolve to this same row
// instead of passing `undefined` through to pullFromShopify().
function migrateLegacyShopifyEnvToIncomeSource() {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) return; // nothing to migrate — legacy route was never configured

  if (!tableExists('income_sources')) return; // schema.sql above will have just created it fresh

  const normalizedShop = shop.trim().replace(/^https?:\/\//i, '').split('/')[0];
  const existing = db.prepare('SELECT id FROM income_sources WHERE platform = ? AND shop_domain = ?').get('shopify', normalizedShop);
  if (existing) return; // already migrated on a previous startup

  console.log(`  Migrating legacy SHOPIFY_SHOP env config ("${normalizedShop}") into a real income_sources row...`);
  const { encrypt } = require('../utils/crypto');
  const defaultStore = db.prepare('SELECT id FROM stores WHERE is_active = 1 ORDER BY id LIMIT 1').get();

  const result = db.prepare(`
    INSERT INTO income_sources (name, platform, store_id, shop_domain, access_token, api_version)
    VALUES (?, 'shopify', ?, ?, ?, ?)
  `).run(
    'Shopify (migrated from .env)',
    defaultStore ? defaultStore.id : null,
    normalizedShop,
    encrypt(token),
    process.env.SHOPIFY_API_VERSION || null
  );
  const newSourceId = result.lastInsertRowid;

  // Re-point every row this shop's syncs already produced under NULL —
  // both the staging queue (so nothing already pending gets orphaned) and
  // any already-approved products (so a future sync from either entry
  // point correctly matches and updates them instead of creating
  // duplicates). shopify_variant_id IS NOT NULL scopes this to
  // genuinely-Shopify-sourced products only, never a locally-created one.
  const stagingUpdated = db.prepare(`
    UPDATE shopify_staging_products SET income_source_id = ? WHERE platform = 'shopify' AND income_source_id IS NULL
  `).run(newSourceId).changes;
  const productsUpdated = db.prepare(`
    UPDATE products SET income_source_id = ? WHERE income_source_id IS NULL AND shopify_variant_id IS NOT NULL
  `).run(newSourceId).changes;

  console.log(`  + created income_sources row #${newSourceId} for "${normalizedShop}", re-pointed ${stagingUpdated} staging row(s) and ${productsUpdated} product(s) to it`);
}

function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  if (needsProductsRebuild()) {
    rebuildProductsTable();
  }

  if (needsInventoryMovementsRebuild()) {
    rebuildInventoryMovementsTable();
  }

  for (const [table, columns] of Object.entries(CURRENCY_COLUMNS)) {
    migrateCurrencyColumnToCents(table, columns);
  }

  // First pass: creates any brand-new tables (income_sources, settings,
  // etc.). On an EXISTING database this can fail partway through — e.g. the
  // new idx_sales_source index references sales.source_type, which doesn't
  // exist yet on an old table — so we don't let that stop us; we backfill
  // the missing columns below and run the whole file again.
  try {
    db.exec(schema);
  } catch (err) {
    console.log(`  (first pass hit "${err.message}" — backfilling columns and retrying)`);
  }

  for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
    if (!tableExists(table)) continue; // schema.sql above will have just created it fresh, already correct
    for (const columnDef of columns) {
      ensureColumn(table, columnDef);
    }
  }

  // customers.phone_normalized is additive — backfill it for any pre-existing
  // rows the same way leads already does it (last 9 digits, digits only),
  // so duplicate-customer-by-phone lookups work retroactively, not just for
  // customers created after this migration.
  if (tableExists('customers')) {
    db.exec(`
      UPDATE customers SET phone_normalized = substr(
        replace(replace(replace(replace(phone, '+', ''), '-', ''), ' ', ''), '(', ''), -9
      )
      WHERE phone IS NOT NULL AND (phone_normalized IS NULL OR phone_normalized = '')
    `);
    // updated_at has no ALTER-time default (see ADDITIVE_COLUMNS comment above) —
    // backfill it once here so pre-existing rows aren't left with a NULL that
    // a fresh install would never have.
    db.exec(`UPDATE customers SET updated_at = datetime('now') WHERE updated_at IS NULL`);
  }

  // Phase 3: any order created before product_code existed needs one
  // backfilled too, or it can never receive a reconciled payment. Same
  // deterministic construction orders.service.js uses for new orders
  // (UT + zero-padded id) — inherently unique since id is, so this is safe
  // to run even though the uniqueness guarantee itself lives in the index.
  if (tableExists('orders')) {
    db.exec(`
      UPDATE orders SET product_code = 'UT' || substr('000000' || id, -6, 6)
      WHERE product_code IS NULL
    `);
  }

  migrateLegacyShopifyEnvToIncomeSource();

  // Second pass: now that every column exists, this creates whatever indexes
  // (and any tables) the first pass couldn't reach. Safe to run every time —
  // everything in schema.sql is IF NOT EXISTS.
  db.exec(schema);

  console.log('Migration complete: schema applied.');
}

migrate();
