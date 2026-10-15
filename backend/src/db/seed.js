const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/db');

// A password strong enough to not need memorizing (it's one-time, forced
// to change on first login), short enough to actually read off a
// terminal. base64url avoids characters that break copy-pasting from a
// console (+, /, =).
function generateOneTimePassword() {
  return crypto.randomBytes(15).toString('base64url'); // 20 chars, ~120 bits of entropy
}

function seed() {
  const storeCount = db.prepare('SELECT COUNT(*) c FROM stores').get().c;
  let storeId;
  if (storeCount === 0) {
    storeId = db
      .prepare('INSERT INTO stores (name, address) VALUES (?, ?)')
      .run('Urban Trends — Main Branch', 'Nairobi, Kenya').lastInsertRowid;
    console.log('Created default store.');
  } else {
    storeId = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
  }

  const adminEmail = 'admin@urbantrends.com';
  const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    // 2.1 — a hardcoded password here means every single install of this
    // app ships with the same well-known admin credential until someone
    // remembers to change it. Test environments are the one deliberate
    // exception: the whole test suite logs in as this admin, so a random
    // password (and a forced must-change gate that would then block every
    // other authenticated call) would break every test file rather than
    // make anything safer — nobody's exploiting a password that only ever
    // exists inside a throwaway in-memory test database.
    const isTestEnv = process.env.NODE_ENV === 'test';
    const rawPassword = isTestEnv ? 'ChangeMe123!' : generateOneTimePassword();
    const passwordHash = bcrypt.hashSync(rawPassword, 10);
    // No register PIN: a well-known default PIN would let anyone who knows it sign in as admin.
    // An admin can set one for a cashier later (Staff page).
    const pinHash = null;
    db.prepare(
      `INSERT INTO users (store_id, name, email, password_hash, pin_code_hash, role, must_change_password)
       VALUES (?, ?, ?, ?, ?, 'admin', ?)`
    ).run(storeId, 'Store Admin', adminEmail, passwordHash, pinHash, isTestEnv ? 0 : 1);
    if (isTestEnv) {
      console.log(`Created admin user: ${adminEmail} / ChangeMe123!`);
    } else {
      console.log('='.repeat(60));
      console.log('Created admin user — SAVE THIS PASSWORD, it is shown once:');
      console.log(`  Email:    ${adminEmail}`);
      console.log(`  Password: ${rawPassword}`);
      console.log('  You will be required to change it on first login.');
      console.log('='.repeat(60));
    }
  }

  const expenseCatCount = db.prepare('SELECT COUNT(*) c FROM expense_categories').get().c;
  if (expenseCatCount === 0) {
    const insertExpCat = db.prepare('INSERT INTO expense_categories (name) VALUES (?)');
    ['Rent', 'Utilities', 'Supplies', 'Wages', 'Other'].forEach((name) => insertExpCat.run(name));
    console.log('Seeded default expense categories.');
  }

  const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
  if (catCount === 0) {
    const insertCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
    const apparel = insertCat.run('Apparel').lastInsertRowid;
    const footwear = insertCat.run('Footwear').lastInsertRowid;
    const accessories = insertCat.run('Accessories').lastInsertRowid;

    const insertProduct = db.prepare(`
      INSERT INTO products (sku, barcode, name, category_id, brand, cost_price, sell_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInventory = db.prepare(`
      INSERT INTO inventory (product_id, store_id, quantity, reorder_level) VALUES (?, ?, ?, ?)
    `);
    // Every other inventory.quantity write in the app pairs with an
    // inventory_movements row (that's what the reconciliation job checks
    // against) — seeded starting stock needs the same, or reconciliation
    // would flag every freshly-seeded product as "drifted" on day one.
    const insertInitialMovement = db.prepare(`
      INSERT INTO inventory_movements (product_id, store_id, change_qty, reason) VALUES (?, ?, ?, 'restock')
    `);

    // cost/sell are now in cents (smallest KES subunit) — e.g. 90000 = KES 900.00.
    const sampleProducts = [
      ['UT-TSH-001', '600000000001', 'Classic Crew T-Shirt', apparel, 'Urban Trends', 40000, 90000, 50],
      ['UT-JNS-001', '600000000002', 'Slim Fit Denim Jeans', apparel, 'Urban Trends', 120000, 280000, 30],
      ['UT-SNK-001', '600000000003', 'Street Runner Sneakers', footwear, 'Urban Trends', 200000, 450000, 20],
      ['UT-CAP-001', '600000000004', 'Logo Snapback Cap', accessories, 'Urban Trends', 30000, 75000, 40],
      ['UT-BLT-001', '600000000005', 'Leather Belt', accessories, 'Urban Trends', 35000, 80000, 25],
    ];
    for (const [sku, barcode, name, catId, brand, cost, sell, qty] of sampleProducts) {
      const productId = insertProduct.run(sku, barcode, name, catId, brand, cost, sell).lastInsertRowid;
      insertInventory.run(productId, storeId, qty, 5);
      insertInitialMovement.run(productId, storeId, qty);
    }
    console.log('Seeded categories, products, and inventory.');
  }

  console.log('Seed complete.');
}

seed();
