import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Approvals from './Approvals';
import { approvalsApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({ approvalsApi: { list: vi.fn(), approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() } }));

let mockUser;
let mockCan;
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: mockUser, can: mockCan }) }));

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const dialog = { confirm: vi.fn(), prompt: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));

const voidReq = {
  id: 11, kind: 'void_sale', status: 'pending', target_ref: 'S-42', sale_id: 42, amount: 150000, reason: 'Wrong item scanned',
  requested_by: 7, requested_by_name: 'Grace Wanjiru', requested_at: '2026-10-31 08:00:00', sale_payment_method: 'mobile_money',
};
const refundReq = {
  id: 12, kind: 'refund_payment', status: 'pending', target_ref: 'Payment #9', payment_record_id: 9, amount: 70000, reason: 'Paid twice',
  requested_by: 7, requested_by_name: 'Grace Wanjiru', requested_at: '2026-10-31 08:05:00', payment_method: 'cash', payment_sale_id: 40,
};

const page = (rows, pending = rows.length) => Promise.resolve({ data: { data: rows, page: 1, limit: 25, total: rows.length, totalPages: 1, pending } });
const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Approvals /></QueryClientProvider>,
);

function asManager() {
  mockUser = { id: 3, role: 'manager', name: 'Mary Manager' };
  mockCan = (k) => ['approvals.review', 'sales.void', 'payments.refund'].includes(k);
}
function asCashier(id = 7) {
  mockUser = { id, role: 'cashier', name: 'Grace Wanjiru' };
  mockCan = (k) => k === 'sales.void_request';
}

beforeEach(() => {
  Object.values(approvalsApi).forEach((f) => f.mockReset());
  Object.values(toast).forEach((f) => f.mockReset());
  Object.values(dialog).forEach((f) => f.mockReset());
  asManager();
});

describe('Approvals — manager', () => {
  it('lists what is waiting, who asked, why, and the amount', async () => {
    approvalsApi.list.mockReturnValue(page([voidReq, refundReq]));
    mount();
    expect(await screen.findByText('Void sale S-42')).toBeInTheDocument();
    expect(screen.getByText('Refund Payment #9')).toBeInTheDocument();
    expect(screen.getAllByText('Grace Wanjiru')).toHaveLength(2);
    expect(screen.getByText('Wrong item scanned')).toBeInTheDocument();
    expect(screen.getByText('1,500.00')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Waiting (2)' })).toBeInTheDocument();
    expect(approvalsApi.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
  });

  it('approves only after the manager confirms, and says what will happen first', async () => {
    approvalsApi.list.mockReturnValue(page([voidReq]));
    approvalsApi.approve.mockResolvedValue({});
    dialog.confirm.mockResolvedValue(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approvalsApi.approve).toHaveBeenCalledWith(11));
    const opts = dialog.confirm.mock.calls[0][0];
    expect(opts.message).toMatch(/Wrong item scanned/);
    expect(opts.message).toMatch(/put back in stock/);
    expect(toast.success).toHaveBeenCalled();
  });

  it('does nothing if the manager backs out of the confirmation', async () => {
    approvalsApi.list.mockReturnValue(page([voidReq]));
    dialog.confirm.mockResolvedValue(false);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalled());
    expect(approvalsApi.approve).not.toHaveBeenCalled();
  });

  it('shows the server\'s reason when an approval cannot run, and refreshes the list', async () => {
    approvalsApi.list.mockReturnValue(page([voidReq]));
    dialog.confirm.mockResolvedValue(true);
    approvalsApi.approve.mockRejectedValue({ response: { status: 409, data: { error: { message: 'Sale is already voided.' } } } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sale is already voided.'));
    await waitFor(() => expect(approvalsApi.list.mock.calls.length).toBeGreaterThan(1)); // refetched
  });

  it('rejects with a trimmed reason, and not at all without one', async () => {
    approvalsApi.list.mockReturnValue(page([refundReq]));
    approvalsApi.reject.mockResolvedValue({});
    mount();

    dialog.prompt.mockResolvedValueOnce(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(dialog.prompt).toHaveBeenCalledTimes(1));
    expect(approvalsApi.reject).not.toHaveBeenCalled();

    dialog.prompt.mockResolvedValueOnce('  Customer was not charged twice  ');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(approvalsApi.reject).toHaveBeenCalledWith(12, 'Customer was not charged twice'));
    expect(dialog.prompt.mock.calls[1][0]).toMatchObject({ required: true });
  });

  it('cannot approve or reject their own request — it offers withdraw instead', async () => {
    approvalsApi.list.mockReturnValue(page([{ ...voidReq, requested_by: 3, requested_by_name: 'Mary Manager' }]));
    mount();
    await screen.findByText('Void sale S-42');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByText('Needs another manager')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('shows the outcome, who decided and their note in the history tab', async () => {
    approvalsApi.list.mockImplementation((p) => (p.status === 'closed'
      ? page([{ ...voidReq, status: 'rejected', reviewed_by_name: 'Mary Manager', reviewed_at: '2026-10-31 09:00:00', review_note: 'Item was not returned' }], 0)
      : page([], 0)));
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText(/Mary Manager/)).toBeInTheDocument();
    expect(screen.getByText('Item was not returned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('says so when nothing is waiting', async () => {
    approvalsApi.list.mockReturnValue(page([], 0));
    mount();
    expect(await screen.findByText('Nothing is waiting for approval.')).toBeInTheDocument();
  });
});

describe('Approvals — cashier', () => {
  it('sees their own requests with no approve / reject, and no "asked by" column', async () => {
    asCashier();
    approvalsApi.list.mockReturnValue(page([voidReq]));
    mount();
    const row = (await screen.findByText('Void sale S-42')).closest('tr');
    expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Asked by' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('withdraws a request after confirming', async () => {
    asCashier();
    approvalsApi.list.mockReturnValue(page([voidReq]));
    approvalsApi.cancel.mockResolvedValue({});
    dialog.confirm.mockResolvedValue(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(approvalsApi.cancel).toHaveBeenCalledWith(11));
  });

  it('shows the manager\'s rejection note so they know what to do next', async () => {
    asCashier();
    approvalsApi.list.mockImplementation((p) => page(p.status === 'closed'
      ? [{ ...voidReq, status: 'rejected', reviewed_by_name: 'Mary Manager', reviewed_at: '2026-10-31 09:00:00', review_note: 'Bring the item back first' }] : [], 0));
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('Bring the item back first')).toBeInTheDocument();
  });
});
