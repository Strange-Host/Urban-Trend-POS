import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Leads from './Leads';
import { leadsApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  leadsApi: { list: vi.fn(), stats: vi.fn(), getById: vi.fn(), update: vi.fn(), remove: vi.fn(), create: vi.fn(), changeStatus: vi.fn(), addActivity: vi.fn() },
  staffApi: { list: vi.fn() },
  productsApi: { list: vi.fn() },
}));
vi.mock('../api/fetchAll', () => ({ fetchAll: vi.fn(() => Promise.resolve([])) }));
let role = 'manager';
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasRole: (...r) => r.includes(role) }) }));
const toast = { success: vi.fn(), error: vi.fn() };
const confirm = vi.fn();
vi.mock('../context/UIContext', () => ({ useToast: () => toast, useDialog: () => ({ confirm, prompt: vi.fn() }) }));

const ok = (data, extra = {}) => Promise.resolve({ data: { data, ...extra } });
const lead = { id: 3, name: 'Wanjiru', phone: '0712345678', email: '', status: 'contacted', source: 'walk_in', notes: 'wants serum', activities: [], created_at: '2026-10-30 10:00:00' };
const mount = () => render(
  <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Leads /></QueryClientProvider></MemoryRouter>,
);

async function openLead() {
  await screen.findByText('Wanjiru');
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  return screen.findByRole('button', { name: 'Edit lead' });
}

beforeEach(() => {
  Object.values(leadsApi).forEach((f) => f.mockReset());
  [toast.success, toast.error, confirm].forEach((f) => f.mockReset());
  leadsApi.list.mockReturnValue(ok([lead], { total: 1 }));
  leadsApi.stats.mockReturnValue(ok({}));
  leadsApi.getById.mockReturnValue(ok(lead));
  role = 'manager';
});

describe('Leads edit and delete', () => {
  it('opens the edit form filled in and saves the changes', async () => {
    leadsApi.update.mockResolvedValue({ data: { data: lead } });
    mount();
    fireEvent.click(await openLead());
    expect(screen.getByLabelText('Name')).toHaveValue('Wanjiru');
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '0722000111' } });
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'wants two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(leadsApi.update).toHaveBeenCalledWith(3, { name: 'Wanjiru', phone: '0722000111', email: undefined, notes: 'wants two' }));
    expect(toast.success).toHaveBeenCalledWith('Lead updated.');
  });

  it('shows the server message and keeps the form open when the edit is refused', async () => {
    leadsApi.update.mockRejectedValue({ response: { data: { error: 'That phone belongs to another lead.' } } });
    mount();
    fireEvent.click(await openLead());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/another lead|Could not update/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('deletes only after the confirmation is accepted', async () => {
    leadsApi.remove.mockResolvedValue({});
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mount();
    await openLead();
    fireEvent.click(screen.getByRole('button', { name: 'Delete lead' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(leadsApi.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete lead' }));
    await waitFor(() => expect(leadsApi.remove).toHaveBeenCalledWith(3));
    expect(toast.success).toHaveBeenCalledWith('Lead deleted.');
  });

  it('lets a cashier edit but not delete', async () => {
    role = 'cashier';
    mount();
    await openLead();
    expect(screen.queryByRole('button', { name: 'Delete lead' })).not.toBeInTheDocument();
  });

  it('does not offer delete on a converted lead', async () => {
    leadsApi.getById.mockReturnValue(ok({ ...lead, status: 'converted', converted_order_id: 5 }));
    mount();
    await openLead();
    expect(screen.queryByRole('button', { name: 'Delete lead' })).not.toBeInTheDocument();
  });
});
