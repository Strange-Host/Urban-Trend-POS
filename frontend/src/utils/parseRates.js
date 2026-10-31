// Parses a pasted or uploaded delivery rate sheet into rows for POST /delivery-areas/import.
// One CSV line -> fields, honouring "quoted, values".
function splitCsv(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// "area, fee[, courier][, notes]" per line; a header row (non-numeric fee) is skipped.
export function parseRates(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length && Number.isNaN(parseFloat(String(splitCsv(lines[0])[1]).replace(/[, ]/g, '')))) lines.shift();
  return lines.map((l) => {
    const [area_name, fee, courier_type, notes] = splitCsv(l);
    return { area_name, fee, courier_type: courier_type || null, notes: notes || null };
  });
}
