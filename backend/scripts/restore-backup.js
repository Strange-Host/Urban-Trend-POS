#!/usr/bin/env node
/*
 * Opens an encrypted backup (the .db.gz.enc files that arrive by email) and checks it is sound - a "trial restore".
 *
 *   cd backend
 *   BACKUP_PASSPHRASE="your passphrase" node scripts/restore-backup.js ~/Downloads/urban_trends-2026-10-20.db.gz.enc
 *
 * If BACKUP_PASSPHRASE is not set it uses ENCRYPTION_KEY from the environment/.env (the key the backups were made with).
 * Writes the decrypted database next to the file (or to --out), then prints whether it is intact and what it holds.
 * It never touches your live database. To actually restore, stop the app and replace the live database file with it.
 */
'use strict';
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* dotenv is optional here */ }
const { decryptFile, verifyDatabase, passphraseFromEnv } = require('../src/utils/backupCrypto');

(async () => {
  const args = process.argv.slice(2);
  const src = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  if (!src) { console.error('Usage: node scripts/restore-backup.js <backup.db.gz.enc> [--out restored.db]'); process.exit(1); }
  const out = outIdx >= 0 ? args[outIdx + 1] : path.join(path.dirname(path.resolve(src)), `${path.basename(src).replace(/\.gz\.enc$|\.enc$/, '')}.restored.db`);

  const { value, source } = passphraseFromEnv();
  console.log(`Using the passphrase from ${source}.`);
  await decryptFile(src, out, value);
  console.log(`Decrypted to ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB).`);

  const r = verifyDatabase(out);
  console.log(`\nDatabase check: ${r.ok ? 'OK - intact' : 'PROBLEM FOUND'}`);
  console.log(`  integrity: ${r.integrity}   foreign-key problems: ${r.foreignKeyProblems}`);
  console.log('  contents:', Object.entries(r.tables).map(([k, v]) => `${k}=${v ?? 'n/a'}`).join('  '));
  if (r.newestSale) console.log(`  newest sale in this backup: ${r.newestSale}`);
  console.log(r.ok ? '\nTRIAL RESTORE PASSED. This backup can be restored.' : '\nTRIAL RESTORE FAILED. Do not rely on this backup.');
  process.exit(r.ok ? 0 : 2);
})().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(2); });
