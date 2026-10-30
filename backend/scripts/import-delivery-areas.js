#!/usr/bin/env node
// `npm run import-delivery-areas -- rates.csv`: load the Joyfull Cargo rate card into the delivery-area table.
// CSV columns (header row optional): area, fee in KES, [courier boda|g4s], [notes]. Re-running with a corrected
// sheet updates existing areas instead of duplicating them. Nothing is written if any row is invalid.
require('dotenv').config();
const fs = require('fs');

function parseCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const file = process.argv[2];
if (!file) { console.error('Usage: npm run import-delivery-areas -- <rates.csv>'); process.exit(2); }

require('../src/db/migrate');
const { importRows } = require('../src/services/deliveryAreas.service');

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const looksLikeHeader = lines.length && Number.isNaN(parseFloat(String(parseCsvLine(lines[0])[1]).replace(/[, ]/g, '')));
const rows = (looksLikeHeader ? lines.slice(1) : lines).map((l) => {
  const [area_name, fee, courier_type, notes] = parseCsvLine(l);
  return { area_name, fee, courier_type: courier_type || null, notes: notes || null };
});

try {
  const result = importRows({ staffId: null, rows });
  console.log(`Delivery areas: ${result.created} added, ${result.updated} updated (${result.total} rows).`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
