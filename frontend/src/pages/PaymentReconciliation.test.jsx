import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PaymentReconciliation from './PaymentReconciliation';
import { paymentReconciliationApi, ordersApi, custodyApi } from '../api/endpoints';

// The page as it runs against the new server.
vi.mock('../api/newServer', async (orig) => ({ ...(await orig()), USE_NEW_SERVER: true }));
vi.mock('../api/endpoints', () => ({
  paymentReconciliationApi: { unmatched: vi.fn(), match: vi.fn(), ignore: vi.fn(), suggestions: vi.fn() },
  ordersApi: { list: vi.fn() },
  custodyApi: { list: vi.fn(), deposit: vi.fn() },
}));
const dialog = { prompt: vi.fn(), confirm: vi.fn() };
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../context/UIContext', () => ({ useDialog: () => dialog, useToast: () => toast }));

const item = { id: 4, created_at: '2026-10-27T09:00:00Z', source: 'mpesa', payer_name: 'A friend', external_reference: 'QRT1234567', amount: 500_000, matched_code: null };
const page = (rows) => ({ data: { data: rows, page: 1, pageSize: 25, total: rows.length, totalPages: 1, summary: { unallocated: rows.reduce((s, r) => s + r.amount, 0) } } });
const held = { id: 9, holder: 'mona', order_id: 'UT-7K49M2XQ', amount: 100_000, receipt_no: 'RC-2026-000004', opened_at: '2026-10-27T10:00:00Z' };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaymentReconciliation /></QueryClientProvider>);
}

beforeEach(() => {
  [paymentReconciliationApi, ordersApi, custodyApi, dialog, toast].forEach((o) => Object.values(o).forEach((f) => f.mockReset()));
  paymentReconciliationApi.unmatched.mockResolvedValue(page([item]));
  paymentReconciliationApi.suggestions.mockResolvedValue({ data: { data: [{ id: 'UT-AAAA1111', customer_name: 'Wanjiku', outstanding: 500_000, same_phone: true, exact_amount: true }] } });
  custodyApi.list.mockResolvedValue({ data: { data: [] } });
  ordersApi.list.mockResolvedValue({ data: { data: [] } });
});

describe('Payment reconciliation on the new server', () => {
  it('offers likely orders for an unmatched payment and matches with one tap', async () => {
    paymentReconciliationApi.match.mockResolvedValue({ data: {} });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Match to order' }));
    expect(await screen.findByText('Likely orders')).toBeInTheDocument();
    expect(screen.getByText(/same phone number/)).toBeInTheDocument();
    expect(screen.getByText(/exact amount/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Match' })[0]);
    await waitFor(() => expect(paymentReconciliationApi.match).toHaveBeenCalledWith(4, 'UT-AAAA1111'));
  });

  it('calls the second action Refund, and will not send one without a reason', async () => {
    paymentReconciliationApi.ignore.mockResolvedValue({ data: {} });
    mount();
    const refund = await screen.findByRole('button', { name: 'Refund' });
    expect(screen.queryByRole('button', { name: 'Ignore' })).toBeNull();

    dialog.prompt.mockResolvedValueOnce('   ');
    fireEvent.click(refund);
    expect(await screen.findByText('Say why this payment is being refunded.')).toBeInTheDocument();
    expect(paymentReconciliationApi.ignore).not.toHaveBeenCalled();

    dialog.prompt.mockResolvedValueOnce('Paid by mistake');
    fireEvent.click(refund);
    await waitFor(() => expect(paymentReconciliationApi.ignore).toHaveBeenCalledWith(4, 'Paid by mistake'));
  });

  it('shows no cash-held section when none is held, and lists it with a Deposited button when there is some', async () => {
    mount();
    await screen.findByRole('button', { name: 'Refund' });
    expect(screen.queryByText('Shop cash waiting to be deposited')).toBeNull();
  });

  it('deposits held cash after a confirmation, and leaves it alone when declined', async () => {
    custodyApi.list.mockResolvedValue({ data: { data: [held] } });
    custodyApi.deposit.mockResolvedValue({ data: {} });
    mount();
    const section = (await screen.findByText('Shop cash waiting to be deposited')).closest('div');
    expect(within(section).getByText('mona')).toBeInTheDocument();
    expect(within(section).getByText(/UT-7K49M2XQ/)).toBeInTheDocument();

    dialog.confirm.mockResolvedValueOnce(false);
    fireEvent.click(within(section).getByRole('button', { name: 'Deposited' }));
    await waitFor(() => expect(dialog.confirm).toHaveBeenCalledTimes(1));
    expect(custodyApi.deposit).not.toHaveBeenCalled();

    dialog.confirm.mockResolvedValueOnce(true);
    fireEvent.click(within(section).getByRole('button', { name: 'Deposited' }));
    await waitFor(() => expect(custodyApi.deposit).toHaveBeenCalledWith(9));
  });

  it('says so plainly when nothing is waiting', async () => {
    paymentReconciliationApi.unmatched.mockResolvedValue(page([]));
    mount();
    expect(await screen.findByText('Nothing to reconcile.')).toBeInTheDocument();
  });
});
