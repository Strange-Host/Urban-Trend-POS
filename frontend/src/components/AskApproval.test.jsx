import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AskApproval from './AskApproval';
import { approvalsApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({ approvalsApi: { create: vi.fn() } }));
const toast = { success: vi.fn(), error: vi.fn() };
const dialog = { prompt: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));

function mount(props) {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  render(
    <MemoryRouter><QueryClientProvider client={client}><AskApproval {...props} /></QueryClientProvider></MemoryRouter>,
  );
  return spy;
}

beforeEach(() => {
  approvalsApi.create.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  dialog.prompt.mockReset();
});

describe('AskApproval', () => {
  it('asks for a reason, files a void request for the sale, and refreshes the list', async () => {
    approvalsApi.create.mockResolvedValue({});
    dialog.prompt.mockResolvedValue('  Wrong item scanned ');
    const invalidate = mount({ kind: 'void_sale', targetId: 42, label: 'Request void', invalidateKeys: [['sales']] });
    fireEvent.click(screen.getByRole('button', { name: 'Request void' }));
    await waitFor(() => expect(approvalsApi.create).toHaveBeenCalledWith({ kind: 'void_sale', sale_id: 42, reason: 'Wrong item scanned' }));
    expect(dialog.prompt.mock.calls[0][0]).toMatchObject({ required: true });
    expect(toast.success).toHaveBeenCalled();
    const keys = invalidate.mock.calls.map((c) => c[0].queryKey);
    expect(keys).toEqual(expect.arrayContaining([['sales'], ['approvals']]));
  });

  it('files a refund request against the payment', async () => {
    approvalsApi.create.mockResolvedValue({});
    dialog.prompt.mockResolvedValue('Paid twice');
    mount({ kind: 'refund_payment', targetId: 9, label: 'Request refund' });
    fireEvent.click(screen.getByRole('button', { name: 'Request refund' }));
    await waitFor(() => expect(approvalsApi.create).toHaveBeenCalledWith({ kind: 'refund_payment', payment_id: 9, reason: 'Paid twice' }));
  });

  it('files nothing if the reason prompt is dismissed or left blank', async () => {
    mount({ kind: 'void_sale', targetId: 42, label: 'Request void' });
    dialog.prompt.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Request void' }));
    await waitFor(() => expect(dialog.prompt).toHaveBeenCalledTimes(1));
    dialog.prompt.mockResolvedValueOnce('   ');
    fireEvent.click(screen.getByRole('button', { name: 'Request void' }));
    await waitFor(() => expect(dialog.prompt).toHaveBeenCalledTimes(2));
    expect(approvalsApi.create).not.toHaveBeenCalled();
  });

  it('shows the server\'s message when the request is refused', async () => {
    approvalsApi.create.mockRejectedValue({ response: { status: 409, data: { error: { message: 'A request for this is already waiting for a manager.' } } } });
    dialog.prompt.mockResolvedValue('Because');
    mount({ kind: 'void_sale', targetId: 42, label: 'Request void' });
    fireEvent.click(screen.getByRole('button', { name: 'Request void' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A request for this is already waiting for a manager.'));
  });

  it('replaces the button with a link once a request is open, so it cannot be filed twice', () => {
    mount({ kind: 'void_sale', targetId: 42, pendingId: 11, label: 'Request void' });
    expect(screen.queryByRole('button', { name: 'Request void' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Void requested' })).toHaveAttribute('href', '/approvals');
  });
});
