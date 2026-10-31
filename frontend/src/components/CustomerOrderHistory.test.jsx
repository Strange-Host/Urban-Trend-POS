import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const orders = vi.fn();

vi.mock('../api/endpoints', () => ({ customersApi: { orders: (...a) => orders(...a) } }));

import CustomerOrderHistory from './CustomerOrderHistory';

const reply = (over = {}) => ({
  data: {
    data: [
      { id: 12, product_code: 'UT000012', status: 'awaiting_dispatch', total: 250000, item_count: 2, created_at: '2026-10-20 08:00:00' },
      { id: 9, product_code: 'UT000009', status: 'dispatched_paid', total: 100000, item_count: 1, created_at: '2026-09-01 08:00:00' },
    ],
    total: 2,
    summary: { orders: 2, total_ordered: 350000, total_paid: 100000, outstanding: 250000, cancelled: 0, returned: 1, first_order_at: '2026-09-01 08:00:00', last_order_at: '2026-10-20 08:00:00' },
    ...over,
  },
});

function renderPanel(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelectOrder = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CustomerOrderHistory customerId={4} currentOrderId={12} onSelectOrder={onSelectOrder} statusLabels={{ awaiting_dispatch: 'Awaiting dispatch' }} {...props} />
    </QueryClientProvider>
  );
  return { onSelectOrder };
}

beforeEach(() => { orders.mockReset(); orders.mockResolvedValue(reply()); });

describe('CustomerOrderHistory', () => {
  it('shows the order count and amount owed while collapsed', async () => {
    renderPanel();
    expect(await screen.findByText(/2 orders/)).toBeTruthy();
    expect(screen.getByText(/owed/)).toBeTruthy();
    expect(screen.queryByText('UT000009')).toBeNull();
  });

  it('lists the orders when opened, and marks the one being viewed', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /customer order history/i }));
    expect(await screen.findByText('UT000009')).toBeTruthy();
    expect(screen.getByText(/this order/)).toBeTruthy();
    expect(screen.getByText('Awaiting dispatch')).toBeTruthy();
    expect(screen.getByText(/1 returned/)).toBeTruthy();
  });

  it('opens another order from the list but not the current one', async () => {
    const { onSelectOrder } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /customer order history/i }));
    fireEvent.click(await screen.findByText('UT000009'));
    expect(onSelectOrder).toHaveBeenCalledWith(9);
    fireEvent.click(screen.getByText('UT000012'));
    expect(onSelectOrder).toHaveBeenCalledTimes(1);
  });

  it('asks for the next page of older orders', async () => {
    orders.mockResolvedValue(reply({ total: 12 }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /customer order history/i }));
    fireEvent.click(await screen.findByText('Older'));
    await waitFor(() => expect(orders).toHaveBeenCalledWith(4, { page: 2, limit: 5 }));
  });

  it('renders nothing without a customer', () => {
    renderPanel({ customerId: undefined });
    expect(orders).not.toHaveBeenCalled();
    expect(screen.queryByText(/customer order history/i)).toBeNull();
  });
});
