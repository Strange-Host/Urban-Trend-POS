import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RemoveAccountSheet from './RemoveAccountSheet';
import { staffApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  staffApi: { removalCheck: vi.fn(), remove: vi.fn(), permanentDelete: vi.fn(), erasePersonalData: vi.fn() },
}));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const staff = { id: 12, name: 'Peter Mwangi' };
const check = (extra) => ({ data: { data: {
  id: 12, name: staff.name, role: 'cashier', active: true, erased: false, activity: {}, hasActivity: false,
  canDeletePermanently: true, canErase: false, eraseNeedsDeactivation: true, reasons: [], ...extra,
} } });

function mount(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><RemoveAccountSheet staff={staff} onClose={onClose} /></QueryClientProvider>);
  return onClose;
}

beforeEach(() => { Object.values(staffApi).forEach((f) => f.mockReset()); });

describe('RemoveAccountSheet', () => {
  it('an account that never did anything can be deleted, but only after typing the name', async () => {
    staffApi.removalCheck.mockResolvedValue(check());
    staffApi.permanentDelete.mockResolvedValue({ data: {} });
    const onClose = mount();
    const button = await screen.findByRole('button', { name: 'Delete permanently' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'peter' } });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Peter Mwangi' } });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    await waitFor(() => expect(staffApi.permanentDelete).toHaveBeenCalledWith(12, 'Peter Mwangi'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Erase personal data' })).toBeNull();   // erasing needs deactivation first
    expect(screen.getByText(/deactivate the account first/i)).toBeInTheDocument();
  });

  it('an account with history cannot be deleted, and the history is spelled out', async () => {
    staffApi.removalCheck.mockResolvedValue(check({
      hasActivity: true, canDeletePermanently: false, activity: { sales: 40, 'cash sessions': 6 },
      reasons: ['This account has history.'],
    }));
    mount();
    expect(await screen.findByText(/40 sales, 6 cash sessions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
  });

  it('a deactivated former employee can have their personal data erased, keeping the records', async () => {
    staffApi.removalCheck.mockResolvedValue(check({
      active: false, hasActivity: true, canDeletePermanently: false, canErase: true, eraseNeedsDeactivation: false, activity: { sales: 3 },
    }));
    staffApi.erasePersonalData.mockResolvedValue({ data: {} });
    mount();
    const erase = await screen.findByRole('button', { name: 'Erase personal data' });
    expect(erase).toBeDisabled();
    expect(screen.getByText(/former staff #12/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Peter Mwangi' } });
    fireEvent.click(erase);
    await waitFor(() => expect(staffApi.erasePersonalData).toHaveBeenCalledWith(12, 'Peter Mwangi'));
  });

  it('shows the server\'s reason when something fails', async () => {
    staffApi.removalCheck.mockResolvedValue(check());
    staffApi.permanentDelete.mockRejectedValue({ response: { data: { error: { message: 'This is the only active admin.' } } } });
    mount();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Peter Mwangi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('only active admin');
  });

  it('cannot deactivate yourself or the last admin from here', async () => {
    staffApi.removalCheck.mockResolvedValue(check({ canDeletePermanently: false, reasons: ['This is the only active admin. Make another admin first.'] }));
    mount();
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeDisabled();
  });
});
