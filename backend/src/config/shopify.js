const axios = require('axios');

// Shopify retired the "create a custom app straight in Admin → copy the
// token" flow on Jan 1 2026 — new apps are created in the Shopify Dev
// Dashboard and get their Admin API access token via OAuth. Tokens minted
// by apps created before that date keep working unchanged. This client
// doesn't care which route the token came from: it just needs a shop
// domain + access token, either pasted in (legacy/manual) or produced by
// the OAuth exchange in shopifyOAuth.service.js.
const DEFAULT_API_VERSION = '2026-01';

/**
 * @param {object} [source] An income_sources row (or env-shaped equivalent).
 *   If omitted, falls back to SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN env vars
 *   for backwards compatibility with the original single-store setup.
 */
function getClient(source) {
  const shop = source?.shop_domain || process.env.SHOPIFY_SHOP;
  const token = source?.access_token || process.env.SHOPIFY_ACCESS_TOKEN;
  const version = source?.api_version || process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;

  if (!shop || !token) {
    if (source) {
      throw new Error(`"${source.name}" isn't connected yet — click "Connect" in Settings after saving the shop domain, API key, and API secret.`);
    }
    throw new Error('SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN must be set (or connect a Shopify income source in Settings) to use Shopify sync.');
  }

  return axios.create({
    baseURL: `https://${shop}/admin/api/${version}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

/**
 * Fetches ALL products (with variants) from Shopify, following cursor-based
 * pagination via the Link header. Shopify rate-limits at ~2 req/sec on the
 * standard REST bucket, so we pace requests with a small delay.
 */
async function fetchAllProducts(source) {
  const client = getClient(source);
  let products = [];
  let url = '/products.json?limit=250';

  while (url) {
    const res = await client.get(url);
    products = products.concat(res.data.products);

    const link = res.headers.link || res.headers.Link;
    const nextMatch = link && link.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      // The Link header gives a full URL; strip the baseURL prefix since axios re-adds it.
      const full = nextMatch[1];
      url = full.replace(client.defaults.baseURL, '');
      await new Promise((r) => setTimeout(r, 550)); // stay under the rate limit
    } else {
      url = null;
    }
  }

  return products;
}

/**
 * Fetches orders, following the Link-header cursor until there are no more.
 *
 *   createdSince - only orders CREATED at/after this ISO time (use for a history
 *                  backfill: "give me the last N days").
 *   updatedSince - only orders created OR CHANGED at/after this ISO time (use for
 *                  the regular incremental sync, so a cancellation or refund of
 *                  an older order is picked up too, not just brand-new orders).
 *
 * Shopify only exposes the last 60 days of orders to an app unless it has been
 * granted the read_all_orders scope - ANY date filter, however old, is silently
 * clamped to that window. The caller reports this (see salesSync.service.js).
 *
 * (A bare ISO string is still accepted as createdSince, for old callers.)
 */
async function fetchOrders(source, filters = {}) {
  const { createdSince, updatedSince } = typeof filters === 'string' ? { createdSince: filters } : filters;
  const client = getClient(source);
  let orders = [];
  const params = ['limit=250', 'status=any'];
  if (createdSince) params.push(`created_at_min=${encodeURIComponent(createdSince)}`);
  if (updatedSince) params.push(`updated_at_min=${encodeURIComponent(updatedSince)}`);
  let url = `/orders.json?${params.join('&')}`;

  while (url) {
    const res = await client.get(url);
    orders = orders.concat(res.data.orders);

    const link = res.headers.link || res.headers.Link;
    const nextMatch = link && link.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      url = nextMatch[1].replace(client.defaults.baseURL, '');
      await new Promise((r) => setTimeout(r, 550));
    } else {
      url = null;
    }
  }

  return orders;
}

/** How many orders Shopify will show this app (honours the 60-day window). Needs read_orders. */
async function countOrders(source) {
  const client = getClient(source);
  const res = await client.get('/orders/count.json?status=any');
  return res.data.count;
}

/** Lightweight call used by "Test connection" in Settings — cheap and read-only. */
async function ping(source) {
  const client = getClient(source);
  const res = await client.get('/shop.json');
  return res.data.shop;
}

/** Webhooks already registered on the shop (id, topic, address). */
async function listWebhooks(source) {
  const res = await getClient(source).get('/webhooks.json?limit=250');
  return res.data.webhooks || [];
}

/** Subscribes the shop to `topic`, delivering JSON to `address`. Returns the webhook (with its id). */
async function createWebhook(source, topic, address) {
  const res = await getClient(source).post('/webhooks.json', { webhook: { topic, address, format: 'json' } });
  return res.data.webhook;
}

async function updateWebhookAddress(source, id, address) {
  const res = await getClient(source).put(`/webhooks/${id}.json`, { webhook: { id, address } });
  return res.data.webhook;
}

async function deleteWebhook(source, id) {
  await getClient(source).delete(`/webhooks/${id}.json`);
}

module.exports = { listWebhooks, createWebhook, updateWebhookAddress, deleteWebhook, getClient, fetchAllProducts, fetchOrders, countOrders, ping, DEFAULT_API_VERSION };
