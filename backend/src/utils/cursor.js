// Opaque paging cursors for the mobile API: a small JSON object, base64url-encoded, so the app treats it as a token and
// the server is free to change what is inside. A cursor that cannot be read is simply "start from the top" - a stale
// cursor must never be an error screen.
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function decode(token) {
  if (!token || typeof token !== 'string') return null;
  try { const v = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
const pageSize = (raw, fallback = 30) => Math.min(Math.max(parseInt(raw, 10) || fallback, 1), 100);

module.exports = { encode, decode, pageSize };
