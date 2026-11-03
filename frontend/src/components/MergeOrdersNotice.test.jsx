import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mergeGroups = vi.fn();
const mergeOrders = vi.fn();
const confirm = vi.fn();
vi.mock('../api/endpoints', () => ({ ordersApi: { mergeGroups: (...a) => mergeGroups(...a), mergeOrders: (...a) => mergeOrders(...a) } }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({ confirm }) }));

import MergeOrdersNotice from './MergeOrdersNotice';

const group = {
  customer_id: 3, customer_name: 'Jane Wanjiru', suggested_keep_order_id: 1, combined_subtotal: 250000,
  orders: [
    { id: 1, product_code: 'UT000001', subtotal: 150000, items: [{ quantity: 1, product_name: 'Crew Tee' }] },
    { id: 2, product_code: 'UT000002', subtotal: 100000, items: [{ quantity: 2, product_name: 'Cap' }] },
  ],
};
const mount = (order) => { const onMerged = vi.fn(); render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MergeOrdersNotice order={order} onMerged={onMerged} /></QueryClientProvider>); return { onMerged }; };

beforeEach(() => { mergeGroups.mockReset(); mergeOrders.mockReset(); confirm.mockReset(); });

describe('MergeOrdersNotice', () => {
  it('says the customer asked for more than one product and lists the orders', async () => {
    mergeGroups.mockResolvedValue({ data: { data: [group] } });
    mount({ id: 2, status: 'awaiting_dispatch' });
    expect(await screen.findByText(/Jane Wanjiru has asked for more than one product/)).toBeInTheDocument();
    expect(screen.getByText(/1 × Crew Tee/)).toBeInTheDocument();
    expect(screen.getByText(/2 × Cap/)).toBeInTheDocument();
  });

  it('merges only after permission is given', async () => {
    mergeGroups.mockResolvedValue({ data: { data: [group] } });
    mergeOrders.mockResolvedValue({});
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { onMerged } = mount({ id: 2, status: 'awaiting_dispatch' });
    const button = await screen.findByRole('button', { name: /Merge into one order/ });

    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(mergeOrders).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(mergeOrders).toHaveBeenCalledWith(1, [2]));
    expect(onMerged).toHaveBeenCalledWith(1);
  });

  it('shows nothing for a dispatched order or a customer with a single order', async () => {
    mergeGroups.mockResolvedValue({ data: { data: [] } });
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MergeOrdersNotice order={{ id: 9, status: 'dispatched_paid' }} /></QueryClientProvider>);
    expect(container).toBeEmptyDOMElement();
    expect(mergeGroups).not.toHaveBeenCalled();
  });
});
