import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Couriers from './Couriers';
import { couriersApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  couriersApi: {
    list: vi.fn(), update: vi.fn(), remove: vi.fn(), create: vi.fn(), payables: vi.fn(), costs: vi.fn(), balance: vi.fn(), payouts: vi.fn(),
    standing: vi.fn(), collections: vi.fn(), statements: vi.fn(), recordCost: vi.fn(),
  },
}));
let perms = new Set();
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 5 }, can: (p) => perms.has(p) }) }));
const confirm = vi.fn();
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({ confirm, prompt: vi.fn() }) }));

const ok = (data) => Promise.resolve({ data: { data } });
const couriers = [
  { id: 2, name: 'Juma', kind: 'rider', courier_type: 'boda', is_active: 1, unpaid_parcels: 1, unpaid_amount: 100000 },
  { id: 3, name: 'G4S Express', kind: 'organization', courier_type: 'g4s', is_active: 1, collects_payment: 1, unpaid_parcels: 0, unpaid_amount: 0, overdue_after_days: 14 },
];
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Couriers /></QueryClientProvider>);

beforeEach(() => {
  Object.values(couriersApi).forEach((f) => f.mockReset());
  couriersApi.list.mockReturnValue(ok(couriers));
  couriersApi.payables.mockReturnValue(ok([]));
  couriersApi.costs.mockReturnValue(ok([]));
  couriersApi.balance.mockReturnValue(ok({ courier: { id: 2, name: 'Juma' }, fees_owed: 0, costs_owed: 0, total_owed: 0, pending_costs: 0, pending_costs_amount: 0, items: [] }));
  couriersApi.standing.mockReturnValue(ok({ courierId: 3, outstanding: 0, overdue: 0, limit: null, paused: false, buckets: [] }));
  confirm.mockReset();
  perms = new Set();
});

describe('Couriers page', () => {
  it('gives a manager a payables button for riders and an open button for organizations', async () => {
    perms = new Set(['couriers.manage', 'couriers.pay', 'couriers.costs.approve', 'couriers.settle']);
    mount();
    expect(await screen.findByText('Juma')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payables' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Payables & costs' })).toBeInTheDocument();
  });

  it('opens a rider on the payables tab with rider tabs only', async () => {
    perms = new Set(['couriers.pay', 'couriers.costs.approve', 'couriers.settle']);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Payables' }));
    expect(await screen.findByRole('tab', { name: 'Costs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Payables' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Payouts' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Standing' })).not.toBeInTheDocument();
  });

  it('opens an organization on its standing tab with organization tabs only', async () => {
    perms = new Set(['couriers.settle']);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('tab', { name: 'Statements' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Collections' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Payouts' })).not.toBeInTheDocument();
  });

  it('shows no payables controls to someone with no courier money permissions', async () => {
    perms = new Set(['couriers.manage']);
    mount();
    expect(await screen.findByText('Juma')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Payables' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Payables & costs' })).not.toBeInTheDocument();
    expect(couriersApi.payables).not.toHaveBeenCalled();
  });

  it('lets a cashier who may only enter costs open a rider, but not an organization', async () => {
    perms = new Set(['couriers.costs.record']);
    mount();
    expect(await screen.findByText('Juma')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payables' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('switches to the payables overview', async () => {
    perms = new Set(['couriers.pay']);
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'Payables & costs' }));
    expect(await screen.findByText('No rider is owed anything right now.')).toBeInTheDocument();
  });

  it('deactivates through the courier remove call, but only after the confirmation', async () => {
    perms = new Set(['couriers.manage']);
    couriersApi.remove.mockResolvedValue({ data: { data: {} } });
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mount();
    await screen.findByText('Juma');
    const deactivate = screen.getAllByRole('button', { name: 'Deactivate' })[0];
    fireEvent.click(deactivate);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(couriersApi.remove).not.toHaveBeenCalled();
    fireEvent.click(deactivate);
    await waitFor(() => expect(couriersApi.remove).toHaveBeenCalledWith(2));
    expect(couriersApi.update).not.toHaveBeenCalled();
  });

  it('reactivates through update, with no confirmation', async () => {
    perms = new Set(['couriers.manage']);
    couriersApi.list.mockReturnValue(ok([{ ...couriers[0], is_active: 0 }]));
    couriersApi.update.mockResolvedValue({ data: { data: {} } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(couriersApi.update).toHaveBeenCalledWith(2, { is_active: true }));
    expect(couriersApi.remove).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
