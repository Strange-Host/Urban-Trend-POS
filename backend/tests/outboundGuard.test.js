const axios = require('axios');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const guard = require('../src/utils/outboundGuard');

let a;
beforeAll(async () => { a = { Authorization: `Bearer ${await loginAsAdmin()}` }; });
afterAll(() => cleanupTestDb());

describe('address classification', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.0.9',
  ])('the public policy refuses %s', (ip) => {
    expect(guard.isBlockedAddress(ip, 'public')).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '172.15.255.255', '192.169.0.1', '104.16.1.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'the public policy allows %s', (ip) => {
      expect(guard.isBlockedAddress(ip, 'public')).toBe(false);
    });

  it('the metadata policy allows a LAN or loopback address but still refuses link-local / cloud metadata', () => {
    expect(guard.isBlockedAddress('192.168.1.5', 'metadata')).toBe(false);
    expect(guard.isBlockedAddress('127.0.0.1', 'metadata')).toBe(false);
    expect(guard.isBlockedAddress('169.254.169.254', 'metadata')).toBe(true);
    expect(guard.isBlockedAddress('fd00:ec2::254', 'metadata')).toBe(true);
    expect(guard.isBlockedAddress('::ffff:169.254.169.254', 'metadata')).toBe(true);
  });

  it('ALLOW_PRIVATE_OUTBOUND=true relaxes the public policy to the metadata policy only', () => {
    process.env.ALLOW_PRIVATE_OUTBOUND = 'true';
    try {
      expect(guard.isBlockedAddress('192.168.1.5', 'public')).toBe(false);
      expect(guard.isBlockedAddress('169.254.169.254', 'public')).toBe(true);
    } finally { delete process.env.ALLOW_PRIVATE_OUTBOUND; }
  });

  it('assertAllowedHost rejects IP-literal URLs and accepts ordinary hostnames', () => {
    for (const u of ['https://127.0.0.1', 'http://[::1]:8080/x', 'https://10.0.0.5/wp-json', 'http://169.254.169.254/latest/meta-data']) {
      expect(() => guard.assertAllowedHost(u)).toThrow(/private|reserved/i);
    }
    expect(() => guard.assertAllowedHost('https://woo.example.com')).not.toThrow();
    expect(() => guard.assertAllowedHost('not a url://')).not.toThrow();   // unparseable bare text is left to the request itself
  });
});

describe('connect-time check (DNS answers are validated, not just the typed text)', () => {
  it('refuses a hostname that resolves to loopback under the public policy', async () => {
    // "localhost" resolves via /etc/hosts, so this needs no network.
    await expect(axios.get('http://localhost:9/', { timeout: 3000, ...guard.guardedAxiosOptions('http://localhost:9/') }))
      .rejects.toMatchObject({ code: 'EBLOCKED' });
  });

  it('lets the same name through under the metadata policy (it then fails only because nothing is listening)', async () => {
    const err = await axios.get('http://localhost:9/', { timeout: 3000, ...guard.guardedAxiosOptions('http://localhost:9/', 'metadata') }).catch((e) => e);
    expect(err.code).not.toBe('EBLOCKED');
  });
});

describe('Shopify domain rule', () => {
  it.each(['my-shop.myshopify.com', 'a.myshopify.com', 'shop-1.myshopify.com'])('accepts %s', (d) => expect(guard.isShopifyDomain(d)).toBe(true));
  it.each([
    'evil.com', 'my-shop.myshopify.com.evil.com', 'evil.com/.myshopify.com', 'user@my-shop.myshopify.com', 'my-shop.myshopify.com:8443',
    'myshopify.com', '-x.myshopify.com', 'my shop.myshopify.com', '127.0.0.1', '',
  ])('rejects %j', (d) => expect(guard.isShopifyDomain(d)).toBe(false));
});

describe('income source API', () => {
  const create = (body) => request(app).post('/api/income-sources').set(a).send(body);

  it('refuses a shop domain that is not a myshopify.com address, on create and on update', async () => {
    const bad = await create({ name: 'Evil', platform: 'shopify', shop_domain: 'attacker.example.com', api_key: 'k', api_secret: 's' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/myshopify\.com/);

    const ok = await create({ name: 'Good', platform: 'shopify', shop_domain: 'https://Good-Shop.myshopify.com/admin', api_key: 'k', api_secret: 's' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.shop_domain).toBe('good-shop.myshopify.com');   // pasted address bar value, cleaned and lowercased

    const patch = await request(app).patch(`/api/income-sources/${ok.body.data.id}`).set(a).send({ shop_domain: 'attacker.example.com' });
    expect(patch.status).toBe(400);
  });

  it('does not require a domain for a WooCommerce source', async () => {
    const res = await create({ name: 'Woo', platform: 'woocommerce', site_url: 'https://woo.example.com', consumer_key: 'ck', consumer_secret: 'cs' });
    expect(res.status).toBe(201);
  });
});
