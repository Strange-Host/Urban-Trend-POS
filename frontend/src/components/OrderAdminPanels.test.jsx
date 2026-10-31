import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OwnerDecisionQueue, IntegrityPanel, ShopCashForm } from './OrderAdminPanels';
import usePendingDecisionCount from '../hooks/usePendingDecisionCount';
import { ordersApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  ordersApi: { pendingOwnerDecision: vi.fn(), ownerDecision: vi.fn(), integrity: vi.fn(), shopCash: vi.fn() },
}));
const toast = { success: vi.fn(), error: vi.fn() };
const dialog = { confirm: vi.fn(), prompt: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));

const ok = (data) => Promise.resolve({ data: { data } });
const page = (rows, total = rows.length) => Promise.resolve({ data: { data: rows, total, page: 1, totalPages: 1 } });
const apiError = (status, message) => ({ response: { status, data: { error: { message } } } });
const mount = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const damaged = (o) => ({ id: 9, product_code: 'UT-9', customer_name: 'Wanjiru', customer_phone: '0712000000', total: 250000, owner_notified_at: hoursAgo(24 * 8), ...o });

beforeEach(() => {
  Object.values(ordersApi).forEach((f) => f.mockReset());
  [toast.success, toast.error, dialog.confirm].forEach((f) => f.mockReset());
});

describe('OwnerDecisionQueue', () => {
  it('lists damaged returns with how long they have waited', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValue(page([damaged(), damaged({ id: 10, product_code: 'UT-10', customer_name: 'Otieno', total: 90000, owner_notified_at: hoursAgo(1) })]));
    mount(<OwnerDecisionQueue canDecide onSelect={() => {}} />);
    expect(await screen.findByText('Wanjiru')).toBeInTheDocument();
    expect(screen.getByText('8 days')).toBeInTheDocument();
    expect(screen.getByText('today')).toBeInTheDocument();
    expect(screen.getByText('KES 2,500.00', { exact: false })).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValue(page([]));
    mount(<OwnerDecisionQueue canDecide onSelect={() => {}} />);
    expect(await screen.findByText('Nothing is waiting on a decision.')).toBeInTheDocument();
  });

  it('shows the server message when the queue cannot load', async () => {
    ordersApi.pendingOwnerDecision.mockRejectedValue(apiError(500, 'Queue unavailable.'));
    mount(<OwnerDecisionQueue canDecide onSelect={() => {}} />);
    expect(await screen.findByText('Queue unavailable.')).toBeInTheDocument();
  });

  it('writes off after confirmation and refreshes the queue', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValueOnce(page([damaged()])).mockReturnValue(page([]));
    ordersApi.ownerDecision.mockReturnValue(ok({}));
    dialog.confirm.mockResolvedValue(true);
    mount(<OwnerDecisionQueue canDecide onSelect={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Write off' }));
    await waitFor(() => expect(ordersApi.ownerDecision).toHaveBeenCalledWith(9, { decision: 'write_off' }));
    expect(toast.success).toHaveBeenCalled();
    expect(await screen.findByText('Nothing is waiting on a decision.')).toBeInTheDocument();
  });

  it('sends dispose, and does nothing when the confirmation is declined', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValue(page([damaged()]));
    ordersApi.ownerDecision.mockReturnValue(ok({}));
    dialog.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mount(<OwnerDecisionQueue canDecide onSelect={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dispose' }));
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));
    expect(ordersApi.ownerDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dispose' }));
    await waitFor(() => expect(ordersApi.ownerDecision).toHaveBeenCalledWith(9, { decision: 'dispose' }));
  });

  it('shows the API message and reloads when someone already decided', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValue(page([damaged()]));
    ordersApi.ownerDecision.mockRejectedValue(apiError(409, 'This order has already been decided.'));
    dialog.confirm.mockResolvedValue(true);
    mount(<OwnerDecisionQueue canDecide onSelect={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Write off' }));
    expect(await screen.findByText('This order has already been decided.')).toBeInTheDocument();
    await waitFor(() => expect(ordersApi.pendingOwnerDecision).toHaveBeenCalledTimes(2));
  });

  it('is read-only for a manager', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValue(page([damaged()]));
    mount(<OwnerDecisionQueue canDecide={false} onSelect={() => {}} />);
    expect(await screen.findByText('Wanjiru')).toBeInTheDocument();
    expect(screen.getByText(/Only an admin can make the decision/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write off' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dispose' })).not.toBeInTheDocument();
  });

  it('opens the order when its row is clicked', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValue(page([damaged()]));
    const onSelect = vi.fn();
    mount(<OwnerDecisionQueue canDecide onSelect={onSelect} />);
    fireEvent.click(await screen.findByText('Wanjiru'));
    expect(onSelect).toHaveBeenCalledWith(9);
  });
});

describe('usePendingDecisionCount', () => {
  function Probe({ enabled }) { return <div>count:{usePendingDecisionCount(enabled)}</div>; }
  it('reads the queue total', async () => {
    ordersApi.pendingOwnerDecision.mockReturnValue(page([damaged()], 4));
    mount(<Probe enabled />);
    expect(await screen.findByText('count:4')).toBeInTheDocument();
  });
  it('does not call the API for people who cannot see the queue', () => {
    mount(<Probe enabled={false} />);
    expect(screen.getByText('count:0')).toBeInTheDocument();
    expect(ordersApi.pendingOwnerDecision).not.toHaveBeenCalled();
  });
});

describe('IntegrityPanel', () => {
  it('lists mismatched orders and opens one', async () => {
    ordersApi.integrity.mockReturnValue(ok([{ order_id: 3, product_code: 'UT-3', status: 'dispatched_paid', subtotal: 100000, lines_total: 90000, total: 100000, expected_total: 100000, problems: ['lines_do_not_match_subtotal'] }]));
    const onSelect = vi.fn();
    mount(<IntegrityPanel onSelect={onSelect} />);
    expect(await screen.findByText('Item lines do not add up to the subtotal')).toBeInTheDocument();
    expect(screen.getByText('KES 900.00', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByText('UT-3'));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('shows the all-clear when nothing is wrong', async () => {
    ordersApi.integrity.mockReturnValue(ok([]));
    mount(<IntegrityPanel onSelect={() => {}} />);
    expect(await screen.findByText(/Every order adds up/)).toBeInTheDocument();
  });

  it('shows the server message when the check fails', async () => {
    ordersApi.integrity.mockRejectedValue(apiError(403, 'Forbidden.'));
    mount(<IntegrityPanel onSelect={() => {}} />);
    expect(await screen.findByText('Forbidden.')).toBeInTheDocument();
  });
});

describe('ShopCashForm', () => {
  const order = { id: 5, total: 300000, amount_paid: 100000 };   // owes KES 2,000
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Record shop cash' }));

  it('records cash in cents with a trimmed reason', async () => {
    ordersApi.shopCash.mockReturnValue(ok({}));
    mount(<ShopCashForm order={order} />);
    open();
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '1500.50' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Customer came in  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record cash' }));
    await waitFor(() => expect(ordersApi.shopCash).toHaveBeenCalledWith(5, { amount: 150050, reason: 'Customer came in' }));
    expect(toast.success).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Record shop cash' })).toBeInTheDocument();   // form closed again
  });

  it('blocks a missing amount, an overpayment and a missing reason without calling the API', () => {
    mount(<ShopCashForm order={order} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Record cash' }));
    expect(screen.getByText('Enter the amount taken.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2000.01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record cash' }));
    expect(screen.getByText(/more than the .*2,000\.00 this order still owes/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record cash' }));
    expect(screen.getByText('Say why the cash was taken at the shop.')).toBeInTheDocument();
    expect(ordersApi.shopCash).not.toHaveBeenCalled();
  });

  it('shows the server message and stays open on a refusal', async () => {
    ordersApi.shopCash.mockRejectedValue(apiError(422, 'Cash at the shop is an exception: a reason is required.'));
    mount(<ShopCashForm order={order} />);
    open();
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record cash' }));
    expect(await screen.findByText('Cash at the shop is an exception: a reason is required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record cash' })).toBeInTheDocument();
  });
});
