// @vitest-environment-options {"url":"http://localhost:5173"}
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import client, { clearAccessToken } from '../api/client';
import { USE_NEW_SERVER } from '../api/newServer';
import { authApi } from '../api/endpoints';
import { AuthProvider } from '../context/AuthContext';
import { ToastProvider, DialogProvider } from '../context/UIContext';
import Orders from '../pages/Orders';

// The legacy Orders page (with the few edits made for the new server) on the REAL new server: over HTTP, nothing mocked.
//   terminal 1 (server/):    npm run dev:stack
//   terminal 2 (frontend/):  npm run test:e2e-new-server
// jsdom has no layout engine, so scrolling does not exist there; the page only scrolls a chip strip into view.
Element.prototype.scrollTo = Element.prototype.scrollTo || function scrollTo() {};
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function scrollIntoView() {};
const ADMIN = { email: 'admin@shop.test', password: 'Admin-Dev-Passphrase-1' };

let n = 0;
const phone = () => `0766${String(100000 + ++n + Math.floor(Math.random() * 800000)).slice(0, 6)}`;
const tag = () => `E2E${Date.now().toString(36)}${++n}`;

function Page() {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><DialogProvider><AuthProvider>
        <MemoryRouter><Orders /></MemoryRouter>
      </AuthProvider></DialogProvider></ToastProvider>
    </QueryClientProvider>
  );
}

async function api(method, path, body) { const r = await client({ method, url: path, data: body }); return r.data; }
const newOrder = (customerName, items = [{ name: 'Canvas shoe', quantity: 2, unitPriceCents: 250_000 }]) =>
  api('post', '/orders', { customerName, customerPhone: phone(), items }).then((d) => d.order);
const getOrder = (ref) => api('get', `/orders/${ref}`).then((d) => d.order);
const button = (name) => screen.getByRole('button', { name });
const confirmDialog = () => within(document.body).getByRole('button', { name: /^Confirm$/ });
const open = async (customerName) => { fireEvent.click(await screen.findByText(customerName)); await screen.findByText('Order created'); }; // the opened order's own history, not something every row has

let rider;
beforeAll(async () => {
  const health = await client.get('/health').catch((e) => e);
  if (!health?.status) throw new Error(`The new server is not reachable (${health?.message}). Start it with: cd server && npm run dev:stack`);
  await authApi.login(ADMIN.email, ADMIN.password);
  rider = (await api('post', '/couriers/riders', { name: `E2E Rider ${tag()}`, phone: '0700123456' })).courier;
}, 30_000);
afterEach(() => { cleanup(); });

describe.skipIf(!USE_NEW_SERVER)('the legacy Orders page against the real new server', () => {
  it('lists an order with what is owed, and opens it with its items and history', async () => {
    const who = `List ${tag()}`;
    const o = await newOrder(who);
    render(<Page />);
    expect(await screen.findByText(who)).toBeInTheDocument();
    expect(screen.getAllByText(/5,000/).length).toBeGreaterThan(0); // total and still owed, in KES
    await open(who);
    expect(await screen.findByText(/2 × Canvas shoe/)).toBeInTheDocument();
    expect(screen.getByText('Order created')).toBeInTheDocument();
    expect(o.orderRef).toMatch(/^UT-/);
  }, 30_000);

  it('takes an order from confirmation to dispatch to a refused delivery to a counted-in return, all through the page', async () => {
    const who = `Journey ${tag()}`;
    const o = await newOrder(who);
    render(<Page />);
    await open(who);

    // 1. The legacy rule: an unpaid order is confirmed with the customer before it can leave.
    const dispatch = await screen.findByRole('button', { name: /Dispatch/ });
    expect(dispatch).toBeDisabled();
    fireEvent.click(button(/Confirm with customer/));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Confirm with customer/ })).toBeNull());
    await waitFor(() => expect(button(/Dispatch/)).not.toBeDisabled());
    expect((await getOrder(o.orderRef)).confirmedAt).toBeTruthy();

    // 2. A fee must be typed, and a courier chosen, before anything leaves.
    fireEvent.click(button(/Dispatch/));
    expect(await screen.findByText(/Enter the package fee/)).toBeInTheDocument();
    expect((await getOrder(o.orderRef)).status).toBe('awaiting_dispatch');
    fireEvent.change(screen.getByLabelText('Package fee in KES'), { target: { value: '300' } });
    fireEvent.click(button(/Dispatch/));
    expect(await screen.findByText(/Choose the rider or organization/)).toBeInTheDocument();

    const picker = () => [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === String(rider.id)));
    await waitFor(() => expect(picker()).toBeTruthy()); // the courier list has loaded
    fireEvent.change(picker(), { target: { value: String(rider.id) } });
    await waitFor(() => expect(picker().value).toBe(String(rider.id)));
    fireEvent.click(button(/Dispatch/));
    fireEvent.click(await waitFor(confirmDialog));
    await waitFor(async () => expect((await getOrder(o.orderRef)).status).toBe('dispatched'));
    const sent = await getOrder(o.orderRef);
    expect(sent.dispatch).toMatchObject({ courierId: rider.id, packageFeeCents: 30_000 });
    expect((await screen.findAllByText('Dispatched · unpaid')).length).toBeGreaterThan(0);

    // 3. The delivery fails: the customer refuses.
    fireEvent.click(button(/Record delivery outcome/));
    fireEvent.click(await screen.findByLabelText(/Refused/));
    fireEvent.change(screen.getByPlaceholderText(/phone off/), { target: { value: 'Customer rejected it at the door' } });
    fireEvent.click(button(/Save outcome/));
    await waitFor(async () => expect((await getOrder(o.orderRef)).status).toBe('returning'));
    expect((await screen.findAllByText('Returning')).length).toBeGreaterThan(0);

    // 4. The parcel is back: count it in, one restocked and one damaged.
    fireEvent.click(await screen.findByRole('button', { name: /Parcel arrived: count it in/ }));
    const restock = await screen.findByLabelText('Restock');
    fireEvent.change(restock, { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Damaged'), { target: { value: '1' } });
    fireEvent.click(button(/Count it in/));
    await waitFor(async () => expect((await getOrder(o.orderRef)).status).toBe('returned'));
    const done = await getOrder(o.orderRef);
    expect(done.returned).toMatchObject({ restocked: 1, damaged: 1, missing: 0 });
    expect((await screen.findAllByText('Returned · damaged')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/1 restocked, 1 damaged, 0 missing/)).length).toBe(2); // the history line and the summary box
    // The legacy two-step inspection and owner decision do not exist on the new server.
    expect(screen.queryByText(/Owner decision/i)).toBeNull();
  }, 90_000);

  it('asks why before cancelling, and keeps the reason with the order', async () => {
    const who = `Cancel ${tag()}`;
    const o = await newOrder(who);
    render(<Page />);
    await open(who);
    fireEvent.click(button(/Cancel order/));
    fireEvent.click(await waitFor(confirmDialog));
    const input = await screen.findByRole('textbox', { name: '' }).catch(() => null) ?? document.querySelector('input[type="text"], textarea');
    fireEvent.change(input, { target: { value: 'Customer changed their mind' } });
    fireEvent.click(screen.getByRole('button', { name: /^OK$/ }));
    await waitFor(async () => expect((await getOrder(o.orderRef)).status).toBe('cancelled'));
    const events = (await getOrder(o.orderRef)).events;
    expect(events.find((e) => e.type === 'cancelled').data.reason).toBe('Customer changed their mind');
    expect(await screen.findByText(/Cancelled: Customer changed their mind/)).toBeInTheDocument();
  }, 40_000);

  it('records only cash taken at the shop, offers no M-Pesa, and updates what is owed', async () => {
    const who = `Cash ${tag()}`;
    const o = await newOrder(who);
    await api('post', `/orders/${o.orderRef}/confirm`, {});
    await api('post', `/orders/${o.orderRef}/dispatch`, { courierId: rider.id, packageFee: { amountCents: 30_000 } });
    render(<Page />);
    await open(who);
    expect(await screen.findByText(/Record cash taken at the shop/)).toBeInTheDocument();
    expect(screen.getByText(/matched under Finance/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'M-Pesa' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Bank' })).toBeNull();
    const amount = screen.getByPlaceholderText('5000.00');
    fireEvent.change(amount, { target: { value: '1500' } });
    fireEvent.change(screen.getByPlaceholderText(/Reason \(e\.g\. paid at the counter\)/), { target: { value: 'Paid at the counter' } });
    fireEvent.click(screen.getByRole('button', { name: /^Record payment$/ }));
    await waitFor(async () => expect((await getOrder(o.orderRef)).paidCents).toBe(150_000));
    expect((await screen.findAllByText('Dispatched · part paid')).length).toBeGreaterThan(0); // the list row and the opened order
  }, 40_000);

  it('filters the list by the legacy statuses, and shows the right count of what is out', async () => {
    const who = `Filter ${tag()}`;
    const o = await newOrder(who);
    await api('post', `/orders/${o.orderRef}/confirm`, {});
    await api('post', `/orders/${o.orderRef}/dispatch`, { courierId: rider.id, packageFee: { amountCents: 30_000 } });
    render(<Page />);
    await screen.findByText(who);
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((x) => x.value === 'dispatched_unpaid'));
    fireEvent.change(select, { target: { value: 'awaiting_dispatch' } });
    await waitFor(() => expect(screen.queryByText(who)).toBeNull());
    fireEvent.change(select, { target: { value: 'dispatched_unpaid' } });
    expect(await screen.findByText(who)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'returned_awaiting_inspection' } }); // a state that no longer exists: an empty list, not an error
    await waitFor(() => expect(screen.queryByText(who)).toBeNull());
  }, 40_000);

  it('hides what the new server does not do yet instead of offering buttons that fail', async () => {
    render(<Page />);
    await screen.findByText(/Orders/);
    expect(screen.queryByText(/Pull online orders/i)).toBeNull();
  }, 20_000);
});
