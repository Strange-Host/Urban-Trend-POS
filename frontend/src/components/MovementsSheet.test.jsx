import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MovementsSheet, { movementLabel, referenceLabel } from './MovementsSheet';
import { inventoryApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({ inventoryApi: { movements: vi.fn() } }));

const product = { id: 7, name: 'Blue Tee', sku: 'TEE-BLU' };
const body = (rows, o = {}) => Promise.resolve({ data: { data: rows, page: 1, limit: 25, total: rows.length, totalPages: 1, ...o } });
const mv = (o) => ({ id: 1, change_qty: -2, reason: 'sale', reference_type: 'sale', reference_id: 12, user_name: 'Grace', created_at: '2026-10-30 09:15:00', ...o });
const mount = (props = {}) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MovementsSheet product={product} onClose={() => {}} {...props} />
  </QueryClientProvider>,
);

// A block body on purpose: a function returned from beforeEach is run as a teardown, and mockReset() returns the mock.
beforeEach(() => { inventoryApi.movements.mockReset(); });

describe('labels', () => {
  it('turns ledger reasons and references into words, and falls back to the raw value', () => {
    expect(movementLabel('transfer_in')).toBe('Arrived on a transfer');
    expect(movementLabel('something_new')).toBe('something_new');
    expect(referenceLabel({ reference_type: 'order', reference_id: 40 })).toBe('Order #40');
    expect(referenceLabel({ reference_type: null, reference_id: null })).toBe('');
  });
});

describe('MovementsSheet', () => {
  it('shows date, type, signed quantity, who and the reference for each movement', async () => {
    inventoryApi.movements.mockReturnValue(body([
      mv(),
      mv({ id: 2, change_qty: 20, reason: 'receipt', reference_type: 'receipt', reference_id: 4, user_name: null, created_at: '2026-10-29 08:00:00' }),
    ]));
    mount();
    expect(await screen.findByText('Grace')).toBeInTheDocument();
    expect(screen.getByText('Blue Tee', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('2026-10-30 09:15')).toBeInTheDocument();
    expect(screen.getByText('Sale #12')).toBeInTheDocument();
    expect(screen.getByText('-2')).toBeInTheDocument();
    expect(screen.getByText('Shipment received')).toBeInTheDocument();
    expect(screen.getByText('+20')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();      // no user on the row
    expect(screen.getByText('Receipt #4')).toBeInTheDocument();
    expect(screen.getByText('Showing all 2 movements')).toBeInTheDocument();
  });

  it('asks for the first page of this product at the viewer\'s own branch by default', async () => {
    inventoryApi.movements.mockReturnValue(body([mv()]));
    mount();
    await screen.findByText('Grace');
    expect(inventoryApi.movements).toHaveBeenCalledWith(7, { page: 1, limit: 25, pageSize: 25 });
  });

  it('asks for another branch when a store is given', async () => {
    inventoryApi.movements.mockReturnValue(body([mv()]));
    mount({ storeParams: { store_id: 3 } });
    await screen.findByText('Grace');
    expect(inventoryApi.movements).toHaveBeenCalledWith(7, { page: 1, limit: 25, pageSize: 25, store_id: 3 });
  });

  it('pages through the ledger', async () => {
    const first = Array.from({ length: 25 }, (_, i) => mv({ id: 100 - i, user_name: 'Grace' }));
    const second = [mv({ id: 70, user_name: 'Peter', change_qty: 5, reason: 'restock', reference_type: null, reference_id: null })];
    inventoryApi.movements.mockImplementation((id, p) => (p.page === 2
      ? body(second, { page: 2, total: 26, totalPages: 2 })
      : body(first, { total: 26, totalPages: 2 })));
    mount();
    expect(await screen.findByText(/Showing/)).toHaveTextContent('1-25 of 26 movements');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Peter')).toBeInTheDocument();
    expect(inventoryApi.movements).toHaveBeenLastCalledWith(7, expect.objectContaining({ page: 2, limit: 25 }));
    expect(screen.getByText('Restocked')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    inventoryApi.movements.mockReturnValue(body([]));
    mount();
    expect(await screen.findByText('No movements recorded for this product.')).toBeInTheDocument();
  });

  it('shows the server message when the ledger cannot load, not an empty list', async () => {
    inventoryApi.movements.mockRejectedValue({ response: { data: { error: { message: 'You can only look at your own branch.' } } } });
    mount({ storeParams: { store_id: 3 } });
    expect(await screen.findByRole('alert')).toHaveTextContent('You can only look at your own branch.');
    expect(screen.queryByText('No movements recorded for this product.')).not.toBeInTheDocument();
  });

  it('closes from the Close button', async () => {
    inventoryApi.movements.mockReturnValue(body([mv()]));
    const onClose = vi.fn();
    mount({ onClose });
    await screen.findByText('Grace');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
