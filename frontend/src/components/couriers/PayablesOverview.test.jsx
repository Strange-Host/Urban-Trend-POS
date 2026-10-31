import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PayablesOverview from './PayablesOverview';
import { couriersApi } from '../../api/endpoints';

vi.mock('../../api/endpoints', () => ({ couriersApi: { payables: vi.fn(), costs: vi.fn(), approveCost: vi.fn(), rejectCost: vi.fn() } }));
let perms = new Set();
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 5 }, can: (p) => perms.has(p) }) }));
vi.mock('../../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }) }));

const ok = (data) => Promise.resolve({ data: { data } });
const rows = [
  { courier: { id: 2, name: 'Juma' }, fees_owed: 30000, costs_owed: 50000, total_owed: 80000, pending_costs: 1, pending_costs_amount: 20000, unpaid_items: 2 },
  { courier: { id: 3, name: 'Otieno' }, fees_owed: 10000, costs_owed: 0, total_owed: 10000, pending_costs: 0, pending_costs_amount: 0, unpaid_items: 1 },
];
const mount = (onOpen = vi.fn()) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PayablesOverview onOpenCourier={onOpen} /></QueryClientProvider>);

beforeEach(() => {
  Object.values(couriersApi).forEach((f) => f.mockReset());
  couriersApi.payables.mockReturnValue(ok(rows));
  couriersApi.costs.mockReturnValue(ok([]));
  perms = new Set(['couriers.pay', 'couriers.costs.approve']);
});

describe('PayablesOverview', () => {
  it('totals what is owed and lists each rider', async () => {
    mount();
    expect(await screen.findByText('Juma')).toBeInTheDocument();
    expect(screen.getByText('Total owed to riders')).toBeInTheDocument();
    expect(screen.getByText('KES 900.00')).toBeInTheDocument();       // 800 + 100 across riders
    expect(screen.getByText('Otieno')).toBeInTheDocument();
  });

  it('opens the rider on the payables tab', async () => {
    const onOpen = vi.fn();
    mount(onOpen);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]);
    expect(onOpen).toHaveBeenCalledWith(2, 'payables');
  });

  it('shows an empty state when nobody is owed', async () => {
    couriersApi.payables.mockReturnValue(ok([]));
    mount();
    expect(await screen.findByText('No rider is owed anything right now.')).toBeInTheDocument();
  });

  it('asks only for pending costs in the approval queue', async () => {
    mount();
    await screen.findByText('Juma');
    expect(couriersApi.costs).toHaveBeenCalledWith({ status: 'pending' });
    expect(await screen.findByText('Nothing waiting for approval.')).toBeInTheDocument();
  });

  it('hides the money tables from someone who can only approve costs', async () => {
    perms = new Set(['couriers.costs.approve']);
    mount();
    expect(await screen.findByText('Nothing waiting for approval.')).toBeInTheDocument();
    expect(couriersApi.payables).not.toHaveBeenCalled();
    expect(screen.queryByText('Total owed to riders')).not.toBeInTheDocument();
  });

  it('hides the approval queue from someone who can only pay', async () => {
    perms = new Set(['couriers.pay']);
    mount();
    expect(await screen.findByText('Juma')).toBeInTheDocument();
    expect(couriersApi.costs).not.toHaveBeenCalled();
    expect(screen.queryByText(/must be decided by someone other than/)).not.toBeInTheDocument();   // the approval panel's blurb
  });
});
