import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Custody, { ageInDays } from './Custody';
import Finance from './Finance';
import { custodyApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({ custodyApi: { list: vi.fn(), deposit: vi.fn() } }));
let perms = new Set();
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 }, can: (p) => perms.has(p) }) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast, useDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }) }));
// Finance renders whole pages; only its tab bar matters here.
vi.mock('./Payments', () => ({ default: () => <div>payments page</div> }));
vi.mock('./Expenses', () => ({ default: () => <div>expenses page</div> }));
vi.mock('./CashSessions', () => ({ default: () => <div>cash sessions page</div> }));
vi.mock('./Couriers', () => ({ default: () => <div>couriers page</div> }));
vi.mock('./DeliveryAreas', () => ({ default: () => <div>delivery areas page</div> }));

const ok = (data) => Promise.resolve({ data: { data } });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().replace('T', ' ').slice(0, 19);
const rec = (o) => ({ id: 1, holder_staff_id: 7, holder: 'Grace', order_id: 40, order_ref: 'UT-40', amount: 150000, reason: 'Customer paid at the shop', opened_at: daysAgo(1), ...o });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const mount = (ui = <Custody />) => render(<QueryClientProvider client={client()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  Object.values(custodyApi).forEach((f) => f.mockReset());
  [toast.success, toast.error].forEach((f) => f.mockReset());
  perms = new Set(['custody.manage']);
});

describe('ageInDays', () => {
  it('reads SQLite UTC timestamps', () => {
    expect(ageInDays('2026-10-30 12:00:00', Date.parse('2026-11-01T13:00:00Z'))).toBe(2);
    expect(ageInDays('2026-11-01 12:00:00', Date.parse('2026-11-01T13:00:00Z'))).toBe(0);
  });
  it('treats an unreadable date as today instead of failing', () => {
    expect(ageInDays('nonsense')).toBe(0);
  });
});

describe('Custody', () => {
  it('lists open records with holder, order, age and amount, and totals them', async () => {
    custodyApi.list.mockReturnValue(ok([rec(), rec({ id: 2, holder_staff_id: 8, holder: 'Peter', order_ref: 'UT-41', amount: 50000, opened_at: daysAgo(8) })]));
    mount();
    expect(await screen.findByText('Grace')).toBeInTheDocument();
    expect(screen.getByText('Peter')).toBeInTheDocument();
    expect(screen.getByText('KES 2,000.00')).toBeInTheDocument();      // 1500 + 500 held
    expect(screen.getAllByText('8 days')).toHaveLength(2);   // the row's age pill and the "Oldest" card
    expect(screen.getByText('1 day')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    custodyApi.list.mockReturnValue(ok([]));
    mount();
    expect(await screen.findByText(/No shop cash is being held/)).toBeInTheDocument();
  });

  it('shows the server message when the list cannot load', async () => {
    custodyApi.list.mockRejectedValue({ response: { data: { error: { message: 'Forbidden.' } } } });
    mount();
    expect(await screen.findByText('Forbidden.')).toBeInTheDocument();
  });

  it('records a deposit after confirmation, refreshes the list and closes the sheet', async () => {
    custodyApi.list.mockReturnValueOnce(ok([rec()])).mockReturnValue(ok([]));
    custodyApi.deposit.mockReturnValue(ok({ amount: 150000 }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Record deposit' }));
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm KES 1,500.00 deposited' }));
    await waitFor(() => expect(custodyApi.deposit).toHaveBeenCalledWith(1));
    expect(toast.success).toHaveBeenCalled();
    expect(await screen.findByText(/No shop cash is being held/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be undone/)).not.toBeInTheDocument();
  });

  it('does nothing when the sheet is cancelled', async () => {
    custodyApi.list.mockReturnValue(ok([rec()]));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Record deposit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/cannot be undone/)).not.toBeInTheDocument();
    expect(custodyApi.deposit).not.toHaveBeenCalled();
  });

  it('shows the API message and reloads when the cash was already deposited', async () => {
    custodyApi.list.mockReturnValue(ok([rec()]));
    custodyApi.deposit.mockRejectedValue({ response: { status: 409, data: { error: { message: 'This cash has already been deposited.' } } } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Record deposit' }));
    fireEvent.click(screen.getByRole('button', { name: /deposited$/ }));
    expect(await screen.findByText('This cash has already been deposited.')).toBeInTheDocument();
    await waitFor(() => expect(custodyApi.list).toHaveBeenCalledTimes(2));
  });
});

describe('Finance tab', () => {
  it('shows the Custody tab only with the custody.manage permission', async () => {
    custodyApi.list.mockReturnValue(ok([]));
    mount(<MemoryRouter><Finance /></MemoryRouter>); // Finance reads ?tab=, so it lives inside a router, as in the app
    fireEvent.click(await screen.findByRole('tab', { name: 'Custody' }));
    expect(await screen.findByText(/No shop cash is being held/)).toBeInTheDocument();
  });

  it('hides it without the permission', () => {
    perms = new Set();
    mount(<MemoryRouter><Finance /></MemoryRouter>); // Finance reads ?tab=, so it lives inside a router, as in the app
    expect(screen.getByRole('tab', { name: 'Couriers' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Custody' })).not.toBeInTheDocument();
    expect(custodyApi.list).not.toHaveBeenCalled();
  });
});
