import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const delivery = vi.fn();
const addDeliveryCost = vi.fn();
const closeDelivery = vi.fn();
const approveCost = vi.fn();
const confirm = vi.fn();
let perms = new Set();
let me = { id: 5, role: 'manager' };

vi.mock('../api/endpoints', () => ({
  ordersApi: {
    delivery: (...a) => delivery(...a), addDeliveryCost: (...a) => addDeliveryCost(...a), closeDelivery: (...a) => closeDelivery(...a),
    addFeeReceipt: vi.fn(), reopenDelivery: vi.fn(),
  },
  deliveryApi: { approveCost: (...a) => approveCost(...a), rejectCost: vi.fn(), reverseCost: vi.fn() },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: me, can: (p) => perms.has(p) }) }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({ confirm, prompt: vi.fn() }) }));

import DeliverySettlementPanel from './DeliverySettlementPanel';

const base = {
  order: { id: 7 }, settlement: { status: 'open', outcome: null },
  fee_charged: 30000, fee_collected: 10000, fee_uncollected: 20000, package_fee: 10000, package_fee_courier: 'Juma',
  costs_total: 18000, result: -8000, pending_count: 1,
  fee_receipts: [], rider_cost_lines: [],
  extra_cost_lines: [
    { id: 1, kind: 'outpost_leg', amount: 8000, reason: 'Outpost to Kitale', status: 'approved', recorded_by: 9, recorded_by_name: 'Amina', reverses_cost_id: null },
    { id: 2, kind: 'handling', amount: 2000, reason: 'Repacking', status: 'pending', recorded_by: 9, recorded_by_name: 'Amina', reverses_cost_id: null },
  ],
};
const order = { id: 7, status: 'dispatched_unpaid' };
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DeliverySettlementPanel order={order} /></QueryClientProvider>);

beforeEach(() => {
  [delivery, addDeliveryCost, closeDelivery, approveCost, confirm].forEach((f) => f.mockReset());
  delivery.mockResolvedValue({ data: { data: base } });
  perms = new Set(['delivery.costs.record', 'delivery.costs.approve', 'delivery.settlement.close']);
  me = { id: 5, role: 'manager' };
});

describe('DeliverySettlementPanel', () => {
  it('shows the fee, what was paid, the costs, and the result', async () => {
    mount();
    expect(await screen.findByText('Delivery fee charged')).toBeInTheDocument();
    expect(screen.getByText(/Fee not paid \(shop carries it\)/)).toBeInTheDocument();
    expect(screen.getByText('Cost to the shop')).toBeInTheDocument();
    expect(screen.getByText(/Outpost to destination · Outpost to Kitale/)).toBeInTheDocument();
    expect(screen.getByText(/1 cost\(s\) waiting for approval/)).toBeInTheDocument();
  });

  it('will not enter a cost without a reason', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a cost' }));
    fireEvent.change(screen.getByLabelText('Cost amount'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter cost' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Say why this cost was incurred/);
    expect(addDeliveryCost).not.toHaveBeenCalled();
  });

  it('enters a cost with its reason', async () => {
    addDeliveryCost.mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a cost' }));
    fireEvent.change(screen.getByLabelText('Cost amount'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Reason for the cost'), { target: { value: 'Boda from Kisumu stage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter cost' }));
    await waitFor(() => expect(addDeliveryCost).toHaveBeenCalledWith(7, { kind: 'outpost_leg', amount: 12000, reason: 'Boda from Kisumu stage', paid_via: 'mobile_money' }));
  });

  it('lets someone other than the enterer approve a pending cost, but not the enterer', async () => {
    approveCost.mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveCost).toHaveBeenCalledWith(2));
  });

  it('hides Approve from the person who entered the cost', async () => {
    me = { id: 9, role: 'manager' };
    mount();
    await screen.findByText('Delivery fee charged');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('closing asks for confirmation first', async () => {
    confirm.mockResolvedValue(false);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm delivered and close' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(closeDelivery).not.toHaveBeenCalled();
  });

  it('offers no entry forms on a closed settlement', async () => {
    delivery.mockResolvedValue({ data: { data: { ...base, settlement: { status: 'closed', outcome: 'delivered' }, pending_count: 0 } } });
    mount();
    expect(await screen.findByText(/Closed · delivered/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add a cost' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm delivered and close' })).not.toBeInTheDocument();
  });
});
