import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StandingTab, CollectionsTab, StatementsTab } from './OrgTabs';
import { couriersApi } from '../../api/endpoints';

vi.mock('../../api/endpoints', () => ({
  couriersApi: { standing: vi.fn(), collections: vi.fn(), recordCollection: vi.fn(), statements: vi.fn(), createStatement: vi.fn() },
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../context/UIContext', () => ({ useToast: () => toast, useDialog: () => ({}) }));

const ok = (data) => Promise.resolve({ data: { data } });
const org = { id: 3, name: 'G4S Express', kind: 'organization', collects_payment: 1, overdue_after_days: 14 };
const wrap = (el) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>);

beforeEach(() => {
  Object.values(couriersApi).forEach((f) => f.mockReset());
  [toast.success, toast.error].forEach((f) => f.mockReset());
});

describe('StandingTab', () => {
  const standing = { courierId: 3, outstanding: 500000, overdue: 200000, limit: 100000, paused: true, buckets: [
    { label: '0-7', cents: 300000 }, { label: '8-14', cents: 0 }, { label: '15-30', cents: 200000 }, { label: '30+', cents: 0 } ] };

  it('shows what is held, the ageing and a warning when collections are paused', async () => {
    couriersApi.standing.mockReturnValue(ok(standing));
    wrap(<StandingTab courier={org} />);
    expect(await screen.findByText('KES 5,000.00')).toBeInTheDocument();
    expect(screen.getByText(/are paused/)).toBeInTheDocument();
    expect(screen.getByText('15-30 days')).toBeInTheDocument();
  });

  it('shows no warning when not paused, and "None" without a limit', async () => {
    couriersApi.standing.mockReturnValue(ok({ ...standing, paused: false, limit: null }));
    wrap(<StandingTab courier={org} />);
    expect(await screen.findByText('None')).toBeInTheDocument();
    expect(screen.queryByText(/are paused/)).not.toBeInTheDocument();
  });

  it('shows the server message when it cannot load', async () => {
    couriersApi.standing.mockRejectedValue({ response: { data: { error: { message: 'Organization not found.' } } } });
    wrap(<StandingTab courier={org} />);
    expect(await screen.findByText('Organization not found.')).toBeInTheDocument();
  });
});

describe('CollectionsTab', () => {
  it('shows an empty state', async () => {
    couriersApi.collections.mockReturnValue(ok([]));
    wrap(<CollectionsTab courier={org} />);
    expect(await screen.findByText('No open collections.')).toBeInTheDocument();
  });

  it('records a collection in cents', async () => {
    couriersApi.collections.mockReturnValue(ok([]));
    couriersApi.recordCollection.mockReturnValue(ok({ id: 1 }));
    wrap(<CollectionsTab courier={org} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Record collection' }));
    fireEvent.change(screen.getByLabelText('Order number'), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText('Amount collected (KES)'), { target: { value: '2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(couriersApi.recordCollection).toHaveBeenCalledWith(3, { order_id: 42, amount: 250000 }));
  });

  it('explains when the organization does not collect payment', () => {
    couriersApi.collections.mockReturnValue(ok([]));
    wrap(<CollectionsTab courier={{ ...org, collects_payment: 0 }} />);
    expect(screen.getByText(/does not collect payment/)).toBeInTheDocument();
  });
});

describe('StatementsTab', () => {
  const open = [{ id: 1, order_id: 10, product_code: 'UT-10', amount: 100000, collected_on: '2026-10-20' }, { id: 2, order_id: 11, product_code: 'UT-11', amount: 50000, collected_on: '2026-10-21' }];

  it('lists past statements with variances called out', async () => {
    couriersApi.statements.mockReturnValue(ok([
      { id: 1, period_start: '2026-10-01', period_end: '2026-10-15', collections: 100000, fees: 10000, remitted: 85000, charge_variance: 0, cash_variance: 5000, remittance_ref: 'RT1' },
      { id: 2, period_start: '2026-10-16', period_end: '2026-10-31', collections: 50000, fees: 5000, remitted: 45000, charge_variance: 0, cash_variance: 0 },
    ]));
    wrap(<StatementsTab courier={org} />);
    expect(await screen.findByText('Cash short by KES 50.00')).toBeInTheDocument();
    expect(screen.getByText('matches')).toBeInTheDocument();
  });

  it('creates a statement from the ticked parcels', async () => {
    couriersApi.statements.mockReturnValue(ok([]));
    couriersApi.collections.mockReturnValue(ok(open));
    couriersApi.createStatement.mockReturnValue(ok({ id: 5 }));
    wrap(<StatementsTab courier={org} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New statement' }));
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-10-31' } });
    fireEvent.click(await screen.findByLabelText(/UT-10/));
    fireEvent.change(screen.getByLabelText(/Their charge/), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/Amount remitted/), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record statement' }));
    await waitFor(() => expect(couriersApi.createStatement).toHaveBeenCalledWith(3, {
      period_start: '2026-10-01', period_end: '2026-10-31', collection_ids: [1], charge_entered: 10000, remitted: 90000, remittance_ref: null,
    }));
  });

  it('will not submit a statement with no parcels ticked', async () => {
    couriersApi.statements.mockReturnValue(ok([]));
    couriersApi.collections.mockReturnValue(ok(open));
    wrap(<StatementsTab courier={org} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New statement' }));
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record statement' }));
    expect(await screen.findByText(/Tick the parcels/)).toBeInTheDocument();
    expect(couriersApi.createStatement).not.toHaveBeenCalled();
  });

  it('shows the server message when the statement is refused', async () => {
    couriersApi.statements.mockReturnValue(ok([]));
    couriersApi.collections.mockReturnValue(ok(open));
    couriersApi.createStatement.mockRejectedValue({ response: { data: { error: { message: 'Parcel 10 is already on another statement.' } } } });
    wrap(<StatementsTab courier={org} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New statement' }));
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-10-31' } });
    fireEvent.click(await screen.findByLabelText(/UT-10/));
    fireEvent.click(screen.getByRole('button', { name: 'Record statement' }));
    expect(await screen.findByText(/already on another statement/)).toBeInTheDocument();
  });
});
