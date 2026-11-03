// Version strings for the mobile app: "1.2.3" (a leading "v" and a "-beta" style suffix are tolerated and ignored).
// Anything that is not a dotted run of numbers is "not a version", never a guess.

/** [major, minor, patch] or null. Missing parts count as 0 ("1.2" = 1.2.0). */
function parse(v) {
  const m = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+].*)?$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

const isVersion = (v) => parse(v) !== null;

/** -1, 0 or 1; null when either side is not a version. */
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

module.exports = { parse, isVersion, compare };
