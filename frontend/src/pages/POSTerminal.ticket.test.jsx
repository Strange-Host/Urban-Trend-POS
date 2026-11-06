import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import POSTerminal from './POSTerminal';
import { salesApi, productsApi, categoriesApi } from '../api/endpoints';
import useCartStore from '../hooks/useCartStore';
import useOfflineQueue from '../hooks/useOfflineQueue';

vi.mock('../api/endpoints', () => ({
  salesApi: { checkout: vi.fn(), discountLimit: vi.fn() },
  productsApi: { list: vi.fn(), getByBarcode: vi.fn() },
  categoriesApi: { list: vi.fn() },
  receiptsApi: { sale: vi.fn() },
}));
// The real widget has its own behaviour; here only what the till asks of it matters.
vi.mock('../components/ShiftWidget', () => ({
  default: ({ closeRequest }) => <span data-testid="close-requests">{closeRequest}</span>,
}));
vi.mock('../components/PrintReceipt', () => ({ default: () => null }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({}) }));

const hoodie = { id: 1, name: 'Hoodie', sku: 'H-1', sell_price: 150000, tax_rate: 0, total_stock: 10 };
const cap = { id: 2, name: 'Cap', sku: 'C-1', sell_price: 50000, tax_rate: 0, total_stock: 10 };
const line = { product_id: 1, name: 'Hoodie', sku: 'H-1', unit_price: 150000, tax_rate: 0, quantity: 1, available: 10 };

function Where() { const l = useLocation(); return <span data-testid="where">{l.pathname + l.search}</span>; }
function mount(url = '/terminal') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}><POSTerminal /><Where /></MemoryRouter>
    </QueryClientProvider>,
  );
}
const discountBox = () => screen.getByLabelText(/^Discount/);

beforeEach(() => {
  salesApi.checkout.mockReset();
  salesApi.checkout.mockResolvedValue({ data: { data: { id: 9, total: 135000, payments: [{ method: 'cash', amount: 135000 }] } } });
  salesApi.discountLimit.mockResolvedValue({ data: { data: { maxPercent: 0 } } });
  categoriesApi.list.mockResolvedValue({ data: { data: [{ id: 7, name: 'Hoodies' }, { id: 8, name: 'Caps' }] } });
  productsApi.list.mockReset();
  productsApi.list.mockResolvedValue({ data: { data: [hoodie, cap] } });
  useCartStore.getState().clear();
  useCartStore.setState({ items: [line] });
  useOfflineQueue.setState({ queue: [], syncing: false, lastSyncError: '' });
});

describe('till: discount', () => {
  it('takes the discount off the total and sends it, with a payment for the discounted amount', async () => {
    mount();
    fireEvent.change(discountBox(), { target: { value: '150' } });
    expect(await screen.findByText('1350.00', { selector: 'span' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    await waitFor(() => expect(salesApi.checkout).toHaveBeenCalled());
    expect(salesApi.checkout.mock.calls[0][0]).toMatchObject({
      items: [{ product_id: 1, quantity: 1 }],
      discountTotal: 15000,
      payments: [{ method: 'cash', amount: 135000 }],
    });
  });

  it('sends no discount field when there is none', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    await waitFor(() => expect(salesApi.checkout).toHaveBeenCalled());
    expect(salesApi.checkout.mock.calls[0][0]).not.toHaveProperty('discountTotal');
  });

  it('shows the percentage it works out to', () => {
    mount();
    fireEvent.change(discountBox(), { target: { value: '150' } });
    expect(screen.getByText('10%')).toBeTruthy();
  });

  it('blocks Charge above the cashier\'s limit and says why, without calling the server', async () => {
    salesApi.discountLimit.mockResolvedValue({ data: { data: { maxPercent: 10 } } });
    mount();
    await waitFor(() => expect(salesApi.discountLimit).toHaveBeenCalled());
    fireEvent.change(discountBox(), { target: { value: '151' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Above your 10% limit');
    const charge = screen.getByRole('button', { name: 'Charge' });
    expect(charge).toBeDisabled();
    fireEvent.click(charge);
    expect(salesApi.checkout).not.toHaveBeenCalled();
  });

  it('allows a discount exactly at the limit', async () => {
    salesApi.discountLimit.mockResolvedValue({ data: { data: { maxPercent: 10 } } });
    mount();
    await waitFor(() => expect(salesApi.discountLimit).toHaveBeenCalled());
    fireEvent.change(discountBox(), { target: { value: '150' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Charge' })).not.toBeDisabled();
  });

  it('cannot take the total below zero: a larger discount is cut back to the subtotal', () => {
    mount();
    fireEvent.change(discountBox(), { target: { value: '99999' } });
    expect(discountBox()).toHaveValue('1500.00');
    expect(useCartStore.getState().discount).toBe(150000);
  });

  it('queues an offline sale with its discount, and the next sale starts with none', async () => {
    salesApi.checkout.mockRejectedValue(new Error('Network Error'));
    mount();
    fireEvent.change(discountBox(), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    await waitFor(() => expect(useOfflineQueue.getState().queue).toHaveLength(1));
    expect(useOfflineQueue.getState().queue[0].payload).toMatchObject({ discountTotal: 15000, payments: [{ method: 'cash', amount: 135000 }] });
    expect(useCartStore.getState().discount).toBe(0);
  });

  it('keeps the cart and the discount when the server turns the sale down', async () => {
    salesApi.checkout.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 400, data: { error: { message: 'Discount is above the 10% limit.' } } } }));
    mount();
    fireEvent.change(discountBox(), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    expect(await screen.findByText('Discount is above the 10% limit.')).toBeTruthy();
    expect(useCartStore.getState().discount).toBe(15000);
  });
});

describe('till: categories', () => {
  it('lists the categories and asks the server for just the chosen one', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Caps' }));
    await waitFor(() => expect(productsApi.list).toHaveBeenCalledWith(expect.objectContaining({ category_id: 8 })));
    expect(screen.getByRole('button', { name: 'Caps' })).toHaveAttribute('aria-pressed', 'true');
    // The first load, before any category was chosen, asked for everything.
    expect(productsApi.list.mock.calls[0][0].category_id).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'All items' }));
    expect(screen.getByRole('button', { name: 'All items' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('still sells from All items when the categories cannot be loaded', async () => {
    categoriesApi.list.mockRejectedValue(new Error('Network Error'));
    mount();
    expect(await screen.findByText('Hoodie', { selector: 'div' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All items' })).toBeTruthy();
  });
});

describe('till: shift close request', () => {
  it('asks the shift widget to open its close form for ?shift=close, then clears it from the address', async () => {
    mount('/terminal?shift=close');
    await waitFor(() => expect(screen.getByTestId('close-requests').textContent).toBe('1'));
    expect(screen.getByTestId('where').textContent).toBe('/terminal');
  });

  it('does not ask for a close on a plain visit to the till', () => {
    mount('/terminal');
    expect(screen.getByTestId('close-requests').textContent).toBe('0');
  });
});

describe('till: offline banners stay on screen', () => {
  it('shows the waiting banner above the ticket and the grid, not inside either', () => {
    useOfflineQueue.setState({ queue: [{ clientSaleId: 'q', payload: { payments: [] }, ringedUpAt: new Date().toISOString(), attempts: 0 }] });
    mount();
    const region = screen.getByRole('region', { name: 'Offline status' });
    expect(region).toHaveTextContent(/Waiting to send 1 offline sale/);
    expect(region.contains(screen.getByRole('button', { name: 'Charge' }))).toBe(false);
  });
});
