import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PayTerms from './PayTerms';
import { payrollApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({ payrollApi: { payTerms: vi.fn(), setPayTerms: vi.fn() } }));
let mockUser = { role: 'admin' };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const ok = (data) => Promise.resolve({ data: { data } });
const terms = [
  { staffId: 7, name: 'Grace Wanjiru', role: 'cashier', type: 'fixed', fixedCents: null, percentBp: 0 },
  { staffId: 8, name: 'Peter Otieno', role: 'cashier', type: 'combined', fixedCents: 1000, percentBp: 150 },
];
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PayTerms /></QueryClientProvider>);

beforeEach(() => {
  Object.values(payrollApi).forEach((f) => f.mockReset());
  payrollApi.payTerms.mockReturnValue(ok(terms));
  mockUser = { role: 'admin' };
});

describe('PayTerms', () => {
  it('summarises each person\'s pay type', async () => {
    mount();
    expect(await screen.findByText(/tier rate per unit/)).toBeInTheDocument();
    expect(screen.getByText(/\+ 1.5% of each sale/)).toBeInTheDocument();
  });

  it('saves a percentage pay type in cents and basis points', async () => {
    payrollApi.setPayTerms.mockReturnValue(ok({}));
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    fireEvent.change(screen.getByLabelText('Pay type'), { target: { value: 'percentage' } });
    expect(screen.queryByLabelText(/Amount per unit/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Share of each sale/), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(payrollApi.setPayTerms).toHaveBeenCalledWith(7, { type: 'percentage', fixed_cents: null, percent_bp: 250 }));
  });

  it('saves a fixed amount per unit', async () => {
    payrollApi.setPayTerms.mockReturnValue(ok({}));
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    fireEvent.change(screen.getByLabelText(/Amount per unit/), { target: { value: '45.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(payrollApi.setPayTerms).toHaveBeenCalledWith(7, { type: 'fixed', fixed_cents: 4550, percent_bp: 0 }));
  });

  it('is closed to anyone but an admin', () => {
    mockUser = { role: 'manager' };
    mount();
    expect(screen.getByText(/Only an admin can see or change how people are paid/)).toBeInTheDocument();
    expect(payrollApi.payTerms).not.toHaveBeenCalled();
  });
});
