import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BranchesSection, SuppliersSection } from './SettingsBranches';
import { storesApi, suppliersApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  storesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
  suppliersApi: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast }));

const ok = (data) => Promise.resolve({ data: { data } });
const apiError = (status, message) => ({ response: { status, data: { error: { message } } } });
const mount = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const main = { id: 1, name: 'Main store', address: 'Moi Ave', is_active: 1, is_main: 1 };
const outlet = { id: 2, name: 'Thika outlet', address: null, is_active: 1, is_main: 0 };
const supplier = { id: 5, name: 'Acme Ltd', phone: '0700111222', email: 'a@acme.co', address: null, note: null, is_active: 1 };

beforeEach(() => {
  [...Object.values(storesApi), ...Object.values(suppliersApi), toast.success, toast.error].forEach((f) => f.mockReset());
});

describe('BranchesSection', () => {
  it('lists branches and marks the main store', async () => {
    storesApi.list.mockReturnValue(ok([main, { ...outlet, is_active: 0 }]));
    mount(<BranchesSection />);
    expect(await screen.findByText('Main store')).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('adds a branch, then refreshes the list', async () => {
    storesApi.list.mockReturnValueOnce(ok([main])).mockReturnValue(ok([main, outlet]));
    storesApi.create.mockReturnValue(ok(outlet));
    mount(<BranchesSection />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add branch' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Thika outlet ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add branch' }));
    await waitFor(() => expect(storesApi.create).toHaveBeenCalledWith({ name: 'Thika outlet', address: '' }));
    expect(await screen.findByText('Thika outlet')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it('blocks an empty name without calling the API', async () => {
    storesApi.list.mockReturnValue(ok([main]));
    mount(<BranchesSection />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add branch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add branch' }));
    expect(screen.getByText('Enter a branch name.')).toBeInTheDocument();
    expect(storesApi.create).not.toHaveBeenCalled();
  });

  it('shows the server message on a duplicate name and keeps the form open', async () => {
    storesApi.list.mockReturnValue(ok([main]));
    storesApi.create.mockRejectedValue(apiError(409, 'A branch with that name already exists.'));
    mount(<BranchesSection />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add branch' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main store' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add branch' }));
    expect(await screen.findByText('A branch with that name already exists.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('edits a branch and can switch it off', async () => {
    storesApi.list.mockReturnValue(ok([main, outlet]));
    storesApi.update.mockReturnValue(ok(outlet));
    mount(<BranchesSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Thika outlet' }));
    fireEvent.change(screen.getByLabelText('Address (optional)'), { target: { value: 'Thika Rd' } });
    fireEvent.click(screen.getByLabelText(/Active/));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(storesApi.update).toHaveBeenCalledWith(2, { name: 'Thika outlet', address: 'Thika Rd', is_active: false }));
  });

  it('does not let the main store be switched off', async () => {
    storesApi.list.mockReturnValue(ok([main]));
    mount(<BranchesSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Main store' }));
    expect(screen.getByLabelText(/Active/)).toBeDisabled();
  });
});

describe('SuppliersSection', () => {
  it('lists suppliers including switched-off ones', async () => {
    suppliersApi.list.mockReturnValue(ok([supplier, { ...supplier, id: 6, name: 'Old Co', is_active: 0 }]));
    mount(<SuppliersSection />);
    expect(await screen.findByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByText('Old Co')).toBeInTheDocument();
    expect(suppliersApi.list).toHaveBeenCalledWith({ include_inactive: 1 });
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    suppliersApi.list.mockReturnValue(ok([]));
    mount(<SuppliersSection />);
    expect(await screen.findByText('No suppliers yet.')).toBeInTheDocument();
  });

  it('corrects a supplier and sends every field', async () => {
    suppliersApi.list.mockReturnValue(ok([supplier]));
    suppliersApi.update.mockReturnValue(ok(supplier));
    mount(<SuppliersSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Acme Ltd' }));
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '0711000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(suppliersApi.update).toHaveBeenCalledWith(5, {
      name: 'Acme Ltd', phone: '0711000000', email: 'a@acme.co', address: '', note: '', is_active: true,
    }));
    expect(toast.success).toHaveBeenCalled();
  });

  it('adds a supplier', async () => {
    suppliersApi.list.mockReturnValue(ok([]));
    suppliersApi.create.mockReturnValue(ok(supplier));
    mount(<SuppliersSection />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add supplier' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme Ltd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    await waitFor(() => expect(suppliersApi.create).toHaveBeenCalledWith({ name: 'Acme Ltd', phone: '', email: '', address: '', note: '' }));
  });

  it('validates the name and shows a server clash', async () => {
    suppliersApi.list.mockReturnValue(ok([supplier]));
    suppliersApi.update.mockRejectedValue(apiError(409, 'A supplier with that name already exists.'));
    mount(<SuppliersSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Acme Ltd' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Enter a supplier name.')).toBeInTheDocument();
    expect(suppliersApi.update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('A supplier with that name already exists.')).toBeInTheDocument();
  });
});
