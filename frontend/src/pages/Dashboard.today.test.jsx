import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { approvalsApi, couriersApi, ordersApi, paymentReconciliationApi, reportsApi, stockApi } from '../api/endpoints';
import { setUiVersion } from '../utils/uiVersion';

vi.mock('../api/endpoints', () => ({
  reportsApi: {
    salesSummary: vi.fn(), inventoryValue: vi.fn(), salesByChannel: vi.fn(), salesTrend: vi.fn(),
    paymentMethods: vi.fn(), topProductsByChannel: vi.fn(), dashboardOverview: vi.fn(),
  },
  approvalsApi: { list: vi.fn() },
  couriersApi: { payables: vi.fn() },
  ordersApi: { pendingOwnerDecision: vi.fn() },
  paymentReconciliationApi: { unmatched: vi.fn() },
  stockApi: { alerts: vi.fn(), counts: vi.fn(), transfers: vi.fn() },
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'Ann Admin', role: 'admin' }, can: () => true, hasRole: () => true }),
}));
vi.mock('../components/RevenueChart', () => ({ default: () => null }));
vi.mock('../hooks/useSlidingPill', () => ({ default: () => ({ rootRef: { current: null }, pillProps: {} }) }));

const ok = (data) => Promise.resolve({ data: { data } });
const res = (body) => Promise.resolve({ data: body });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  reportsApi.salesSummary.mockReturnValue(ok({ revenue: 100000, transaction_count: 3 }));
  reportsApi.inventoryValue.mockReturnValue(ok({ total_retail_value: 500000 }));
  reportsApi.salesByChannel.mockReturnValue(ok([]));
  reportsApi.salesTrend.mockReturnValue(ok([]));
  reportsApi.paymentMethods.mockReturnValue(ok([]));
  reportsApi.topProductsByChannel.mockReturnValue(ok({}));
  reportsApi.dashboardOverview.mockReturnValue(ok({ lowStockCount: 0, unpaidParcelsByCourier: [] }));
  stockApi.alerts.mockReturnValue(ok({ counts: { expiring: 0, expired: 0, recalled: 0, damaged_units_30d: 0, damaged_returns_awaiting_decision: 0 }, window_days: 30 }));
  approvalsApi.list.mockReturnValue(res({ pending: 2, total: 2, data: [] }));
  paymentReconciliationApi.unmatched.mockReturnValue(res({ total: 0, data: [] }));
  stockApi.counts.mockReturnValue(res({ total: 0, data: [] }));
  stockApi.transfers.mockReturnValue(res({ total: 1, data: [] }));
  couriersApi.payables.mockReturnValue(res({ data: [] }));
  ordersApi.pendingOwnerDecision.mockReturnValue(res({ total: 0, data: [] }));
});

describe('Dashboard with the current layout', () => {
  it('is unchanged: no Today tabs, and none of the queue sources are asked', async () => {
    setUiVersion('v1');
    mount();
    expect(await screen.findByText('Revenue')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Attention/ })).toBeNull();
    expect(approvalsApi.list).not.toHaveBeenCalled();
    expect(stockApi.transfers).not.toHaveBeenCalled();
    expect(ordersApi.pendingOwnerDecision).not.toHaveBeenCalled();
  });
});

describe('Dashboard as Today (new layout)', () => {
  beforeEach(() => setUiVersion('v2'));

  it('has Overview and Attention tabs, with the number waiting on the Attention tab', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByRole('tab', { name: /Attention/ })).toHaveTextContent('3')); // 2 requests + 1 transfer
  });

  it('keeps the existing KPIs on Overview', async () => {
    mount();
    expect(await screen.findByText('Revenue')).toBeInTheDocument();
    expect(screen.getByText('Revenue trend')).toBeInTheDocument();
  });

  it('shows the queue on Attention, in place of the KPIs, and goes back', async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByText('Revenue');
    await user.click(screen.getByRole('tab', { name: /Attention/ }));
    expect(await screen.findByRole('link', { name: /Void and refund requests/ })).toHaveAttribute('href', '/approvals');
    expect(screen.getByRole('link', { name: /Transfers to approve/ })).toHaveAttribute('href', '/stock?tab=transfers');
    expect(screen.queryByText('Revenue trend')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByText('Revenue trend')).toBeInTheDocument();
  });
});
