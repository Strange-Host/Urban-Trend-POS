const axios = require('axios');

// WooCommerce auth is much simpler than Shopify's — a Consumer Key/Secret
// pair generated once under WooCommerce → Settings → Advanced → REST API,
// sent as HTTP Basic Auth. No token expiry, no OAuth dance.
function getClient(source) {
  const baseUrl = source?.site_url;
  const key = source?.consumer_key;
  const secret = source?.consumer_secret;

  if (!baseUrl || !key || !secret) {
    throw new Error('WooCommerce site URL, consumer key, and consumer secret are all required.');
  }

  return axios.create({
    baseURL: `${baseUrl.replace(/\/$/, '')}/wp-json/wc/v3`,
    auth: { username: key, password: secret },
    timeout: 20000,
  });
}

async function fetchAllProducts(source) {
  const client = getClient(source);
  let products = [];
  let page = 1;
  while (true) {
    const res = await client.get('/products', { params: { per_page: 100, page } });
    products = products.concat(res.data);
    if (res.data.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 300));
  }
  return products;
}

// createdSince -> WooCommerce `after` (orders created after); updatedSince ->
// `modified_after` (created OR changed), same split as config/shopify.js.
async function fetchOrders(source, filters = {}) {
  const { createdSince, updatedSince } = typeof filters === 'string' ? { createdSince: filters } : filters;
  const client = getClient(source);
  let orders = [];
  let page = 1;
  while (true) {
    const params = { per_page: 100, page, status: 'any' };
    if (createdSince) params.after = createdSince;
    if (updatedSince) params.modified_after = updatedSince;
    const res = await client.get('/orders', { params });
    orders = orders.concat(res.data);
    if (res.data.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 300));
  }
  return orders;
}

/** Lightweight call used by "Test connection" in Settings. */
async function ping(source) {
  const client = getClient(source);
  const res = await client.get('/system_status');
  return { name: res.data?.environment?.site_url || source.site_url, version: res.data?.environment?.version };
}

async function listWebhooks(source) {
  const res = await getClient(source).get('/webhooks', { params: { per_page: 100, status: 'all' } });
  return res.data || [];
}

/** Needs an API key with WRITE permission (a read-only key is refused by WooCommerce). */
async function createWebhook(source, { name, topic, deliveryUrl, secret }) {
  const res = await getClient(source).post('/webhooks', { name, topic, delivery_url: deliveryUrl, secret, status: 'active' });
  return res.data;
}

async function deleteWebhook(source, id) {
  await getClient(source).delete(`/webhooks/${id}`, { params: { force: true } });
}

module.exports = { listWebhooks, createWebhook, deleteWebhook, getClient, fetchAllProducts, fetchOrders, ping };
