import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import POSTerminal from './POSTerminal';
import { salesApi, productsApi, categoriesApi } from '../api/endpoints';
import useCartStore from '../hooks/useCartStore';

vi.mock('../api/endpoints', () => ({
  salesApi: { checkout: vi.fn(), discountLimit: vi.fn() },
  categoriesApi: { list: vi.fn() },
  productsApi: { list: vi.fn(), getByBarcode: vi.fn() },
  receiptsApi: { sale: vi.fn() },
}));
vi.mock('../components/ShiftWidget', () => ({ default: () => null }));
vi.mock('../components/PrintReceipt', () => ({ default: () => null }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({}) }));

const product = { id: 1, name: 'Hoodie', sku: 'H-1', sell_price: 150000, tax_rate: 0, total_stock: 10 };

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><POSTerminal /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  salesApi.checkout.mockReset();
  salesApi.discountLimit.mockResolvedValue({ data: { data: { maxPercent: 0 } } });
  categoriesApi.list.mockResolvedValue({ data: { data: [] } });
  productsApi.list.mockResolvedValue({ data: { data: [product] } });
  useCartStore.setState({ items: [{ product_id: 1, name: 'Hoodie', sku: 'H-1', unit_price: 150000, tax_rate: 0, quantity: 1, available: 10 }] });
});

describe('POS terminal — split payment', () => {
  it('a normal one-method sale still sends one payment for the full total', async () => {
    salesApi.checkout.mockResolvedValue({ data: { data: { id: 5, total: 150000, payments: [{ method: 'cash', amount: 150000 }] } } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    await waitFor(() => expect(salesApi.checkout).toHaveBeenCalled());
    expect(salesApi.checkout.mock.calls[0][0].payments).toEqual([{ method: 'cash', amount: 150000 }]);
  });

  it('charges Cash + M-Pesa in one sale, with the M-Pesa code, once the amounts add up', async () => {
    salesApi.checkout.mockResolvedValue({
      data: { data: { id: 6, total: 150000, payments: [{ method: 'cash', amount: 50000 }, { method: 'mobile_money', amount: 100000 }] } },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Split payment' }));
    const charge = screen.getByRole('button', { name: 'Charge' });

    expect(charge).toBeDisabled(); // nothing entered yet
    fireEvent.change(screen.getByLabelText('Cash'), { target: { value: '500' } });
    expect(charge).toBeDisabled(); // still 1,000.00 short
    expect(screen.getByText(/1,000\.00 to go/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Put the rest on M-Pesa' }));
    expect(screen.getByLabelText('M-Pesa')).toHaveValue('1000.00');
    expect(screen.getByText('Matches the total')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('M-Pesa code'), { target: { value: 'QGH7XY12AB' } });

    expect(charge).toBeEnabled();
    fireEvent.click(charge);
    await waitFor(() => expect(salesApi.checkout).toHaveBeenCalledTimes(1));
    expect(salesApi.checkout.mock.calls[0][0].payments).toEqual([
      { method: 'cash', amount: 50000 },
      { method: 'mobile_money', amount: 100000, reference: 'QGH7XY12AB' },
    ]);
    expect(await screen.findByText(/Cash 500\.00 \+ M-Pesa 1,000\.00/)).toBeInTheDocument();
  });

  it('will not charge a split that is over the total, and says by how much', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Split payment' }));
    fireEvent.change(screen.getByLabelText('Cash'), { target: { value: '1,000' } });
    fireEvent.change(screen.getByLabelText('M-Pesa'), { target: { value: '700' } });
    expect(screen.getByText(/200\.00 too much/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge' })).toBeDisabled();
    expect(salesApi.checkout).not.toHaveBeenCalled();
  });

  it('starts the next sale with the split amounts cleared', async () => {
    salesApi.checkout.mockResolvedValue({ data: { data: { id: 7, total: 150000, payments: [] } } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Split payment' }));
    fireEvent.change(screen.getByLabelText('Cash'), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    await waitFor(() => expect(salesApi.checkout).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('Cash')).toHaveValue(''));
  });
});
