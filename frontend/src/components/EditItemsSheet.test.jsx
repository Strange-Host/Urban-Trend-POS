import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const replaceItems = vi.fn();
const productsList = vi.fn();
vi.mock('../api/endpoints', () => ({ ordersApi: { replaceItems: (...a) => replaceItems(...a) }, productsApi: { list: (...a) => productsList(...a) } }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('./Picker', () => ({
  default: ({ value, onChange, options, 'aria-label': label }) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import EditItemsSheet from './EditItemsSheet';

const products = [{ id: 1, name: 'Crew Tee', sell_price: 150000 }, { id: 2, name: 'Cap', sell_price: 50000 }];
const order = {
  id: 7, product_code: 'UT000007', total: 150000, discount_total: 0, customer: { name: 'Jane' },
  items: [{ id: 11, product_id: 1, product_name: 'Crew Tee', quantity: 1, unit_price: 150000, discount: 0 }],
};
const mount = () => { const onSaved = vi.fn(); const onClose = vi.fn(); render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EditItemsSheet order={order} onClose={onClose} onSaved={onSaved} /></QueryClientProvider>); return { onSaved, onClose }; };

beforeEach(() => { replaceItems.mockReset(); replaceItems.mockResolvedValue({}); productsList.mockReset(); productsList.mockResolvedValue({ data: { data: products, totalPages: 1 } }); });

describe('EditItemsSheet', () => {
  it('starts from the items already on the order', () => {
    mount();
    expect(screen.getByText('Crew Tee')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity 1')).toHaveValue(1);
  });

  it('sends the whole list the order should end up with when a quantity changes and a product is added', async () => {
    const { onSaved } = mount();
    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add another product' }));
    await screen.findByRole('option', { name: 'Cap' });
    fireEvent.change(screen.getByLabelText('Product 2'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(replaceItems).toHaveBeenCalledWith(7, [{ product_id: 1, quantity: 3 }, { product_id: 2, quantity: 1 }]));
    expect(onSaved).toHaveBeenCalled();
  });

  it('removes a line, and will not save an empty order', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Remove item 1' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(replaceItems).not.toHaveBeenCalled();
  });

  it('shows the server\'s refusal', async () => {
    replaceItems.mockRejectedValue({ response: { data: { error: { message: 'Items cannot be changed once an order has been dispatched.' } } } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/once an order has been dispatched/);
  });
});
