'use strict';

const jwt = require('jsonwebtoken');

// Who a request counts against, for the general and checkout limiters.
//
// Every till in a shop reaches the server through the same public IP, so counting per IP makes ten registers share
// one budget and polling alone (bell, shift widget, Orders, Sales History) can use it up, returning 429 to everybody
// at once. A signed-in request is therefore counted against the person (their access token's user id), so each
// register has its own allowance.
//
// Safety: the token is verified with the server secret, so a made-up or tampered token can't pick its own bucket.
// Anything that doesn't verify (no token, expired, forged) falls back to the IP address, so unauthenticated floods
// are still limited per address exactly as before. A real token can't dodge the limit either: it always lands in the
// same per-user bucket, whatever address it comes from.
function userOrIpKey(req) {
  if (req.user && req.user.id != null) return `user:${req.user.id}`;   // routes behind authenticate()
  const header = req.headers && req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
      if (payload && payload.id != null) return `user:${payload.id}`;
    } catch (_) { /* not a valid token: count it against the address instead */ }
  }
  return `ip:${req.ip}`;
}

module.exports = { userOrIpKey };
