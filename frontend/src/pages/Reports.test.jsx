import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Reports from './Reports';
import { reportsApi } from '../api/endpoints';
import { downloadFile } from '../api/client';

vi.mock('../api/endpoints', () => ({
  reportsApi: { pnl: vi.fn(), discounts: vi.fn(), vat: vi.fn(), branchComparison: vi.fn(), agentPerformance: vi.fn(), setForecast: vi.fn() },
}));
vi.mock('../api/client', () => ({ downloadFile: vi.fn(), getErrorMessage: (e, f) => e?.response?.data?.error?.message || f || 'error' }));
let canForecast = true;
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ can: () => canForecast }) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast }));

// jsdom has no element scrollTo; the tab strip calls it to keep the active tab in view.
Element.prototype.scrollTo = vi.fn();

const ok = (data) => Promise.resolve({ data: { data } });
const pnl = {
  summary: { revenue: 536100, costOfGoodsSold: 240000, deliveryFees: 0, laborCost: 0, businessExpenses: 50000, grossMargin: 296100, netProfit: 246100 },
  byCategory: { rows: [{ category: 'Apparel', units: 6, revenue: 537000, cost: 240000, margin: 297000, margin_percent: 55.3 }], total: { units: 6, revenue: 536100, cost: 240000, margin: 296100 } },
  byBranch: { rows: [{ store_id: 1, branch: 'Main Branch', revenue: 536100, costOfGoodsSold: 240000, deliveryFees: 0, laborCost: 0, businessExpenses: 50000, netProfit: 246100, margin_percent: 45.9 }], total: {} },
  forecast: { rows: [{ month: '2026-10', has_forecast: true, revenue_target: 50000000, expense_budget: 9000000, revenue_actual: 536100, operating_expenses_actual: 50000, net_profit_actual: 246100, revenue_variance: -49463900, revenue_attainment_percent: 1.1, expense_variance: -8950000, on_pace_percent: 3.6 }],
    total: { revenue_target: 50000000, revenue_actual: 536100, expense_budget: 9000000, operating_expenses_actual: 50000, net_profit_actual: 246100, revenue_variance: -49463900, revenue_attainment_percent: 1.1, expense_variance: -8950000 } },
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Reports /></QueryClientProvider>);
}

beforeEach(() => {
  canForecast = true;
  Object.values(reportsApi).forEach((f) => f.mockReset());
  downloadFile.mockReset().mockResolvedValue();
  toast.success.mockReset(); toast.error.mockReset();
  reportsApi.pnl.mockReturnValue(ok(pnl));
});

describe('Reports page', () => {
  it('shows the P&L in KES with the category, branch and forecast sections', async () => {
    mount();
    expect(await screen.findByText('Forecast vs actual')).toBeInTheDocument();
    expect(screen.getAllByText('5,361.00').length).toBeGreaterThan(0);   // 536100 cents
    expect(screen.getByText('Apparel')).toBeInTheDocument();
    expect(screen.getByText('Main Branch')).toBeInTheDocument();
  });

  it('exports the current tab and date range as Excel or PDF', async () => {
    mount();
    await screen.findByText('Forecast vs actual');
    fireEvent.click(screen.getByText('Download PDF'));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(1));
    const [url, params] = downloadFile.mock.calls[0];
    expect(url).toBe('/reports/export/pnl');
    expect(params).toMatchObject({ format: 'pdf' });
    expect(params.from <= params.to).toBe(true);
    fireEvent.click(screen.getByText('Download Excel'));
    await waitFor(() => expect(downloadFile.mock.calls[1][1]).toMatchObject({ format: 'xlsx' }));
  });

  it('saves a forecast in cents and refuses a non-number', async () => {
    reportsApi.setForecast.mockReturnValue(ok({}));
    mount();
    await screen.findByText('Forecast vs actual');
    fireEvent.change(screen.getByLabelText(/Revenue target/), { target: { value: '500,000' } });
    fireEvent.change(screen.getByLabelText(/Expense budget/), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('Save forecast'));
    expect(toast.error).toHaveBeenCalled();
    expect(reportsApi.setForecast).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Expense budget/), { target: { value: '90000' } });
    fireEvent.click(screen.getByText('Save forecast'));
    await waitFor(() => expect(reportsApi.setForecast).toHaveBeenCalledWith('2026-10', { revenue_target: 50000000, expense_budget: 9000000 }));
  });

  it('hides the forecast editor from someone without the permission', async () => {
    canForecast = false;
    mount();
    await screen.findByText('Forecast vs actual');
    expect(screen.queryByText('Save forecast')).not.toBeInTheDocument();
  });

  it('switches to the VAT tab and labels it as an estimate', async () => {
    reportsApi.vat.mockReturnValue(ok({ vat_rate_percent: 16, estimated: true, note: 'Estimate: prices are treated as VAT-inclusive.', total: { gross: 11600, vat: 1600, net: 10000 }, months: [], daily: [] }));
    mount();
    await screen.findByText('Forecast vs actual');
    fireEvent.click(screen.getByText('VAT'));
    expect(await screen.findByText('Estimate.')).toBeInTheDocument();
    expect(screen.getByText('KES 16.00')).toBeInTheDocument();
  });
});
