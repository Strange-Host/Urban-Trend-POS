import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import StockControl, { ReconcileTab } from './StockControl';
import { inventoryApi, productsApi, stockApi, storesApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  inventoryApi: { reconcileCheck: vi.fn(), reconcile: vi.fn(), movements: vi.fn() },
  productsApi: { list: vi.fn() },
  stockApi: { activity: vi.fn() },
  storesApi: { list: vi.fn() },
  suppliersApi: {}, categoriesApi: {}, reportsApi: {},
}));
let role = 'admin';
let perms = new Set();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role }, can: (p) => perms.has(p), hasRole: (...r) => r.includes(role) }),
}));
const toast = { success: vi.fn(), error: vi.fn() };
const dialog = { confirm: vi.fn(), prompt: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));

const ok = (data) => Promise.resolve({ data: { data } });
const movementsBody = (rows = []) => Promise.resolve({ data: { data: rows, page: 1, limit: 25, total: rows.length, totalPages: 1 } });
const stores = [{ id: 1, name: 'Main shop', is_current: true }, { id: 2, name: 'Westlands outlet' }];
const row = (o) => ({ product_id: 7, store_id: 1, product_name: 'Blue Tee', sku: 'TEE-BLU', cached_quantity: 12, ledger_quantity: 10, drift: 2, ...o });
const two = () => [row(), row({ product_id: 8, store_id: 2, product_name: 'Red Cap', sku: 'CAP-RED', cached_quantity: 3, ledger_quantity: 5, drift: -2 })];
const wrap = (ui) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);
const mountTab = (props = {}) => render(wrap(<ReconcileTab storeParams={{}} stores={stores} {...props} />));

beforeEach(() => {
  [inventoryApi.reconcileCheck, inventoryApi.reconcile, inventoryApi.movements, productsApi.list, stockApi.activity, storesApi.list,
    toast.success, toast.error, dialog.confirm].forEach((f) => f.mockReset());
  inventoryApi.movements.mockImplementation(() => movementsBody());
  role = 'admin';
  perms = new Set(['inventory.adjust', 'stock.review']);
});

describe('Reconcile tab: the check', () => {
  it('lists each row that no longer matches its ledger, with the branch and the size of the gap', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok(two()));
    mountTab();
    expect(await screen.findByText('2 rows do not match')).toBeInTheDocument();
    expect(screen.getByText('Blue Tee')).toBeInTheDocument();
    expect(screen.getByText('Main shop')).toBeInTheDocument();
    expect(screen.getByText('Westlands outlet')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('-2')).toBeInTheDocument();
  });

  it('says everything matches when there is no drift', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok([]));
    mountTab();
    expect(await screen.findByText('Everything matches')).toBeInTheDocument();
    expect(screen.getByText(/No differences/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reset/ })).not.toBeInTheDocument();
  });

  it('shows the server message when the check cannot run, instead of "everything matches"', async () => {
    inventoryApi.reconcileCheck.mockRejectedValue({ response: { data: { error: { message: 'You do not have permission.' } } } });
    mountTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission.');
    expect(screen.queryByText('Everything matches')).not.toBeInTheDocument();
  });

  it('warns that a row whose ledger is below zero will stay listed after a reset', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok([row({ cached_quantity: 2, ledger_quantity: -3, drift: 5 })]));
    mountTab();
    expect(await screen.findByText(/a reset sets stock to 0 and this row stays listed/)).toBeInTheDocument();
  });

  it('checks again on request', async () => {
    inventoryApi.reconcileCheck.mockReturnValueOnce(ok(two())).mockReturnValue(ok([]));
    mountTab();
    await screen.findByText('2 rows do not match');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Everything matches')).toBeInTheDocument();
    expect(inventoryApi.reconcileCheck).toHaveBeenCalledTimes(2);
  });
});

describe('Reconcile tab: resetting to the ledger', () => {
  it('resets after the admin confirms, then re-checks', async () => {
    inventoryApi.reconcileCheck.mockReturnValueOnce(ok(two())).mockReturnValue(ok([]));
    inventoryApi.reconcile.mockReturnValue(ok(two()));
    dialog.confirm.mockResolvedValue(true);
    mountTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset 2 to the ledger' }));
    await waitFor(() => expect(inventoryApi.reconcile).toHaveBeenCalledTimes(1));
    expect(dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true, confirmLabel: 'Reset 2 rows' }));
    expect(dialog.confirm.mock.calls[0][0].message).toMatch(/across all branches/);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 rows reset to the ledger.'));
    expect(await screen.findByText('Everything matches')).toBeInTheDocument();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok(two()));
    dialog.confirm.mockResolvedValue(false);
    mountTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset 2 to the ledger' }));
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalled());
    expect(inventoryApi.reconcile).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports the API message when the reset is refused', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok(two()));
    inventoryApi.reconcile.mockRejectedValue({ response: { data: { error: { message: 'Admin only.' } } } });
    dialog.confirm.mockResolvedValue(true);
    mountTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset 2 to the ledger' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Admin only.'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('hides the reset from anyone who is not an admin, and says why', async () => {
    role = 'manager';
    inventoryApi.reconcileCheck.mockReturnValue(ok(two()));
    mountTab();
    await screen.findByText('2 rows do not match');
    expect(screen.queryByRole('button', { name: /^Reset/ })).not.toBeInTheDocument();
    expect(screen.getByText('Only an admin can reset these figures.')).toBeInTheDocument();
  });
});

describe('Reconcile tab: movements', () => {
  it('opens the movements of a drifted row at its own branch', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok(two()));
    mountTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Movements for Blue Tee' }));
    await waitFor(() => expect(inventoryApi.movements).toHaveBeenCalledWith(7, { page: 1, limit: 25, pageSize: 25 }));
    expect(screen.getByText('Stock movements')).toBeInTheDocument();
  });

  it('names the other branch when the drifted row belongs to one', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok(two()));
    mountTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Movements for Red Cap' }));
    await waitFor(() => expect(inventoryApi.movements).toHaveBeenCalledWith(8, { page: 1, limit: 25, pageSize: 25, store_id: 2 }));
  });

  it('hides Movements for another branch from someone who cannot review stock', async () => {
    perms = new Set(['inventory.adjust']);
    inventoryApi.reconcileCheck.mockReturnValue(ok(two()));
    mountTab();
    await screen.findByText('2 rows do not match');
    expect(screen.getByRole('button', { name: 'Movements for Blue Tee' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Movements for Red Cap' })).not.toBeInTheDocument();
  });

  it('opens the movements of any product found by search, at the branch being viewed', async () => {
    inventoryApi.reconcileCheck.mockReturnValue(ok([]));
    productsApi.list.mockReturnValue(ok([{ id: 9, name: 'Green Hat', sku: 'HAT-GRN' }]));
    mountTab({ storeParams: { store_id: '2' } });
    fireEvent.change(await screen.findByPlaceholderText(/Search by name or SKU/), { target: { value: 'green' } });
    fireEvent.click(await screen.findByRole('button', { name: /Green Hat/ }));
    await waitFor(() => expect(inventoryApi.movements).toHaveBeenCalledWith(9, { page: 1, limit: 25, pageSize: 25, store_id: '2' }));
  });
});

describe('Stock control: who sees the Reconcile tab', () => {
  const mountPage = () => {
    storesApi.list.mockReturnValue(ok(stores));
    inventoryApi.reconcileCheck.mockReturnValue(ok([]));
    stockApi.activity.mockReturnValue(ok({ entries: [], summary: [] }));
    return render(wrap(<StockControl />));
  };

  it('shows it to someone who may adjust stock', async () => {
    perms = new Set(['inventory.adjust']);
    mountPage();
    expect(await screen.findByRole('tab', { name: 'Reconcile' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Everything matches')).toBeInTheDocument();
  });

  it('hides it from someone who may not', async () => {
    perms = new Set(['stock.review']);
    mountPage();
    expect(await screen.findByRole('tab', { name: 'Who did what' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Reconcile' })).not.toBeInTheDocument();
    expect(inventoryApi.reconcileCheck).not.toHaveBeenCalled();
  });
});
