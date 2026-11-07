import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReceiveTab from './ReceiveTab';
import { stockApi } from '../../api/endpoints';
import { setUiVersion } from '../../utils/uiVersion';

vi.mock('../../api/endpoints', () => ({
  stockApi: {
    receipts: vi.fn(), receive: vi.fn(), receiptDrafts: vi.fn(), receiptDraft: vi.fn(),
    saveReceiptDraft: vi.fn(), updateReceiptDraft: vi.fn(), deleteReceiptDraft: vi.fn(), submitReceiptDraft: vi.fn(),
  },
  suppliersApi: { list: vi.fn(() => Promise.resolve({ data: { data: [] } })), create: vi.fn() },
  categoriesApi: { list: vi.fn(() => Promise.resolve({ data: { data: [] } })) },
  productsApi: { list: vi.fn(() => Promise.resolve({ data: { data: [] } })) },
}));
const auth = { perms: ['stock.receive'] };
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ can: (p) => auth.perms.includes(p) }) }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const dialog = { confirm: vi.fn() };
vi.mock('../../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));

const draftRow = { id: 4, supplier_name: 'Acme Ltd', reference: 'DN-77', line_count: 1, created_by_name: 'Kim Keeper', updated_at: '2026-11-06 09:30:00' };
const draftBody = { supplier_id: 2, reference: 'DN-77', items: [{ product_id: 5, quantity: 12, display: { name: 'Soap bar', sku: 'S-1' } }] };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ReceiveTab storeParams={{}} isMainStore /></QueryClientProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  auth.perms = ['stock.receive'];
  stockApi.receipts.mockResolvedValue({ data: { data: [], total: 0 } });
  stockApi.receiptDrafts.mockResolvedValue({ data: { data: [draftRow] } });
  stockApi.receiptDraft.mockResolvedValue({ data: { data: { ...draftRow, body: draftBody } } });
  stockApi.saveReceiptDraft.mockResolvedValue({ data: { data: { id: 9 } } });
  stockApi.updateReceiptDraft.mockResolvedValue({ data: { data: { id: 4 } } });
  stockApi.submitReceiptDraft.mockResolvedValue({ data: { data: { total_units: 12, items: [] } } });
  stockApi.receive.mockResolvedValue({ data: { data: { total_units: 1, items: [] } } });
  dialog.confirm.mockResolvedValue(true);
});

describe('Receive form with the current layout', () => {
  it('is as it was: no Save draft, no drafts list, and the drafts are never requested', async () => {
    setUiVersion('v1');
    const user = mount();
    await user.click(await screen.findByRole('button', { name: '+ Receive shipment' }));
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByText(/Drafts \(/)).toBeNull();
    expect(screen.queryByText(/set by a manager or admin/)).toBeNull();
    expect(stockApi.receiptDrafts).not.toHaveBeenCalled();
  });
});

describe('Receive form with the new layout', () => {
  beforeEach(() => setUiVersion('v2'));

  it('lists the drafts, with who started them', async () => {
    mount();
    expect(await screen.findByText('Drafts (1)')).toBeInTheDocument();
    expect(screen.getByText(/Acme Ltd/)).toBeInTheDocument();
    expect(screen.getByText(/1 line · started by Kim Keeper/)).toBeInTheDocument();
  });

  it('says buying prices are set after receiving, for someone who cannot enter them', async () => {
    mount();
    expect(await screen.findByText(/Buying prices are set by a manager or admin after the shipment is received/)).toBeInTheDocument();
    expect(screen.getByText('Set by admin')).toBeInTheDocument();
    expect(screen.queryByLabelText(/buying price per unit/i)).toBeNull();
  });

  it('saves the form as a draft without checking it, and receives nothing', async () => {
    const user = mount();
    await user.type(await screen.findByLabelText('Delivery note number'), 'DN-100');
    await user.click(screen.getByRole('button', { name: 'Save draft' })); // the line is still empty: a real receive would refuse this
    await waitFor(() => expect(stockApi.saveReceiptDraft).toHaveBeenCalledWith({ supplier_id: undefined, reference: 'DN-100', note: undefined, items: [] }));
    expect(stockApi.receive).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Nothing has been received'));
  });

  it('reopens a draft as it was left', async () => {
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Finish a draft delivery')).toBeInTheDocument();
    expect(screen.getByDisplayValue('DN-77')).toBeInTheDocument();
    expect(screen.getByText('Soap bar')).toBeInTheDocument();
    expect(screen.getByDisplayValue('12')).toBeInTheDocument();
  });

  it('saving a reopened draft updates it, not a second copy', async () => {
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(stockApi.updateReceiptDraft).toHaveBeenCalledWith(4, expect.objectContaining({ reference: 'DN-77' })));
    expect(stockApi.saveReceiptDraft).not.toHaveBeenCalled();
  });

  it('receives a reopened draft by sending the final form into it and submitting that draft, not by a second receive', async () => {
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Save shipment' }));
    await waitFor(() => expect(stockApi.submitReceiptDraft).toHaveBeenCalledWith(4));
    expect(stockApi.updateReceiptDraft).toHaveBeenCalledWith(4, { supplier_id: 2, reference: 'DN-77', note: undefined, items: [{ product_id: 5, quantity: 12, batch_no: undefined, expiry_date: undefined }] });
    expect(stockApi.receive).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Received 12 unit(s).');
  });

  it('still checks the form when finishing a draft', async () => {
    stockApi.receiptDraft.mockResolvedValue({ data: { data: { ...draftRow, body: { items: [{ product_id: 5, display: { name: 'Soap bar', sku: 'S-1' } }] } } } }); // no quantity
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Save shipment' }));
    expect(await screen.findByText('Line 1: enter how many arrived.')).toBeInTheDocument();
    expect(stockApi.submitReceiptDraft).not.toHaveBeenCalled();
  });

  it('keeps the draft when the receive is refused, and shows why', async () => {
    stockApi.submitReceiptDraft.mockRejectedValue({ response: { data: { error: { message: 'Line 1: product not found.' } } } });
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Save shipment' }));
    expect(await screen.findByText(/product not found/)).toBeInTheDocument();
    expect(stockApi.deleteReceiptDraft).not.toHaveBeenCalled();
  });

  it('deletes a draft only after confirming', async () => {
    stockApi.deleteReceiptDraft.mockResolvedValue({ data: { data: { id: 4, deleted: true } } });
    const user = mount();
    dialog.confirm.mockResolvedValueOnce(false);
    await user.click(await screen.findByRole('button', { name: /Delete draft DN-77/ }));
    expect(stockApi.deleteReceiptDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Delete draft DN-77/ }));
    await waitFor(() => expect(stockApi.deleteReceiptDraft).toHaveBeenCalledWith(4));
  });

  it('a direct receive with no draft is unchanged', async () => {
    stockApi.receiptDrafts.mockResolvedValue({ data: { data: [] } });
    const user = mount();
    await user.click(screen.getByRole('button', { name: 'Save shipment' }));
    expect(await screen.findByText('Line 1: enter how many arrived.')).toBeInTheDocument(); // the quantity is checked first, as before
    expect(stockApi.receive).not.toHaveBeenCalled();
  });
});
