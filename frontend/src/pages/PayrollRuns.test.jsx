import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PayrollRuns from './PayrollRuns';
import { payrollApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  payrollApi: { runs: vi.fn(), run: vi.fn(), verifyRun: vi.fn(), generateRun: vi.fn(), approveRun: vi.fn(), payRun: vi.fn() },
}));
let mockUser = { role: 'admin' };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const item = (extra) => ({
  staffId: 7, staffName: 'Grace Wanjiru', daysWorked: 5, retainer: 150000, unitsSold: 4, achievedSales: 400000, target: 5000000,
  achievementBp: 800, tier: '<70%', rate: 3000, commission: 12000, late: 0, absence: 0, missingHours: 0, advances: 20000, lossDeductions: 0,
  gross: 162000, deductions: 20000, net: 142000, payable: 142000, shortfall: 0,
  lines: [
    { kind: 'retainer_day', refDate: '2026-10-01', refText: null, quantity: null, amountCents: 30000 },
    { kind: 'commission_order', refDate: '2026-10-02', refText: 'UT-0042', quantity: 2, amountCents: 6000 },
    { kind: 'salary_advance', refDate: '2026-10-03', refText: 'Emergency', quantity: null, amountCents: 20000 },
  ], ...extra,
});
const run = (extra) => ({
  id: 1, periodStart: '2026-10-01', periodEnd: '2026-10-07', status: 'draft', createdByName: 'Admin', createdAt: '2026-10-08 06:00:00',
  approvedByName: null, approvedAt: null, paidByName: null, paidAt: null, paymentMethod: null, paymentRef: null, checksum: null,
  items: [item()], totals: { gross: 162000, deductions: 20000, net: 142000, payable: 142000, shortfall: 0, commission: 12000 }, ...extra,
});
const ok = (data) => Promise.resolve({ data: { data } });
const apiError = (code, message) => Object.assign(new Error(code), { response: { data: { error: { code, message } } } });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PayrollRuns /></QueryClientProvider>);
}
async function open(r) {
  payrollApi.runs.mockReturnValue(ok([{ id: r.id, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status }]));
  payrollApi.run.mockReturnValue(ok(r));
  mount();
  fireEvent.click(await screen.findByText('2026-10-01 → 2026-10-07', { selector: 'span' }));
  await screen.findByText('Grace Wanjiru');
}

beforeEach(() => {
  Object.values(payrollApi).forEach((f) => f.mockReset());
  payrollApi.verifyRun.mockReturnValue(ok({ locked: true, intact: true }));
  mockUser = { role: 'admin' };
});

describe('PayrollRuns', () => {
  it('calculates a draft for the chosen dates and opens it', async () => {
    payrollApi.runs.mockReturnValue(ok([]));
    payrollApi.generateRun.mockReturnValue(ok(run()));
    payrollApi.run.mockReturnValue(ok(run()));
    mount();
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate draft' }));
    await waitFor(() => expect(payrollApi.generateRun).toHaveBeenCalledWith('2026-10-01', '2026-10-07'));
    expect(await screen.findByText('Grace Wanjiru')).toBeInTheDocument();
  });

  it('shows the totals and expands a person into itemised lines', async () => {
    await open(run());
    expect(screen.getAllByText('Draft')).toHaveLength(2); // in the list and in the open run
    expect(screen.getAllByText('Payable')[0].nextSibling).toHaveTextContent('1,420.00');
    expect(screen.getByText('Owed back').nextSibling).toHaveTextContent('0.00');
    fireEvent.click(screen.getByRole('button', { name: /Grace Wanjiru/ }));
    expect(screen.getByText(/Commission · UT-0042/)).toBeInTheDocument();
    expect(screen.getByText(/Salary advance · Emergency/)).toBeInTheDocument();
  });

  it('an admin approves only after confirming the lock', async () => {
    payrollApi.approveRun.mockReturnValue(ok(run({ status: 'approved' })));
    await open(run());
    fireEvent.click(screen.getByRole('button', { name: 'Approve and lock' }));
    expect(payrollApi.approveRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve and lock' }));
    await waitFor(() => expect(payrollApi.approveRun).toHaveBeenCalledWith(1));
  });

  it('a manager sees the pay buttons but cannot use them', async () => {
    mockUser = { role: 'manager' };
    await open(run());
    expect(screen.getByRole('button', { name: 'Approve and lock' })).toBeDisabled();
    expect(screen.getByText('Only an admin can approve or pay a run.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recalculate' })).toBeEnabled(); // drafting is open to managers
  });

  it('a manager also sees Mark as paid on an approved run, disabled', async () => {
    mockUser = { role: 'manager' };
    await open(run({ status: 'approved', checksum: 'a'.repeat(64), approvedAt: '2026-10-08 07:00:00', approvedByName: 'Admin' }));
    expect(await screen.findByRole('button', { name: 'Mark as paid' })).toBeDisabled();
  });

  it('a stale draft explains itself, blocks approval and recalculates on request', async () => {
    payrollApi.approveRun.mockRejectedValue(apiError('RUN_STALE', 'stale'));
    payrollApi.generateRun.mockReturnValue(ok(run()));
    await open(run());
    fireEvent.click(screen.getByRole('button', { name: 'Approve and lock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve and lock' }));
    expect(await screen.findByText(/Something changed since this draft/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and lock' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate' }));
    await waitFor(() => expect(payrollApi.generateRun).toHaveBeenCalledWith('2026-10-01', '2026-10-07'));
    await waitFor(() => expect(screen.queryByText(/Something changed since this draft/)).not.toBeInTheDocument());
  });

  it('paying by M-Pesa needs a reference; cash does not', async () => {
    payrollApi.payRun.mockReturnValue(ok(run({ status: 'paid' })));
    await open(run({ status: 'approved', checksum: 'a'.repeat(64), approvedAt: '2026-10-08 07:00:00', approvedByName: 'Admin' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as paid' }));
    const confirm = screen.getByRole('button', { name: 'Confirm payment' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Payment reference'), { target: { value: 'QWE123' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(payrollApi.payRun).toHaveBeenCalledWith(1, 'mpesa', 'QWE123'));

    fireEvent.click(await screen.findByRole('button', { name: 'Mark as paid' }));
    fireEvent.change(screen.getByLabelText('Paid by'), { target: { value: 'cash' } });
    expect(screen.queryByLabelText('Payment reference')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm payment' })).toBeEnabled();
  });

  it('a verified locked run says so, and a tampered one raises an alert', async () => {
    const locked = run({ status: 'approved', checksum: 'abcdef0123456789'.repeat(4), approvedAt: '2026-10-08 07:00:00', approvedByName: 'Admin' });
    await open(locked);
    expect(await screen.findByText(/Fingerprint verified/)).toBeInTheDocument();
  });

  it('flags a locked run whose fingerprint no longer matches', async () => {
    payrollApi.verifyRun.mockReturnValue(ok({ locked: true, intact: false }));
    await open(run({ status: 'approved', checksum: 'b'.repeat(64), approvedAt: '2026-10-08 07:00:00', approvedByName: 'Admin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not match/);
  });
});
