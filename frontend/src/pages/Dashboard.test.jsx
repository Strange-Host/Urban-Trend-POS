import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { reportsApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  reportsApi: {
    salesSummary: vi.fn(), inventoryValue: vi.fn(), salesByChannel: vi.fn(), salesTrend: vi.fn(),
    paymentMethods: vi.fn(), topProductsByChannel: vi.fn(), dashboardOverview: vi.fn(),
  },
}));
// No queue permissions, so the Attention queue asks for nothing and this file stays about the Overview tiles (Dashboard.today.test.jsx covers the queue).
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Ann Admin', role: 'admin' }, can: () => false, hasRole: () => false }) }));
vi.mock('../components/RevenueChart', () => ({ default: () => null }));
vi.mock('../hooks/useSlidingPill', () => ({ default: () => ({ rootRef: { current: null }, pillProps: {} }) }));

const ok = (data) => Promise.resolve({ data: { data } });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  reportsApi.salesSummary.mockReturnValue(ok({ revenue: 100000, transaction_count: 3 }));
  reportsApi.inventoryValue.mockReturnValue(ok({ total_retail_value: 500000 }));
  reportsApi.salesByChannel.mockReturnValue(ok([]));
  reportsApi.salesTrend.mockReturnValue(ok([]));
  reportsApi.paymentMethods.mockReturnValue(ok([]));
  reportsApi.topProductsByChannel.mockReturnValue(ok({}));
});

describe('Dashboard alert tiles', () => {
  it('shows the low-stock count and the unpaid-parcel total with the money still owed', async () => {
    reportsApi.dashboardOverview.mockReturnValue(ok({
      lowStockCount: 4,
      unpaidParcelsByCourier: [
        { courier_type: 'boda', parcel_count: 2, capital_tied_up: 150000 },
        { courier_type: 'g4s', parcel_count: 3, capital_tied_up: 50000 },
      ],
    }));
    mount();
    expect(await screen.findByText('Low stock')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy(); // 2 + 3 parcels
    expect(screen.getByText(/KES 2,000 still owed/)).toBeTruthy();
    expect(screen.getByText('Low stock').closest('a').getAttribute('href')).toBe('/stock');
    expect(screen.getByText('Unpaid parcels').closest('a').getAttribute('href')).toBe('/money-at-risk');
  });

  it('shows an all-clear message when nothing needs attention', async () => {
    reportsApi.dashboardOverview.mockReturnValue(ok({ lowStockCount: 0, unpaidParcelsByCourier: [] }));
    mount();
    expect(await screen.findByText('All clear')).toBeTruthy();
    expect(screen.getByText(/Checked: Low stock, Unpaid parcels/)).toBeTruthy();
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('shows only the checks that found something, worst first, and folds the rest into one line', async () => {
    reportsApi.dashboardOverview.mockReturnValue(ok({ lowStockCount: 4, unpaidParcelsByCourier: [] }));
    reportsApi.salesSummary.mockReturnValue(ok({ revenue: 100000, transaction_count: 3 }));
    mount();
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('Low stock')).toBeTruthy();
    expect(screen.queryByText('Unpaid parcels', { selector: 'div' })).toBeNull(); // quiet: no tile
    expect(screen.getByText(/All clear: Unpaid parcels/)).toBeTruthy();
  });
});

describe('Dashboard revenue cards', () => {
  it('shows how revenue moved against the previous period', async () => {
    reportsApi.dashboardOverview.mockReturnValue(ok({ lowStockCount: 0, unpaidParcelsByCourier: [] }));
    // first call = this period, second = the period before it
    reportsApi.salesSummary
      .mockReturnValueOnce(ok({ revenue: 150000, transaction_count: 3 }))
      .mockReturnValue(ok({ revenue: 100000, transaction_count: 2 }));
    mount();
    expect(await screen.findByText('+50%')).toBeTruthy();
    expect(screen.getAllByText('vs previous 30 days').length).toBeGreaterThan(0);
  });

  it('asks for the previous period of the same length, ending where this one starts', async () => {
    reportsApi.dashboardOverview.mockReturnValue(ok({ lowStockCount: 0, unpaidParcelsByCourier: [] }));
    mount();
    await screen.findByText('Revenue');
    const calls = reportsApi.salesSummary.mock.calls.map((c) => c[0]);
    const current = calls.find((p) => !p.to);
    const previous = calls.find((p) => p.to);
    expect(previous.to).toBe(current.from);
    const day = 86400000;
    expect(Math.round((new Date(current.from) - new Date(previous.from)) / day)).toBe(30);
  });
});

describe('Dashboard reports requests', () => {
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const everyFromTo = () => [
    ...reportsApi.salesSummary.mock.calls, ...reportsApi.salesByChannel.mock.calls,
    ...reportsApi.paymentMethods.mock.calls, ...reportsApi.topProductsByChannel.mock.calls,
  ].map((c) => c[0]).flatMap((p) => [p.from, p.to]).filter(Boolean);

  it('asks for date-only values (the API refuses a timestamp), for the period and the one before it', async () => {
    reportsApi.dashboardOverview.mockReturnValue(ok({ lowStockCount: 0, unpaidParcelsByCourier: [] }));
    mount();
    await screen.findByText('All clear');
    const sent = everyFromTo();
    expect(sent.length).toBeGreaterThanOrEqual(6);
    for (const d of sent) expect(d).toMatch(DATE_ONLY);
    // the previous period ends where this one starts
    const prev = reportsApi.salesSummary.mock.calls.map((c) => c[0]).find((p) => p.to);
    const current = reportsApi.salesSummary.mock.calls.map((c) => c[0]).find((p) => !p.to);
    expect(prev.to).toBe(current.from);
    expect(prev.from < current.from).toBe(true);
  });

  it('All time starts from 1970-01-01 and sends no previous period', async () => {
    reportsApi.dashboardOverview.mockReturnValue(ok({ lowStockCount: 0, unpaidParcelsByCourier: [] }));
    mount();
    await screen.findByText('All clear');
    reportsApi.salesSummary.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'All time' }));
    await screen.findByText('All clear');
    const calls = reportsApi.salesSummary.mock.calls.map((c) => c[0]);
    expect(calls).toContainEqual({ from: '1970-01-01' });
    expect(calls.some((p) => p.to)).toBe(false);
  });
});
