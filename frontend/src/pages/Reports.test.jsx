import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Reports from './Reports';
import { reportsApi } from '../api/endpoints';
import { downloadFile } from '../api/client';

vi.mock('../api/endpoints', () => ({
  reportsApi: { pnl: vi.fn(), discounts: vi.fn(), vat: vi.fn(), branchComparison: vi.fn(), agentPerformance: vi.fn(), setForecast: vi.fn(), unpaidParcels: vi.fn(), topProductsByProfit: vi.fn(), topStaffByProfit: vi.fn() },
}));
const modulesState = { branches: true };
vi.mock('../hooks/useModules', () => ({ default: () => ({ hr: false, control: false, loaded: true, ...modulesState }) }));
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
  modulesState.branches = true;
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

  it('leaves out the Branches tab and the branch comparison when multi-branch mode is off', async () => {
    modulesState.branches = false;
    mount();
    await screen.findByText('Apparel');
    expect(screen.queryByText('Branch comparison')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Branches' })).toBeNull();
    expect(screen.queryByText('Branches')).toBeNull();
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

  describe('unpaid parcels', () => {
    const parcel = (o = {}) => ({ id: 1, product_code: 'UT000004', customer_name: 'Wanjiru', customer_phone: '0712345678', courier_type: 'boda', total: 150000, amount_paid: 50000, outstanding: 100000, dispatched_at: '2026-10-20 08:00:00', ...o });

    it('lists what each courier still owes, with the total, and no date range or export', async () => {
      reportsApi.unpaidParcels.mockReturnValue(ok([parcel(), parcel({ id: 2, product_code: 'UT000005', courier_type: 'g4s', total: 80000, amount_paid: 0, outstanding: 80000 })]));
      mount();
      await screen.findByText('Forecast vs actual');
      fireEvent.click(screen.getByText('Unpaid parcels'));
      expect(await screen.findByText('UT000004')).toBeInTheDocument();
      expect(screen.getByText('UT000005')).toBeInTheDocument();
      expect(screen.getByText('Owed to us (KES)').nextSibling).toHaveTextContent('1,800.00');
      expect(screen.queryByText('Download Excel')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    });

    it('asks the server for one courier when filtered', async () => {
      reportsApi.unpaidParcels.mockReturnValue(ok([parcel()]));
      mount();
      await screen.findByText('Forecast vs actual');
      fireEvent.click(screen.getByText('Unpaid parcels'));
      await screen.findByText('UT000004');
      fireEvent.change(screen.getByLabelText('Courier'), { target: { value: 'g4s' } });
      await waitFor(() => expect(reportsApi.unpaidParcels).toHaveBeenLastCalledWith({ courier: 'g4s' }));
    });

    it('shows an empty state', async () => {
      reportsApi.unpaidParcels.mockReturnValue(ok([]));
      mount();
      await screen.findByText('Forecast vs actual');
      fireEvent.click(screen.getByText('Unpaid parcels'));
      expect(await screen.findByText('No unpaid parcels.')).toBeInTheDocument();
    });
  });

  describe('profit leaders', () => {
    it('ranks products and staff by margin, with a margin percentage', async () => {
      reportsApi.topProductsByProfit.mockReturnValue(ok([{ id: 1, name: 'Serum', sku: 'SRM-1', units_sold: 4, revenue: 400000, cost: 100000, profit: 300000 }]));
      reportsApi.topStaffByProfit.mockReturnValue(ok([{ staff_id: 9, name: 'Grace', orders_count: 3, revenue: 200000, cost: 150000, margin: 50000 }]));
      mount();
      await screen.findByText('Forecast vs actual');
      fireEvent.click(screen.getByText('Profit leaders'));
      expect(await screen.findByText('Serum')).toBeInTheDocument();
      expect(screen.getByText('75%')).toBeInTheDocument();     // 3,000 profit on 4,000 revenue
      expect(screen.getByText('Grace')).toBeInTheDocument();
      expect(screen.getByText('25%')).toBeInTheDocument();     // 500 margin on 2,000 revenue
      expect(reportsApi.topProductsByProfit).toHaveBeenCalledWith(expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));
      expect(screen.queryByText('Download Excel')).not.toBeInTheDocument();
    });

    it('shows empty states when nothing sold in the period', async () => {
      reportsApi.topProductsByProfit.mockReturnValue(ok([]));
      reportsApi.topStaffByProfit.mockReturnValue(ok([]));
      mount();
      await screen.findByText('Forecast vs actual');
      fireEvent.click(screen.getByText('Profit leaders'));
      expect(await screen.findAllByText('No data for this period.')).toHaveLength(2);
    });

    it('shows the server message when a report fails', async () => {
      reportsApi.topProductsByProfit.mockRejectedValue({ response: { data: { error: { message: 'Not allowed.' } } } });
      reportsApi.topStaffByProfit.mockReturnValue(ok([]));
      mount();
      await screen.findByText('Forecast vs actual');
      fireEvent.click(screen.getByText('Profit leaders'));
      expect(await screen.findByText('Not allowed.')).toBeInTheDocument();
    });
  });
});
