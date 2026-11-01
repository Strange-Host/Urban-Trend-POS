'use strict';

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const ApiError = require('./ApiError');

// Protects the requests this server makes to ADDRESSES AN ADMIN TYPED IN (a Shopify shop, a WooCommerce site, the
// "check my public address" button). Without it those fields could point the server at its own internals - the
// cloud metadata service, localhost, the private network - or send Shopify credentials to a host that is not Shopify.
//
// Two policies, because the three uses differ:
//   'public'   a real internet site: loopback, private, link-local, CGNAT, multicast and similar are all refused.
//              Used for Shopify and WooCommerce. A WooCommerce site genuinely on the shop's own LAN can opt out
//              with ALLOW_PRIVATE_OUTBOUND=true.
//   'metadata' only the dangerous special ranges (cloud metadata / link-local, unspecified, multicast) are refused.
//              Used by the "check this address" probe, which legitimately points at the shop's own LAN or a tunnel.
//
// Two layers: IP-literal hosts are checked up front, and every hostname is checked again when it is actually
// resolved to connect (the agents' `lookup`) - so DNS tricks, rebinding and redirects to an internal name are covered.

function list(v4, v6) {
  const l = new net.BlockList();
  for (const [a, p] of v4) l.addSubnet(a, p, 'ipv4');
  for (const [a, p] of v6) l.addSubnet(a, p, 'ipv6');
  return l;
}

const BLOCKED = {
  public: list(
    [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
      ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]],
    [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]],
  ),
  metadata: list(
    [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4]],
    [['::', 128], ['fe80::', 10], ['ff00::', 8], ['fd00:ec2::', 32]],
  ),
};

function effectivePolicy(policy) {
  if (policy === 'public' && String(process.env.ALLOW_PRIVATE_OUTBOUND).toLowerCase() === 'true') return 'metadata';
  return policy;
}

/** True when `ip` (a literal address) may not be contacted under `policy`. IPv4-mapped IPv6 is judged as IPv4. */
function isBlockedAddress(ip, policy = 'public') {
  const list_ = BLOCKED[effectivePolicy(policy)];
  const family = net.isIP(ip);
  if (!family) return false;
  return list_.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function blockedMessage(host, policy) {
  return policy === 'public'
    ? `${host} is a private or internal address. Use the store's real public web address.`
    : `${host} is a reserved address that this server will not contact.`;
}

/** Throws a 400 when the host of `urlOrHost` is an IP literal this policy forbids (hostnames are checked at connect time). */
function assertAllowedHost(urlOrHost, policy = 'public') {
  let host = String(urlOrHost || '');
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname; } catch (_) { throw new ApiError(400, 'That is not a valid web address.'); }
  host = host.replace(/^\[|\]$/g, '');
  if (isBlockedAddress(host, policy)) throw new ApiError(400, blockedMessage(host, effectivePolicy(policy)));
}

function makeLookup(policy) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const found = Array.isArray(address) ? address.map((a) => a.address) : [address];
      const bad = found.find((ip) => isBlockedAddress(ip, policy));
      if (bad) return callback(Object.assign(new Error(blockedMessage(`${hostname} (${bad})`, effectivePolicy(policy))), { code: 'EBLOCKED' }));
      return callback(null, address, family);
    });
  };
}

const agentCache = {};
function agentsFor(policy) {
  if (!agentCache[policy]) {
    agentCache[policy] = {
      httpAgent: new http.Agent({ lookup: makeLookup(policy) }),
      httpsAgent: new https.Agent({ lookup: makeLookup(policy) }),
    };
  }
  return agentCache[policy];
}

/**
 * Spread into an axios request/instance config: `axios.create({ baseURL, ...guardedAxiosOptions(baseURL) })`.
 * Checks an IP-literal host now and installs the connect-time DNS check for everything else.
 */
function guardedAxiosOptions(urlOrHost, policy = 'public') {
  assertAllowedHost(urlOrHost, policy);
  return agentsFor(policy);
}

// ---- Shopify ----------------------------------------------------------------------------------------------------
// The Admin API (and the token exchange that carries the app's client id and secret) only exists on
// <shop>.myshopify.com, so anything else is either a typo or an attempt to send those credentials elsewhere.
const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function isShopifyDomain(value) {
  return SHOPIFY_DOMAIN.test(String(value || ''));
}

function assertShopifyDomain(value) {
  if (!isShopifyDomain(String(value || '').toLowerCase())) {
    throw new ApiError(400, 'The shop domain must look like your-store.myshopify.com (the address Shopify gave your store, not a custom domain).');
  }
}

module.exports = { isBlockedAddress, assertAllowedHost, guardedAxiosOptions, isShopifyDomain, assertShopifyDomain };
