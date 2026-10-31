import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Expenses from './Expenses';
import { expensesApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  expensesApi: { list: vi.fn(), summary: vi.fn(), listCategories: vi.fn(), createCategory: vi.fn(), create: vi.fn(), update: vi.fn() },
  pettyCashApi: { overview: vi.fn(), createTopup: vi.fn() },
}));
let perms = new Set();
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'manager' }, can: (p) => perms.has(p) }) }));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }), useDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }) }));

const ok = (data, extra = {}) => Promise.resolve({ data: { data, ...extra } });
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Expenses /></QueryClientProvider>);

beforeEach(() => {
  Object.values(expensesApi).forEach((f) => f.mockReset());
  expensesApi.list.mockReturnValue(ok([], { total: 0 }));
  expensesApi.summary.mockReturnValue(ok({ by_category: [] }));
  expensesApi.listCategories.mockReturnValue(ok([{ id: 1, name: 'Rent' }]));
  expensesApi.createCategory.mockResolvedValue({ data: { data: { id: 9, name: 'Packaging' } } });
  perms = new Set(['expenses.view', 'expenses.manage']);
});

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: '+ Record expense' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Expense category' }));
}

describe('Expenses category picker', () => {
  it('lets someone who manages expenses add a category from the form and selects it', async () => {
    mount();
    await openForm();
    fireEvent.click(await screen.findByRole('button', { name: '+ New category…' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Packaging' } });
    expensesApi.listCategories.mockReturnValue(ok([{ id: 1, name: 'Rent' }, { id: 9, name: 'Packaging' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(expensesApi.createCategory).toHaveBeenCalledWith('Packaging'));
    expect(await screen.findByRole('button', { name: 'Expense category' })).toHaveTextContent('Packaging');
  });

  it('cannot reach the category form without expenses.manage', async () => {
    perms = new Set(['expenses.view']);
    mount();
    // Without manage the record-expense button is not offered at all, so the picker never opens.
    await screen.findByText(/Expenses/);
    expect(screen.queryByRole('button', { name: '+ Record expense' })).not.toBeInTheDocument();
    expect(expensesApi.createCategory).not.toHaveBeenCalled();
  });
});
