import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import useAttentionQueue from './useAttentionQueue';
import { approvalsApi, couriersApi, ordersApi, paymentReconciliationApi, stockApi } from '../api/endpoints';

const auth = { perms: [], roles: ['manager'] };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ can: (p) => auth.perms.includes(p), hasRole: (...r) => r.some((x) => auth.roles.includes(x)) }),
}));
vi.mock('../api/endpoints', () => ({
  approvalsApi: { list: vi.fn() },
  couriersApi: { payables: vi.fn() },
  ordersApi: { pendingOwnerDecision: vi.fn() },
  paymentReconciliationApi: { unmatched: vi.fn() },
  stockApi: { counts: vi.fn(), transfers: vi.fn() },
}));

const ALL = ['approvals.review', 'payments.reconcile', 'stock.review', 'stock.count', 'stock.transfer', 'couriers.pay'];
const wrap = ({ children }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
const res = (data) => Promise.resolve({ data });
const allCalls = () => [approvalsApi.list, couriersApi.payables, ordersApi.pendingOwnerDecision, paymentReconciliationApi.unmatched, stockApi.counts, stockApi.transfers];

beforeEach(() => {
  vi.clearAllMocks();
  auth.perms = ALL;
  auth.roles = ['manager'];
  approvalsApi.list.mockReturnValue(res({ pending: 2, total: 2, data: [] }));
  paymentReconciliationApi.unmatched.mockReturnValue(res({ total: 3, data: [] }));
  stockApi.counts.mockReturnValue(res({ total: 1, data: [] }));
  stockApi.transfers.mockReturnValue(res({ total: 4, data: [] }));
  couriersApi.payables.mockReturnValue(res({ data: [{ total_owed: 250000, pending_costs: 0 }, { total_owed: 50000, pending_costs: 1 }] }));
  ordersApi.pendingOwnerDecision.mockReturnValue(res({ total: 5, data: [] }));
});

const run = (options) => renderHook(() => useAttentionQueue(options), { wrapper: wrap });

describe('useAttentionQueue', () => {
  it('lists what is waiting, worst first, with where each one is dealt with', async () => {
    const { result } = run();
    await waitFor(() => expect(result.current.items).toHaveLength(6));
    expect(result.current.items.map((i) => i.id)).toEqual(['damaged', 'unmatched', 'couriers', 'approvals', 'counts', 'transfers']);
    expect(Object.fromEntries(result.current.items.map((i) => [i.id, i.to]))).toEqual({
      damaged: '/orders', unmatched: '/reconciliation', couriers: '/finance?tab=couriers',
      approvals: '/approvals', counts: '/stock?tab=counts', transfers: '/stock?tab=transfers',
    });
    expect(result.current.items.find((i) => i.id === 'approvals').count).toBe(2);
    expect(result.current.items.find((i) => i.id === 'couriers').detail).toContain('KES 3,000'); // (250000 + 50000) cents
    expect(result.current.count).toBe(5 + 3 + 2 + 2 + 1 + 4);
    expect(result.current.quiet).toEqual([]);
  });

  it('puts a clear source in the quiet list, not the queue', async () => {
    approvalsApi.list.mockReturnValue(res({ pending: 0, total: 0, data: [] }));
    const { result } = run();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(result.current.items.map((i) => i.id)).not.toContain('approvals');
    expect(result.current.quiet).toEqual(['Void and refund requests']);
  });

  it('asks only the sources this person may see', async () => {
    auth.perms = ['approvals.review', 'couriers.pay'];
    const { result } = run();
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['damaged', 'couriers', 'approvals']));
    expect(paymentReconciliationApi.unmatched).not.toHaveBeenCalled();
    expect(stockApi.counts).not.toHaveBeenCalled();
    expect(stockApi.transfers).not.toHaveBeenCalled();
  });

  it('needs both review and the stock permission for counts and transfers', async () => {
    auth.perms = ['stock.count', 'stock.transfer']; // may file them, may not review them
    run();
    await new Promise((r) => setTimeout(r, 30));
    expect(stockApi.counts).not.toHaveBeenCalled();
    expect(stockApi.transfers).not.toHaveBeenCalled();
  });

  it('asks nothing of a cashier, who reviews nothing', async () => {
    auth.perms = [];
    auth.roles = ['cashier'];
    const { result } = run();
    await new Promise((r) => setTimeout(r, 30));
    allCalls().forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(result.current).toMatchObject({ items: [], quiet: [], count: 0, isLoading: false });
  });

  it('asks nothing at all when disabled (people on the current layout)', async () => {
    const { result } = run({ enabled: false });
    await new Promise((r) => setTimeout(r, 30));
    allCalls().forEach((fn) => expect(fn).not.toHaveBeenCalled());
    expect(result.current.items).toEqual([]);
  });
});
