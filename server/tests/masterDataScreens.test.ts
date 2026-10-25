import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { KEY } from './orderHelpers.js';
import { browser, eventually } from './screenHelpers.js';

// The products, stock, customers and leads screens, used the way staff use them: through the real page (public/app.js) in a
// simulated browser, against a real server and database. What a screen did is then checked through the API.
let db: TestDb;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base = '';
type User = Awaited<ReturnType<typeof loggedIn>>;
const get = (u: User, path: string) => request(base).get(`/api${path}`).set('Authorization', u.auth);
const post = (u: User, path: string, body: object) => request(base).post(`/api${path}`).set('Authorization', u.auth).send(body);

beforeAll(async () => {
  db = await makeTestDb(); await runMigrations(db.pool);
  const app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY });
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await db.drop(); });

const onHand = async (u: User, sku: string) => (await get(u, `/products?search=${sku}`)).body.products[0]?.onHand as number;

describe('products, stock, customers and leads screens', () => {
  it('shows every screen with real data and no errors', async () => {
    const mgr = await loggedIn(db.pool, 'manager');
    const shoe = (await post(mgr, '/products', { sku: 'MD-1', name: 'Canvas shoe', category: 'Shoes', priceCents: 250_000, reorderLevel: 5 })).body.product;
    await post(mgr, `/products/${shoe.id}/receive`, { quantity: 3 });
    const bag = (await post(mgr, '/products', { sku: 'MD-2', name: 'Day bag', category: 'Bags', priceCents: 100_000 })).body.product;
    await post(mgr, `/products/${bag.id}/receive`, { quantity: 20 });
    const cust = (await post(mgr, '/customers', { name: 'Jane Wanjiku', phone: '0711222333', town: 'Thika' })).body.customer;
    const lead = (await post(mgr, '/leads', { name: 'Peter Otieno', phone: '0722333444', message: 'Is the day bag in stock?' })).body.lead;

    const b = await browser(base, mgr.token);
    await b.visit('#/products', 'MD-1');
    expect(b.text()).toContain('Add a product');
    expect(b.text()).toContain('low stock');
    const cats = [...b.doc.querySelectorAll('select[name=category] option')].map((o) => o.textContent);
    expect(cats).toEqual(['Any', 'Bags', 'Shoes']);
    expect(b.doc.querySelector('header nav a.on')?.textContent).toBe('Products');

    // filter by category, then by "low stock only"
    b.set(b.doc as unknown as ParentNode, 'category', 'Bags'); b.change(b.doc.querySelector('select[name=category]')!);
    await b.waitFor(() => !b.text().includes('MD-1') && b.text().includes('MD-2'), 'the Bags filter');
    b.set(b.doc as unknown as ParentNode, 'category', ''); b.change(b.doc.querySelector('select[name=category]')!);
    await b.waitFor(() => b.text().includes('MD-1') && b.text().includes('MD-2'), 'filter cleared');
    (b.doc.querySelector('input[name=low]') as HTMLInputElement).checked = true; b.change(b.doc.querySelector('input[name=low]')!);
    await b.waitFor(() => b.text().includes('MD-1') && !b.text().includes('MD-2'), 'the low stock filter');

    await b.visit(`#/product/${shoe.id}`, 'Stock history');
    expect(b.text()).toContain('Goods received');
    expect(b.text()).toContain('Canvas shoe');
    expect(b.doc.querySelector('header nav a.on')?.textContent).toBe('Products');

    await b.visit('#/stock', 'Running low');
    expect(b.text()).toContain('Strict mode');
    expect(b.text()).toContain('MD-1');
    expect(b.text()).toContain('Recent movements');
    expect(b.text()).toContain('Goods received');

    await b.visit('#/customers', 'Jane Wanjiku');
    await b.visit(`#/customer/${cust.id}`, 'Recent orders');
    expect(b.text()).toContain('Thika');
    await b.visit('#/leads', 'Peter Otieno');
    await b.visit(`#/lead/${lead.id}`, 'Conversation');
    expect(b.text()).toContain('Is the day bag in stock?');
    expect(b.errors).toEqual([]);
  });

  it('adds a product, receives stock, corrects a count, writes off and edits, from the screens', async () => {
    const mgr = await loggedIn(db.pool, 'manager');
    const b = await browser(base, mgr.token);
    await b.visit('#/products', 'Add a product');
    let f = b.formWith('Add product');
    b.set(f, 'sku', 'NEW-1'); b.set(f, 'name', 'Leather belt'); b.set(f, 'category', 'Belts'); b.set(f, 'price', '1,500.50'); b.set(f, 'cost', '900'); b.set(f, 'reorder', '4');
    b.submit(f);
    await b.waitFor(() => b.text().includes('Stock history'), 'the new product page');
    const made = (await get(mgr, '/products?search=NEW-1')).body.products[0];
    expect(made).toMatchObject({ name: 'Leather belt', category: 'Belts', priceCents: 150_050, costCents: 90_000, reorderLevel: 4, trackStock: true, onHand: 0 });

    // goods received
    f = b.formWith('Receive'); b.set(f, 'quantity', '12'); b.set(f, 'cost', '850'); b.set(f, 'note', 'Delivery note 77'); b.submit(f);
    await eventually(() => onHand(mgr, 'NEW-1'), (n) => n === 12, 'stock to reach 12');
    await b.waitFor(() => b.text().includes('Delivery note 77'), 'the receipt in the history');

    // count corrections: +3, then -2; zero and non-numbers are refused on the page, before the server is asked
    await b.waitFor(() => b.buttonLabels().includes('Save correction'), 'the correction form');
    f = b.formWith('Save correction'); b.set(f, 'delta', '+3'); b.set(f, 'reason', 'Found a box'); b.submit(f);
    await eventually(() => onHand(mgr, 'NEW-1'), (n) => n === 15, 'stock to reach 15');
    await b.waitFor(() => b.text().includes('Found a box'), 'the correction in the history');
    f = b.formWith('Save correction'); b.set(f, 'delta', '-2'); b.set(f, 'reason', 'Two damaged'); b.submit(f);
    await eventually(() => onHand(mgr, 'NEW-1'), (n) => n === 13, 'stock to reach 13');
    await b.waitFor(() => b.text().includes('Two damaged'), 'the second correction in the history');
    f = b.formWith('Save correction'); b.set(f, 'delta', '0'); b.set(f, 'reason', 'nothing'); b.submit(f);
    await b.waitFor(() => b.noticeText().includes('cannot be zero'), 'the zero message');
    f = b.formWith('Save correction'); b.set(f, 'delta', 'abc'); b.set(f, 'reason', 'nothing'); b.submit(f);
    await b.waitFor(() => b.noticeText().includes('whole number'), 'the non-number message');
    expect(await onHand(mgr, 'NEW-1')).toBe(13);

    // a write-off asks first; "Cancel" changes nothing, "Write off" does
    f = b.formWith('Write off'); b.set(f, 'quantity', '1'); b.set(f, 'reason', 'Water damage'); b.submit(f);
    await b.answer('Cancel');
    await b.waitFor(() => b.noticeText().includes('Cancelled'), 'the cancelled message');
    expect(await onHand(mgr, 'NEW-1')).toBe(13);
    f = b.formWith('Write off'); b.set(f, 'quantity', '1'); b.set(f, 'reason', 'Water damage'); b.submit(f);
    await b.answer('Write off');
    await eventually(() => onHand(mgr, 'NEW-1'), (n) => n === 12, 'stock to reach 12 after the write-off');

    // edit, then deactivate: it leaves the default list and comes back under "Show deactivated"
    await b.waitFor(() => b.buttonLabels().includes('Save changes'), 'the edit form');
    f = b.formWith('Save changes'); b.set(f, 'price', '1600'); b.set(f, 'category', 'Accessories'); b.submit(f);
    await eventually(async () => (await get(mgr, '/products?search=NEW-1')).body.products[0], (p) => p.priceCents === 160_000 && p.category === 'Accessories', 'the edit to save');
    await b.waitFor(() => b.buttonLabels().includes('Save changes'), 'the edit form again');
    f = b.formWith('Save changes'); b.check(f, 'active', false); b.submit(f);
    await eventually(async () => (await get(mgr, '/products?search=NEW-1')).body.products[0], (p) => p.active === false, 'the product to deactivate');
    await b.visit('#/products', 'MD-1');
    expect(b.text()).not.toContain('NEW-1');
    (b.doc.querySelector('input[name=all]') as HTMLInputElement).checked = true; b.change(b.doc.querySelector('input[name=all]')!);
    await b.waitFor(() => b.text().includes('NEW-1') && b.text().includes('inactive'), 'deactivated products to show');
    expect(b.errors).toEqual([]);
  });

  it('pages through customers, adds and edits one, and flags prepayment', async () => {
    const mgr = await loggedIn(db.pool, 'manager');
    const b = await browser(base, mgr.token);
    for (let start = 0; start < 55; start += 11) {
      await Promise.all(Array.from({ length: 11 }, (_, k) => { const i = start + k; return post(mgr, '/customers', { name: `Bulk ${String(i).padStart(3, '0')}`, phone: `07${String(10_000_000 + i)}` }); }));
    }
    await b.visit('#/customers', 'customers');
    await b.waitFor(() => /1–50 of \d+/.test(b.text()), 'a page of 50');
    const next = [...b.doc.querySelectorAll('button')].find((x) => x.textContent === 'Next')!;
    b.click(next);
    await b.waitFor(() => /51–\d+ of \d+/.test(b.text()), 'the second page');
    expect([...b.doc.querySelectorAll('button')].find((x) => x.textContent === 'Previous')!.hasAttribute('disabled')).toBe(false);

    await b.visit('#/customers', 'Add a customer');
    let f = b.formWith('Add customer');
    b.set(f, 'name', 'Grace Muthoni'); b.set(f, 'phone', '0744555666'); b.set(f, 'town', 'Nakuru'); b.submit(f);
    await b.waitFor(() => b.text().includes('Recent orders') && b.text().includes('Grace Muthoni'), 'the new customer page');
    const id = (await get(mgr, '/customers/lookup?phone=0744555666')).body.customer.id as number;

    f = b.formWith('Require prepayment'); b.set(f, 'reason', 'Did not claim two parcels'); b.submit(f);
    await eventually(async () => (await get(mgr, `/customers/${id}`)).body.customer, (c) => c.prepayRequired === true, 'prepayment to be required');
    await b.waitFor(() => b.text().includes('prepay only') && b.text().includes('Did not claim two parcels'), 'the prepay flag on the page');
    f = b.formWith('Remove the prepay requirement'); b.submit(f);
    await eventually(async () => (await get(mgr, `/customers/${id}`)).body.customer, (c) => c.prepayRequired === false, 'prepayment to be removed');

    await b.waitFor(() => b.buttonLabels().includes('Save changes'), 'the edit form');
    f = b.formWith('Save changes'); b.set(f, 'town', 'Eldoret'); b.set(f, 'notes', ''); b.submit(f);
    await eventually(async () => (await get(mgr, `/customers/${id}`)).body.customer, (c) => c.town === 'Eldoret', 'the town to change');

    // their orders appear on their page (the address changes first: asking for the page you are already on does not redraw it)
    const order = (await post(mgr, '/orders', { customerName: 'Grace Muthoni', customerPhone: '0744 555 666', items: [{ name: 'Sandals', quantity: 1, unitPriceCents: 80_000 }] })).body.order;
    await b.visit('#/customers', 'Add a customer');
    await b.visit(`#/customer/${id}`, order.orderRef);

    // a phone typed the usual way finds the customer (the server only matches the last nine digits)
    await b.visit('#/customers', 'Add a customer');
    for (const typed of ['0744 555 666', '+254 744 555 666', '0744']) {
      const se = b.doc.querySelector('input[name=search]') as HTMLInputElement;
      se.value = typed; se.dispatchEvent(new b.w.Event('input', { bubbles: true }));
      await b.waitFor(() => b.text().includes('1 customer') && b.text().includes('Grace Muthoni'), `a search for "${typed}"`);
    }
    expect(b.errors).toEqual([]);
  });

  it('works a lead from enquiry to order, and handles a repeat enquiry and a lost lead', async () => {
    const mgr = await loggedIn(db.pool, 'manager');
    const b = await browser(base, mgr.token);
    await b.visit('#/leads', 'Add a lead');
    let f = b.formWith('Add lead');
    b.set(f, 'name', 'Mary Akinyi'); b.set(f, 'phone', '0733444555'); b.set(f, 'source', 'whatsapp'); b.set(f, 'productInterest', 'sneakers'); b.set(f, 'message', 'wants a size 40'); b.submit(f);
    await b.waitFor(() => b.text().includes('Conversation') && b.text().includes('wants a size 40'), 'the new lead page');
    const lead = (await get(mgr, '/leads?search=733444555')).body.leads[0];
    expect(lead).toMatchObject({ name: 'Mary Akinyi', source: 'whatsapp', status: 'new' });

    // the same number again: nothing is duplicated, the message is added, and the page says so and links to the lead
    await b.visit('#/leads', 'Add a lead');
    f = b.formWith('Add lead'); b.set(f, 'phone', '0733 444 555'); b.set(f, 'message', 'also asked about bags'); b.submit(f);
    await b.waitFor(() => b.noticeText().includes('already has an open lead'), 'the repeat-enquiry notice');
    expect(b.doc.querySelector('#notice a')!.getAttribute('href')).toBe(`#/lead/${lead.id}`);
    expect((await get(mgr, `/leads/${lead.id}`)).body.lead.messages).toHaveLength(2);
    expect((await get(mgr, '/leads?search=733444555')).body.total).toBe(1);

    // status: a lost lead needs a reason, and can be reopened
    await b.visit(`#/lead/${lead.id}`, 'Conversation');
    f = b.formWith('Save status'); b.set(f, 'status', 'lost'); b.submit(f);
    await b.waitFor(() => b.noticeText().includes('Say why the lead was lost'), 'the reason message');
    expect((await get(mgr, `/leads/${lead.id}`)).body.lead.status).toBe('new');
    b.set(f, 'lostReason', 'Found it cheaper elsewhere'); b.submit(f);
    await eventually(async () => (await get(mgr, `/leads/${lead.id}`)).body.lead, (l) => l.status === 'lost' && l.lostReason === 'Found it cheaper elsewhere', 'the lead to be lost');
    await b.waitFor(() => b.text().includes('Why lost') && !b.text().includes('Turn this into an order'), 'a lost lead cannot be turned into an order');
    f = b.formWith('Save status'); b.set(f, 'status', 'contacted'); b.submit(f);
    await eventually(async () => (await get(mgr, `/leads/${lead.id}`)).body.lead.status, (s) => s === 'contacted', 'the lead to reopen');

    // note, assignment, details
    await b.waitFor(() => b.text().includes('Turn this into an order'), 'the order form to return');
    f = b.formWith('Add'); b.set(f, 'direction', 'note'); b.set(f, 'body', 'Call back after 5pm'); b.submit(f);
    await b.waitFor(() => b.text().includes('Call back after 5pm'), 'the note');
    f = b.formWith('Save'); b.set(f, 'assignedTo', mgr.username); b.submit(f);
    await eventually(async () => (await get(mgr, `/leads/${lead.id}`)).body.lead.assignedTo, (a) => a === mgr.username, 'the assignment');
    await b.waitFor(() => b.buttonLabels().includes('Save details'), 'the details form');
    f = b.formWith('Save details'); b.set(f, 'productInterest', 'white sneakers, size 40'); b.submit(f);
    await eventually(async () => (await get(mgr, `/leads/${lead.id}`)).body.lead.productInterest, (p) => p === 'white sneakers, size 40', 'the details');

    // the list can be searched by a phone typed the usual way, and narrowed to mine
    await b.visit('#/leads', 'Add a lead'); // not "Mary Akinyi": that is also on the lead page we are leaving
    await b.waitFor(() => b.text().includes('Mary Akinyi'), 'the list of leads');
    const se = b.doc.querySelector('input[name=search]') as HTMLInputElement;
    se.value = '0733 444 555'; se.dispatchEvent(new b.w.Event('input', { bubbles: true }));
    await b.waitFor(() => b.text().includes('1 lead') && b.text().includes('Mary Akinyi'), 'a phone search');
    se.value = 'nobody has this name'; se.dispatchEvent(new b.w.Event('input', { bubbles: true }));
    await b.waitFor(() => b.text().includes('No leads match'), 'a search with no match');
    se.value = ''; se.dispatchEvent(new b.w.Event('input', { bubbles: true }));
    await b.waitFor(() => b.text().includes('Mary Akinyi'), 'the search cleared');
    b.set(b.doc as unknown as ParentNode, 'who', 'none'); b.change(b.doc.querySelector('select[name=who]')!);
    await b.waitFor(() => !b.text().includes('Mary Akinyi') && b.text().includes('Peter Otieno'), 'the "nobody yet" filter (Mary is assigned; Peter is not)');
    b.set(b.doc as unknown as ParentNode, 'who', 'mine'); b.change(b.doc.querySelector('select[name=who]')!);
    await b.waitFor(() => b.text().includes('Mary Akinyi') && !b.text().includes('Peter Otieno'), 'the "mine" filter');

    // turn it into an order: the order is made, the lead closes, and the page opens the order
    await b.visit(`#/lead/${lead.id}`, 'Turn this into an order');
    f = b.formWith('Make the order'); b.set(f, 'name', 'White sneakers'); b.set(f, 'qty', '2'); b.set(f, 'price', '3000'); b.set(f, 'discount', '100'); b.submit(f);
    await eventually(async () => (await get(mgr, `/leads/${lead.id}`)).body.lead, (l) => l.status === 'converted' && !!l.convertedOrderRef, 'the lead to convert');
    const done = (await get(mgr, `/leads/${lead.id}`)).body.lead;
    await b.waitFor(() => b.text().includes(done.convertedOrderRef) && b.text().includes('White sneakers'), 'the order page');
    const order = (await get(mgr, `/orders/${encodeURIComponent(done.convertedOrderRef)}`)).body.order;
    expect(order).toMatchObject({ customerName: 'Mary Akinyi', totalCents: 2 * 300_000 - 10_000 });

    // a converted lead is closed: no forms, a link to the order
    await b.visit(`#/lead/${lead.id}`, 'Conversation');
    expect(b.text()).not.toContain('Turn this into an order');
    expect(b.buttonLabels()).not.toContain('Save status');
    expect(b.doc.querySelector(`a[href="#/order/${encodeURIComponent(done.convertedOrderRef)}"]`)).not.toBeNull();
    expect(b.errors).toEqual([]);
  });

  it('shows a cashier the screens but not the manager controls', async () => {
    const cashier = await loggedIn(db.pool, 'cashier');
    const mgr = await loggedIn(db.pool, 'manager');
    const prod = (await get(mgr, '/products?search=MD-1')).body.products[0];
    const lead = (await post(mgr, '/leads', { name: 'Walk-in Wilson', phone: '0755666777' })).body.lead;
    const cust = (await get(mgr, '/customers?search=Jane')).body.customers[0];
    const b = await browser(base, cashier.token);

    await b.visit('#/home', 'Attendance');
    const nav = [...b.doc.querySelectorAll('header nav a')].map((a) => a.textContent);
    expect(nav).toEqual(expect.arrayContaining(['Leads', 'Customers', 'Products', 'Stock']));

    await b.visit('#/products', 'MD-1');
    expect(b.text()).not.toContain('Add a product');
    await b.visit(`#/product/${prod.id}`, 'Stock history');
    for (const hidden of ['Receive', 'Save correction', 'Write off', 'Save changes']) expect(b.buttonLabels()).not.toContain(hidden);
    expect(b.text()).not.toContain('Edit this product');
    expect(b.text()).not.toMatch(/cost/i); // what goods cost is for managers
    await b.visit('#/stock', 'Strict mode');
    expect(b.text()).not.toMatch(/cost/i);
    await b.visit('#/stock', 'Strict mode');
    expect(b.buttonLabels()).not.toContain('Turn on');
    expect(b.buttonLabels()).not.toContain('Turn off');

    await b.visit(`#/customer/${cust.id}`, 'Recent orders');
    expect(b.text()).toContain('Edit details');
    expect(b.text()).not.toContain('Payment before delivery');

    await b.visit(`#/lead/${lead.id}`, 'Conversation');
    expect(b.text()).toContain('Where this lead stands');
    expect(b.text()).toContain('Turn this into an order');
    expect(b.text()).not.toContain('Give to');
    expect(b.errors).toEqual([]);
  });

  it('lets an admin switch strict mode on and off, after asking', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    const b = await browser(base, admin.token);
    await b.visit('#/stock', 'Strict mode');
    b.click([...b.doc.querySelectorAll('button')].find((x) => x.textContent === 'Turn on')!);
    await b.answer('Cancel');
    await b.waitFor(() => b.noticeText().includes('Cancelled'), 'cancel');
    expect((await get(admin, '/stock/strict')).body.strict).toBe(false);
    b.click([...b.doc.querySelectorAll('button')].find((x) => x.textContent === 'Turn on')!);
    await b.answer('Yes');
    await eventually(async () => (await get(admin, '/stock/strict')).body.strict, (s) => s === true, 'strict mode on');
    await b.waitFor(() => b.buttonLabels().includes('Turn off'), 'the Turn off button');
    b.click([...b.doc.querySelectorAll('button')].find((x) => x.textContent === 'Turn off')!);
    await b.answer('Yes');
    await eventually(async () => (await get(admin, '/stock/strict')).body.strict, (s) => s === false, 'strict mode off');
    expect(b.errors).toEqual([]);
  });
});
