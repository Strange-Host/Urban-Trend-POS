// Tiny matcher for the Ctrl+K palette.
// 0 = no match. Higher is better: a name that starts with the text beats one that merely contains it, which beats
// the letters appearing in order ("rcn" -> Reconciliation), which beats a match on the hidden keywords only.
export function score(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (t.startsWith(q)) return 100;
  const at = t.indexOf(q);
  if (at >= 0) return at === 0 || t[at - 1] === ' ' ? 90 : 70;
  let i = 0;
  for (const ch of t) { if (ch === q[i]) i += 1; if (i === q.length) break; }
  return i === q.length && q.length >= 2 ? 30 : 0;
}

export function rank(entry, query) {
  const best = Math.max(score(entry.label, query), score(entry.group || '', query) / 2);
  if (best > 0) return best;
  // hidden keywords: whole words only, so "pos" doesn't match everything containing the letters p-o-s
  const words = (entry.keywords || '').toLowerCase().split(/\s+/);
  const q = query.toLowerCase().trim();
  return words.some((w) => w.startsWith(q)) ? 20 : 0;
}

