import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CostsPanel from './CostsPanel';
import { couriersApi } from '../../api/endpoints';

vi.mock('../../api/endpoints', () => ({ couriersApi: { costs: vi.fn(), approveCost: vi.fn(), rejectCost: vi.fn() } }));
let perms = new Set();
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 5, role: 'manager' }, can: (p) => perms.has(p) }) }));
const toast = { success: vi.fn(), error: vi.fn() };
const dialog = { confirm: vi.fn(), prompt: vi.fn() };
vi.mock('../../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));

const ok = (data) => Promise.resolve({ data: { data } });
const cost = (o) => ({
  id: 1, courier_id: 2, courier_name: 'Juma', kind: 'fuel', amount: 50000, description: 'Fuel to Thika', status: 'pending',
  recorded_by: 9, recorded_by_name: 'Grace', created_at: '2026-10-30 08:00:00', order_id: null, receipt_ref: null, ...o,
});
const mount = (props = {}) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CostsPanel {...props} /></QueryClientProvider>);

beforeEach(() => {
  [couriersApi.costs, couriersApi.approveCost, couriersApi.rejectCost, dialog.confirm, dialog.prompt, toast.success, toast.error].forEach((f) => f.mockReset());
  perms = new Set(['couriers.costs.approve']);
});

describe('CostsPanel', () => {
  it('asks the API for pending costs only and shows the amount in KES', async () => {
    couriersApi.costs.mockReturnValue(ok([cost()]));
    mount({ status: 'pending' });
    expect(await screen.findByText(/Fuel to Thika/)).toBeInTheDocument();
    expect(screen.getByText('KES 500.00')).toBeInTheDocument();
    expect(couriersApi.costs).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('approves a cost after confirmation', async () => {
    couriersApi.costs.mockReturnValue(ok([cost()]));
    couriersApi.approveCost.mockReturnValue(ok({}));
    dialog.confirm.mockResolvedValue(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(couriersApi.approveCost).toHaveBeenCalledWith(1));
    expect(toast.success).toHaveBeenCalled();
  });

  it('does not approve when the confirmation is dismissed', async () => {
    couriersApi.costs.mockReturnValue(ok([cost()]));
    dialog.confirm.mockResolvedValue(false);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalled());
    expect(couriersApi.approveCost).not.toHaveBeenCalled();
  });

  it('rejects with the reason that was typed', async () => {
    couriersApi.costs.mockReturnValue(ok([cost()]));
    couriersApi.rejectCost.mockReturnValue(ok({}));
    dialog.prompt.mockResolvedValue('  No receipt  ');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(couriersApi.rejectCost).toHaveBeenCalledWith(1, { reason: 'No receipt' }));
  });

  it('does not reject without a reason', async () => {
    couriersApi.costs.mockReturnValue(ok([cost()]));
    dialog.prompt.mockResolvedValue(null);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(dialog.prompt).toHaveBeenCalled());
    expect(couriersApi.rejectCost).not.toHaveBeenCalled();
  });

  it('shows the API message when approving fails', async () => {
    couriersApi.costs.mockReturnValue(ok([cost()]));
    couriersApi.approveCost.mockRejectedValue({ response: { data: { error: { message: 'This cost has already been approved.' } } } });
    dialog.confirm.mockResolvedValue(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This cost has already been approved.'));
  });

  it('offers no buttons on a cost the viewer entered themselves', async () => {
    couriersApi.costs.mockReturnValue(ok([cost({ recorded_by: 5 })]));
    mount();
    expect(await screen.findByText('Awaiting someone else')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers no buttons on a cost that is already decided', async () => {
    couriersApi.costs.mockReturnValue(ok([cost({ status: 'rejected', decision_reason: 'Duplicate' })]));
    mount();
    expect(await screen.findByText(/Rejected: Duplicate/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    couriersApi.costs.mockReturnValue(ok([]));
    mount({ empty: 'Nothing waiting for approval.' });
    expect(await screen.findByText('Nothing waiting for approval.')).toBeInTheDocument();
  });

  it('renders nothing and does not call the API without the approve permission', () => {
    perms = new Set(['couriers.costs.record']);
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
    expect(couriersApi.costs).not.toHaveBeenCalled();
  });
});
