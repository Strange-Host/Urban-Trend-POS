import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Start from './Start';
import { canFor } from '../components/shell/testRoles';

const auth = { role: 'cashier', can: canFor('cashier') };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Cathy Cashier', role: auth.role }, can: auth.can }),
}));
const session = { current: null };
vi.mock('../api/endpoints', () => ({
  cashSessionsApi: { current: () => Promise.resolve({ data: { data: session.current } }) },
}));
// The shift widget has its own tests and its own API calls; here it only needs to show that it was asked to close.
vi.mock('../components/ShiftWidget', () => ({
  default: ({ closeRequest }) => <div data-testid="shift-widget">close requests: {closeRequest}</div>,
}));
vi.mock('../components/shell/PageHeader', () => ({
  default: ({ title, description }) => <header><h1>{title}</h1><p>{description}</p></header>,
}));

function renderStart() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><MemoryRouter><Start /></MemoryRouter></QueryClientProvider>,
  );
}
const tileNames = () => within_tiles().map((el) => el.querySelector('.font-display').textContent);
const within_tiles = () => [...screen.getByTestId('start-tiles').children];

beforeEach(() => { auth.role = 'cashier'; auth.can = canFor('cashier'); session.current = null; });

describe('Start tiles follow permissions', () => {
  it('shows a default cashier the till, orders and void/refund, and no stock tiles', async () => {
    renderStart();
    expect(tileNames()).toEqual(['New sale', 'Online orders', 'Void or refund']);
  });

  it('adds Receive and Count stock when those permissions are granted', () => {
    auth.can = (p) => ['stock.receive', 'stock.count', 'sales.void_request'].includes(p);
    renderStart();
    expect(tileNames()).toEqual(['New sale', 'Online orders', 'Receive stock', 'Count stock', 'Void or refund']);
  });

  it('hides Void or refund when the person may do neither', () => {
    auth.can = () => false;
    renderStart();
    expect(tileNames()).toEqual(['New sale', 'Online orders']);
  });

  it('shows either kind of request as enough for Void or refund', () => {
    auth.can = (p) => p === 'payments.refund_request';
    renderStart();
    expect(tileNames()).toContain('Void or refund');
  });

  it('links each tile to the page that does the job', () => {
    auth.can = () => true;
    renderStart();
    const href = (name) => screen.getByRole('link', { name: new RegExp(name) }).getAttribute('href');
    expect(href('New sale')).toBe('/terminal');
    expect(href('Online orders')).toBe('/orders');
    expect(href('Receive stock')).toBe('/stock?tab=receive');
    expect(href('Count stock')).toBe('/stock?tab=counts');
    expect(href('Void or refund')).toBe('/approvals');
  });
});

describe('Start behaviour', () => {
  it('puts focus on New sale so Enter goes straight to the till', () => {
    renderStart();
    expect(screen.getByRole('link', { name: /New sale/ })).toHaveFocus();
  });

  it('offers End shift only while a shift is open, and asks the shift widget to close', async () => {
    renderStart();
    expect(screen.queryByRole('button', { name: /End shift/ })).toBeNull();

    session.current = { id: 7, opened_at: '2026-11-06T06:00:00Z', opening_amount: 50000 };
    document.body.innerHTML = '';
    renderStart();
    const user = userEvent.setup();
    const end = await screen.findByRole('button', { name: /End shift/ });
    expect(screen.getByTestId('shift-widget')).toHaveTextContent('close requests: 0');
    await user.click(end);
    await waitFor(() => expect(screen.getByTestId('shift-widget')).toHaveTextContent('close requests: 1'));
  });

  it('greets the person by name', () => {
    renderStart();
    expect(screen.getByText('Hello, Cathy Cashier.')).toBeInTheDocument();
  });
});
