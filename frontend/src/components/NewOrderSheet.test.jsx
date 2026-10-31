import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NewOrderSheet from './NewOrderSheet';
import { ordersApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({ ordersApi: { create: vi.fn() }, productsApi: { list: vi.fn() } }));
vi.mock('../api/fetchAll', () => ({
  fetchAll: vi.fn(() => Promise.resolve([{ id: 4, name: 'Serum', sell_price: 150000 }, { id: 5, name: 'Soap', sell_price: 20000 }])),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast }));

const mount = (props = {}) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <NewOrderSheet onClose={vi.fn()} onCreated={vi.fn()} {...props} />
  </QueryClientProvider>,
);

async function pickProduct(index, name) {
  fireEvent.click(screen.getByRole('button', { name: `Product ${index}` }));
  fireEvent.click(await screen.findByText(name));
}

beforeEach(() => {
  ordersApi.create.mockReset();
  [toast.success, toast.error].forEach((f) => f.mockReset());
});

describe('NewOrderSheet', () => {
  it('keeps Create disabled until a product is chosen', async () => {
    mount();
    expect(screen.getByRole('button', { name: 'Create order' })).toBeDisabled();
    await pickProduct(1, 'Serum');
    expect(screen.getByRole('button', { name: 'Create order' })).toBeEnabled();
  });

  it('sends the phone, items and payment type on the manual channel and reports the new order', async () => {
    ordersApi.create.mockResolvedValue({ data: { data: { id: 12, product_code: 'UT-12' } } });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mount({ onCreated, onClose });
    fireEvent.change(screen.getByLabelText('Customer phone'), { target: { value: ' 0712345678 ' } });
    fireEvent.change(screen.getByLabelText(/Customer name/), { target: { value: 'Wanjiru' } });
    fireEvent.change(screen.getByLabelText('Payment'), { target: { value: 'prepaid' } });
    await pickProduct(1, 'Serum');
    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(ordersApi.create).toHaveBeenCalledTimes(1));
    expect(ordersApi.create).toHaveBeenCalledWith({
      phone: '0712345678', name: 'Wanjiru', payment_type: 'prepaid', channel: 'manual', items: [{ product_id: 4, quantity: 2 }],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 12, product_code: 'UT-12' }));
    expect(onClose).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Order UT-12 created.');
  });

  it('shows the server message and stays open when the order is refused', async () => {
    ordersApi.create.mockRejectedValue({ response: { data: { error: 'Not enough stock for Serum.' } } });
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.change(screen.getByLabelText('Customer phone'), { target: { value: '0712345678' } });
    await pickProduct(1, 'Serum');
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Not enough stock|Could not create/);
    expect(onClose).not.toHaveBeenCalled();
  });
});
