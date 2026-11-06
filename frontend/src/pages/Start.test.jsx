import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Start from './Start';
import { cashSessionsApi, ordersApi } from '../api/endpoints';
import useOfflineQueue from '../hooks/useOfflineQueue';
import { canFor } from '../components/shell/testRoles';

const auth = { can: canFor('cashier') };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Cathy Cashier', role: 'cashier' }, can: auth.can }),
}));
vi.mock('../components/shell/PageHeader', () => ({ default: ({ title }) => <h1>{title}</h1> }));
vi.mock('../api/endpoints', () => ({
  cashSessionsApi: { current: vi.fn() },
  ordersApi: { list: vi.fn() },
}));

function renderStart() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Start /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const href = (name) => screen.getByRole('link', { name: new RegExp(`^${name}`) }).getAttribute('href');
const has = (name) => screen.queryByRole('link', { name: new RegExp(`^${name}`) }) !== null;
const openSession = { id: 1, opened_at: '2026-11-05T07:58:00', opening_amount: 5000, sales_count: 3, sales_total: 2140000 };

beforeEach(() => {
  auth.can = canFor('cashier');
  cashSessionsApi.current.mockResolvedValue({ data: { data: null } });
  ordersApi.list.mockResolvedValue({ data: { data: [], total: 4 } });
  useOfflineQueue.setState({ queue: [] });
});

describe('Start tiles follow permissions', () => {
  it('shows a default cashier New sale, Online orders and Void or refund, and no stock tiles', () => {
    renderStart();
    expect(has('New sale')).toBe(true);
    expect(has('Online orders')).toBe(true);
    expect(has('Void or refund')).toBe(true);
    expect(has('Receive stock')).toBe(false);
    expect(has('Count stock')).toBe(false);
  });

  it('adds Receive and Count stock, linked to their tabs, when those permissions are granted', () => {
    auth.can = (p) => ['stock.receive', 'stock.count', 'sales.void_request'].includes(p);
    renderStart();
    expect(href('Receive stock')).toBe('/stock?tab=receive');
    expect(href('Count stock')).toBe('/stock?tab=counts');
  });

  it('hides Void or refund when the person may do neither, and shows it for either one', () => {
    auth.can = () => false;
    const first = renderStart();
    expect(has('Void or refund')).toBe(false);
    first.unmount();
    auth.can = (p) => p === 'payments.refund_request';
    renderStart();
    expect(href('Void or refund')).toBe('/approvals');
  });

  it('points New sale and Online orders at the till and the orders page', () => {
    renderStart();
    expect(href('New sale')).toBe('/terminal');
    expect(href('Online orders')).toBe('/orders');
  });

  it('puts keyboard focus on New sale, so Enter goes straight to the till', () => {
    renderStart();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /^New sale/ }));
  });
});

describe('Online orders count', () => {
  it('says how many orders are waiting to dispatch', async () => {
    renderStart();
    expect(await screen.findByText('4 to dispatch')).toBeTruthy();
    expect(ordersApi.list).toHaveBeenCalledWith({ status: 'awaiting_dispatch', limit: 1 });
  });

  it('still shows the tile, without a number, when the count cannot be read', async () => {
    ordersApi.list.mockRejectedValue(new Error('Network Error'));
    renderStart();
    expect(await screen.findByText('Dispatch, payments and returns')).toBeTruthy();
  });
});

describe('End shift and the shift summary', () => {
  it('has no End shift tile with no shift open, and says so, offering the till to open one', async () => {
    renderStart();
    expect(await screen.findByText('Not open')).toBeTruthy();
    expect(has('End shift')).toBe(false);
    expect(screen.getByRole('link', { name: 'Open one at the till' }).getAttribute('href')).toBe('/terminal');
    expect(screen.queryByText('Sales this shift')).toBeNull();
  });

  it('with a shift open, End shift opens the till with the close-shift form requested', async () => {
    cashSessionsApi.current.mockResolvedValue({ data: { data: openSession } });
    renderStart();
    await waitFor(() => expect(has('End shift')).toBe(true));
    expect(href('End shift')).toBe('/terminal?shift=close');
  });

  it('shows when the shift opened and what it has taken so far', async () => {
    cashSessionsApi.current.mockResolvedValue({ data: { data: openSession } });
    renderStart();
    expect(await screen.findByText('Shift opened')).toBeTruthy();
    expect(screen.getByText('KES 21,400')).toBeTruthy();
  });

  it('counts sales waiting to sync and calls out any the server rejected', () => {
    useOfflineQueue.setState({ queue: [
      { clientSaleId: 'a', payload: {}, ringedUpAt: '', attempts: 0 },
      { clientSaleId: 'b', payload: {}, ringedUpAt: '', attempts: 0 },
      { clientSaleId: 'c', payload: {}, ringedUpAt: '', attempts: 1, failed: true },
    ] });
    renderStart();
    expect(screen.getByText('2 sales')).toBeTruthy();
    expect(screen.getByText('Rejected by the server')).toBeTruthy();
    expect(screen.getByText('1 sale')).toBeTruthy();
  });
});
