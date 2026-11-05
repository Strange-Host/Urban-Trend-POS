import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import POSTerminal from './POSTerminal';
import { salesApi, productsApi } from '../api/endpoints';
import useCartStore from '../hooks/useCartStore';
import useOfflineQueue from '../hooks/useOfflineQueue';

vi.mock('../api/endpoints', () => ({
  salesApi: { checkout: vi.fn() },
  productsApi: { list: vi.fn(), getByBarcode: vi.fn() },
  receiptsApi: { sale: vi.fn() },
}));
vi.mock('../components/ShiftWidget', () => ({ default: () => null }));
vi.mock('../components/PrintReceipt', () => ({ default: () => null }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({}) }));

const product = { id: 1, name: 'Hoodie', sku: 'H-1', sell_price: 150000, tax_rate: 0, total_stock: 10 };
const httpError = (status, message) => Object.assign(new Error(message), { response: { status, data: { error: { message } } } });

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><POSTerminal /></QueryClientProvider>);
}

beforeEach(() => {
  salesApi.checkout.mockReset();
  productsApi.list.mockResolvedValue({ data: { data: [product] } });
  useCartStore.setState({ items: [{ product_id: 1, name: 'Hoodie', sku: 'H-1', unit_price: 150000, tax_rate: 0, quantity: 1, available: 10 }] });
  useOfflineQueue.setState({ queue: [], syncing: false, lastSyncError: '' });
});

describe('POS terminal: offline and rejected sales', () => {
  it('a connection failure queues the sale with its id, empties the cart and says it was saved offline', async () => {
    salesApi.checkout.mockRejectedValue(new Error('Network Error'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    await waitFor(() => expect(useOfflineQueue.getState().queue).toHaveLength(1));
    const sent = salesApi.checkout.mock.calls[0][0];
    expect(useOfflineQueue.getState().queue[0].clientSaleId).toBe(sent.clientSaleId);
    expect(useOfflineQueue.getState().queue[0].payload).toMatchObject({ items: [{ product_id: 1, quantity: 1 }], payments: [{ method: 'cash', amount: 150000 }] });
    expect(useCartStore.getState().items).toEqual([]);
    expect(await screen.findByText(/saved offline/i)).toBeTruthy();
  });

  it('a server error (5xx) is also queued rather than lost', async () => {
    salesApi.checkout.mockRejectedValue(httpError(503, 'Service unavailable'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    await waitFor(() => expect(useOfflineQueue.getState().queue).toHaveLength(1));
  });

  it('a 4xx rejection is NOT queued: the error shows and the cart stays for the cashier to fix', async () => {
    salesApi.checkout.mockRejectedValue(httpError(400, 'Not enough stock for Hoodie.'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Charge' }));
    expect(await screen.findByText('Not enough stock for Hoodie.')).toBeTruthy();
    expect(useOfflineQueue.getState().queue).toEqual([]);
    expect(useCartStore.getState().items).toHaveLength(1);
  });

  it('shows how many offline sales are waiting, with a Retry now button that syncs', async () => {
    const sync = vi.fn();
    useOfflineQueue.setState({
      queue: [{ clientSaleId: 'q1', payload: { payments: [{ method: 'cash', amount: 1000 }] }, ringedUpAt: new Date().toISOString(), attempts: 0, lastError: '' }],
      sync,
    });
    mount();
    expect(await screen.findByText(/Waiting to send 1 offline sale/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(sync).toHaveBeenCalled();
  });

  it('lists a sale the server rejected, with the reason, and only Dismiss removes it', async () => {
    useOfflineQueue.setState({
      queue: [{ clientSaleId: 'bad1', failed: true, payload: { payments: [{ method: 'cash', amount: 250000 }] }, ringedUpAt: new Date().toISOString(), attempts: 1, lastError: 'Not enough stock for Tee.' }],
    });
    mount();
    expect(await screen.findByText(/1 offline sale the server rejected/i)).toBeTruthy();
    const item = screen.getByText(/Not enough stock for Tee\./).closest('li');
    expect(within(item).getByText(/2500\.00/)).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Dismiss' }));
    expect(useOfflineQueue.getState().queue).toEqual([]);
  });
});
