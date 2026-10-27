import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { KEY } from './orderHelpers.js';
import { confirmOrder } from '../src/orders/orders.js';

// Loads the real staff screens (public/app.js) into a simulated browser, pointed at a real server on a real database,
// and visits every screen as the roles that use it. It proves each screen builds without errors and shows real data.
let db: TestDb;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base = '';
const code = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

beforeAll(async () => {
  db = await makeTestDb(); await runMigrations(db.pool);
  const app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY });
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await db.drop(); });

async function browser(token: string | null) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div><dialog id="dlg"></dialog></body>`, { url: `${base}/app/`, runScripts: 'outside-only', pretendToBeVisual: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = dom.window;
  if (token) w.sessionStorage.setItem('ut_token', token);
  w.fetch = ((url: string, init?: RequestInit) => fetch(`${base}${url}`, init)) as typeof fetch;
  (w as unknown as { crypto: Crypto }).crypto = globalThis.crypto;
  const dialogProto = (w as unknown as { HTMLDialogElement: { prototype: Record<string, unknown> } }).HTMLDialogElement.prototype;
  dialogProto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  dialogProto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')); };
  (w.Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
  (w as unknown as { alert: (m: string) => void }).alert = (m) => { throw new Error(`alert: ${m}`); };
  const errors: string[] = [];
  w.addEventListener('error', (e: ErrorEvent) => errors.push(String(e.error?.message ?? e.message)));
  w.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => errors.push(String(e.reason)));
  w.eval(code);
  const text = () => w.document.getElementById('app')!.textContent ?? '';
  const waitFor = async (pred: () => boolean, what: string) => { for (let i = 0; i < 100; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error(`timed out waiting for ${what}. Page says: ${text().slice(0, 300)}`); };
  const visit = async (hash: string, expect: string) => { w.location.hash = hash; await waitFor(() => text().includes(expect), `"${expect}" at ${hash}`); const err = w.document.querySelector('.msg.err'); if (err) throw new Error(`error shown at ${hash}: ${err.textContent}`); };
  return { w, dom, text, visit, waitFor, errors, doc: w.document };
}

describe('the staff screens', () => {
  it('shows the login screen, rejects a wrong password, and logs in', async () => {
    const u = await loggedIn(db.pool, 'cashier');
    const b = await browser(null);
    await b.waitFor(() => b.text().includes('Log in'), 'login');
    const set = (n: string, v: string) => { (b.doc.querySelector(`input[name=${n}]`) as HTMLInputElement).value = v; };
    set('username', u.username); set('password', 'wrong-wrong-1');
    (b.doc.querySelector('form') as HTMLFormElement).dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.waitFor(() => !!b.doc.querySelector('.msg.err'), 'wrong password message');
    expect(b.doc.querySelector('.msg.err')!.textContent).toContain('Wrong username or password');
    set('password', u.password);
    (b.doc.querySelector('form') as HTMLFormElement).dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.waitFor(() => b.text().includes(`Hello, Test cashier`), 'home after login');
    expect(b.errors).toEqual([]);
  });

  it('asks a new user to choose a password before anything else', async () => {
    const u = await loggedIn(db.pool, 'manager', { keepTemporary: true });
    const b = await browser(u.token);
    await b.waitFor(() => b.text().includes('Choose your own password'), 'forced change');
    const set = (n: string, v: string) => { (b.doc.querySelector(`input[name=${n}]`) as HTMLInputElement).value = v; };
    set('currentPassword', u.temporaryPassword); set('newPassword', 'Brand-new-secret-1');
    (b.doc.querySelector('form') as HTMLFormElement).dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.waitFor(() => b.text().includes('Money at risk'), 'risk page after change');
    expect(b.errors).toEqual([]);
  });

  it('shows every screen to an admin, with real data, and no errors', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    const mgr = await loggedIn(db.pool, 'manager');
    const agent = await loggedIn(db.pool, 'cashier');
    const auth = (u: { auth: string }) => ({ Authorization: u.auth });
    const app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY });
    const rider = (await request(app).post('/api/couriers/riders').set(auth(mgr)).send({ name: 'Peter Rider' })).body.courier;
    const org = (await request(app).post('/api/couriers/organizations').set(auth(mgr)).send({ name: 'Fastline', collectsPayment: true })).body.courier;
    await request(app).post('/api/products').set(auth(mgr)).send({ sku: 'UI-1', name: 'Canvas shoe', priceCents: 250_000 });
    const pid = (await request(app).get('/api/products').set(auth(mgr))).body.products[0].id;
    await request(app).post(`/api/products/${pid}/receive`).set(auth(mgr)).send({ quantity: 10 });
    const order = (await request(app).post('/api/orders').set(auth(agent)).send({ customerName: 'Screen Test', customerPhone: '0711900100', items: [{ sku: 'UI-1', name: 'Canvas shoe', quantity: 2, unitPriceCents: 250_000 }] })).body.order;

    const b = await browser(admin.token);
    await b.visit('#/risk', 'Money at risk');
    await b.visit('#/orders', 'Screen Test');
    expect(b.text()).toContain(order.orderRef);
    await b.visit(`#/order/${encodeURIComponent(order.orderRef)}`, 'Package fee (KES)');
    expect(b.text()).toContain('Canvas shoe');
    expect(b.text()).toContain('Peter Rider');
    await b.visit('#/new-order', 'New order');
    await b.visit('#/couriers', 'Add a rider');
    await b.visit(`#/courier/${rider.id}`, 'Peter Rider');
    await b.visit(`#/courier/${org.id}`, 'Settle a statement');
    await b.visit('#/till', 'Open your till');
    await b.visit('#/pay', 'Pay rates (admin)');
    await b.visit('#/discounts', 'Discounts by person');
    expect(b.errors).toEqual([]);

    // the customer has been phoned (the rule that an unpaid order is confirmed before it leaves the shop)
    await confirmOrder({ pool: db.pool, refKey: KEY }, { orderRef: order.orderRef, actor: 'test-setup' });

    // dispatch from the screen
    await b.visit(`#/order/${encodeURIComponent(order.orderRef)}`, 'Package fee (KES)');
    const f = [...b.doc.querySelectorAll('form')].find((x) => x.textContent?.includes('Package fee'))!;
    (f.querySelector('[name=fee]') as HTMLInputElement).value = '300';
    f.dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.waitFor(() => b.text().includes('Delivery outcome'), 'dispatched order');
    expect(b.errors).toEqual([]);
  });

  it('runs a till shift from the screen: open, sell, and see it in the list', async () => {
    const cashier = await loggedIn(db.pool, 'cashier');
    const b = await browser(cashier.token);
    await b.visit('#/till', 'Open your till');
    const open = [...b.doc.querySelectorAll('form')].find((x) => x.textContent?.includes('Opening float'))!;
    (open.querySelector('[name=float]') as HTMLInputElement).value = '0';
    open.dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.waitFor(() => b.text().includes('Complete sale'), 'till open with sell form');
    const sell = [...b.doc.querySelectorAll('form')].find((x) => x.textContent?.includes('Complete sale'))!;
    (sell.querySelector('[name=name]') as HTMLInputElement).value = 'Socks';
    (sell.querySelector('[name=price]') as HTMLInputElement).value = '500';
    (sell.querySelector('[name=amt-cash]') as HTMLInputElement).value = '500';
    sell.dispatchEvent(new b.w.Event('submit', { cancelable: true }));
    await b.waitFor(() => b.text().includes('Socks') === false && b.text().includes('Void'), 'sale in the list');
    expect(b.text()).toContain('500.00');
    expect(b.errors).toEqual([]);
  });

  it('shows a cashier only what they may use, and their own pay', async () => {
    const cashier = await loggedIn(db.pool, 'cashier');
    const b = await browser(cashier.token);
    await b.visit('#/home', 'Attendance');
    const nav = [...b.doc.querySelectorAll('header nav a')].map((a) => a.textContent);
    expect(nav).toEqual(expect.arrayContaining(['Orders', 'New order', 'Till', 'Pay']));
    expect(nav).not.toContain('Couriers');
    expect(nav).not.toContain('Discounts');
    await b.visit('#/pay', 'My pay');
    expect(b.text()).not.toContain('Pay rates');
    expect(b.errors).toEqual([]);
  });
});
