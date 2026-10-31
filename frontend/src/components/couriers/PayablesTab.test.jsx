import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PayablesTab from './PayablesTab';
import { couriersApi } from '../../api/endpoints';

vi.mock('../../api/endpoints', () => ({ couriersApi: { balance: vi.fn(), createPayout: vi.fn(), payout: vi.fn() } }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../context/UIContext', () => ({ useToast: () => toast, useDialog: () => ({}) }));

const ok = (data) => Promise.resolve({ data: { data } });
const courier = { id: 2, name: 'Juma', kind: 'rider' };
const balance = {
  courier: { id: 2, name: 'Juma' }, fees_owed: 30000, costs_owed: 50000, total_owed: 80000, pending_costs: 1, pending_costs_amount: 20000,
  items: [
    { type: 'package_fee', id: 11, amount: 30000, order_id: 7, since: '2026-10-28 10:00:00', description: 'Package fee' },
    { type: 'courier_cost', id: 4, amount: 50000, order_id: null, since: '2026-10-29 09:00:00', description: 'Courier cost (fuel): Fuel to Thika' },
  ],
};
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PayablesTab courier={courier} /></QueryClientProvider>);

beforeEach(() => {
  [couriersApi.balance, couriersApi.createPayout, couriersApi.payout, toast.success, toast.error].forEach((f) => f.mockReset());
  couriersApi.balance.mockReturnValue(ok(balance));
});

describe('PayablesTab', () => {
  it('shows fees and costs separately, everything ticked, and the waiting costs', async () => {
    mount();
    expect(await screen.findByText('Selected:')).toBeInTheDocument();
    expect(screen.getAllByText('KES 300.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('KES 800.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/1 cost \(KES 200.00\) awaiting approval/)).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every((c) => c.checked)).toBe(true);
  });

  it('pays only the ticked items and then shows the receipt read back from the server', async () => {
    couriersApi.createPayout.mockReturnValue(ok({ id: 31 }));
    couriersApi.payout.mockReturnValue(ok({
      id: 31, courier_name: 'Juma', created_at: '2026-11-01 09:00:00', method: 'mpesa', payment_ref: 'QWE123', paid_by_name: 'Admin',
      fees_total: 30000, costs_total: 0, total: 30000,
      fee_lines: [{ id: 1, amount: 30000, order_id: 7, order_code: 'UT-7' }], cost_lines: [],
    }));
    mount();
    await screen.findByText('Selected:');
    fireEvent.click(screen.getByRole('checkbox', { name: /Fuel to Thika/ }));      // leave the cost unpaid
    fireEvent.click(screen.getByRole('button', { name: /Pay selected/ }));
    fireEvent.change(screen.getByLabelText('M-Pesa code'), { target: { value: ' QWE123 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm KES 300.00' }));
    await waitFor(() => expect(couriersApi.createPayout).toHaveBeenCalledWith(2, {
      method: 'mpesa', payment_ref: 'QWE123', items: [{ type: 'package_fee', id: 11 }],
    }));
    expect(await screen.findByText('Payout #31')).toBeInTheDocument();
    expect(couriersApi.payout).toHaveBeenCalledWith(31);
    expect(screen.getByText('Order UT-7')).toBeInTheDocument();
  });

  it('asks for a reference before paying by M-Pesa, but not for cash', async () => {
    couriersApi.createPayout.mockReturnValue(ok({ id: 32 }));
    couriersApi.payout.mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByText('Selected:');
    fireEvent.click(screen.getByRole('button', { name: /Pay selected/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm KES 800.00' }));
    expect(await screen.findByText(/Enter the payment reference/)).toBeInTheDocument();
    expect(couriersApi.createPayout).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Paid by'), { target: { value: 'cash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm KES 800.00' }));
    await waitFor(() => expect(couriersApi.createPayout).toHaveBeenCalledWith(2, expect.objectContaining({ method: 'cash', payment_ref: null })));
  });

  it('keeps the sheet open and shows the server message when the payout is refused', async () => {
    couriersApi.createPayout.mockRejectedValue({ response: { data: { error: { message: 'cost #4 is not an unpaid item for this courier.' } } } });
    mount();
    await screen.findByText('Selected:');
    fireEvent.click(screen.getByRole('button', { name: /Pay selected/ }));
    fireEvent.change(screen.getByLabelText('Paid by'), { target: { value: 'cash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm KES 800.00' }));
    expect(await screen.findByText(/is not an unpaid item/)).toBeInTheDocument();
  });

  it('cannot start a payout with nothing ticked', async () => {
    mount();
    await screen.findByText('Selected:');
    screen.getAllByRole('checkbox').forEach((c) => fireEvent.click(c));
    expect(screen.getByRole('button', { name: /Pay selected/ })).toBeDisabled();
  });

  it('shows an empty state when nothing is owed', async () => {
    couriersApi.balance.mockReturnValue(ok({ ...balance, fees_owed: 0, costs_owed: 0, total_owed: 0, pending_costs: 0, items: [] }));
    mount();
    expect(await screen.findByText('Nothing is owed to Juma.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay selected/ })).not.toBeInTheDocument();
  });
});
