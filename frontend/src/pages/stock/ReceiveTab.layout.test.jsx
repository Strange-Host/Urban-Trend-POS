import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReceiveTab from './ReceiveTab';
import { stockApi, productsApi } from '../../api/endpoints';

vi.mock('../../api/endpoints', () => ({
  stockApi: {
    receipts: vi.fn(), receive: vi.fn(), receiptDrafts: vi.fn(), receiptDraft: vi.fn(),
    saveReceiptDraft: vi.fn(), updateReceiptDraft: vi.fn(), deleteReceiptDraft: vi.fn(), submitReceiptDraft: vi.fn(),
  },
  suppliersApi: { list: vi.fn(() => Promise.resolve({ data: { data: [] } })), create: vi.fn() },
  categoriesApi: { list: vi.fn(() => Promise.resolve({ data: { data: [] } })) },
  productsApi: { list: vi.fn() },
}));
const auth = { perms: ['stock.receive'] };
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ can: (p) => auth.perms.includes(p) }) }));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const dialog = { confirm: vi.fn() };
vi.mock('../../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));

const soap = { id: 5, name: 'Soap bar', sku: 'S-1', sell_price: 120000 };
const receipt = (over = {}) => ({ id: 1, received_on: '2026-11-06', supplier_name: 'Acme Ltd', reference: 'DN-9', received_by_name: 'Kim', total_units: 36, items: [], ...over });

function mount(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><ReceiveTab storeParams={{}} isMainStore {...props} /></QueryClientProvider>);
  return userEvent.setup();
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  auth.perms = ['stock.receive'];
  stockApi.receipts.mockResolvedValue({ data: { data: [receipt()], total: 1 } });
  stockApi.receiptDrafts.mockResolvedValue({ data: { data: [] } });
  stockApi.receive.mockResolvedValue({ data: { data: { total_units: 24, items: [] } } });
  productsApi.list.mockResolvedValue({ data: { data: [soap] } });
});

async function pickSoap(user, line = 1) {
  await user.type(screen.getByLabelText(`Line ${line} item`), 'soap');
  await user.click(await screen.findByRole('button', { name: /Soap bar/ }));
}

describe('Receive, new layout: the delivery form', () => {
  it('is on the page with no button to open it, beside Recent activity', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'New delivery' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Receive shipment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save shipment' })).toBeInTheDocument();
  });

  it('shows "Set by admin" instead of a buying price field to someone who cannot cost', async () => {
    mount();
    expect(await screen.findByText('Set by admin')).toBeInTheDocument();
    expect(screen.queryByLabelText(/buying price per unit/i)).toBeNull();
  });

  it('gives a person who may set buying prices the field', async () => {
    auth.perms = ['stock.receive', 'products.manage', 'products.view_cost'];
    mount();
    expect(await screen.findByLabelText('Line 1 buying price per unit (KES)')).toBeInTheDocument();
    expect(screen.queryByText('Set by admin')).toBeNull();
  });

  it('shows an existing item\'s current selling price, read only, and does not send one', async () => {
    const user = mount();
    await screen.findByRole('heading', { name: 'New delivery' });
    await pickSoap(user);
    expect(screen.getByText('KES 1,200')).toBeInTheDocument();
    expect(screen.queryByLabelText(/selling price/i)).toBeNull();
    await user.type(screen.getByLabelText('Line 1 quantity'), '24');
    await user.click(screen.getByRole('button', { name: 'Save shipment' }));
    await waitFor(() => expect(stockApi.receive).toHaveBeenCalledWith({
      supplier_id: undefined, reference: undefined, note: undefined,
      items: [{ product_id: 5, quantity: 24, batch_no: undefined, expiry_date: undefined }],
    }));
    expect(toast.success).toHaveBeenCalledWith('Received 24 unit(s).');
  });

  it('turns a line into a new item with its own name and selling price, and sends it as a new product', async () => {
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Not in the catalog? Add it as a new item' }));
    await user.type(screen.getByLabelText('Line 1 new item name'), 'Bucket hat');
    await user.type(screen.getByLabelText('Line 1 selling price (KES)'), '900');
    await user.type(screen.getByLabelText('Line 1 quantity'), '12');
    await user.click(screen.getByRole('button', { name: 'Save shipment' }));
    await waitFor(() => expect(stockApi.receive).toHaveBeenCalled());
    expect(stockApi.receive.mock.calls[0][0].items).toEqual([
      { quantity: 12, batch_no: undefined, expiry_date: undefined, new_product: { name: 'Bucket hat', sell_price: 90000, image_url: undefined } },
    ]);
  });

  it('can switch a line back to an existing item', async () => {
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Not in the catalog? Add it as a new item' }));
    await user.click(screen.getByRole('button', { name: 'Choose an existing item instead' }));
    expect(screen.getByLabelText('Line 1 item')).toBeInTheDocument();
  });

  it('adds and removes lines; the last line cannot be removed', async () => {
    const user = mount();
    await screen.findByRole('heading', { name: 'New delivery' });
    expect(screen.queryByRole('button', { name: /Remove line/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '+ Add another line' }));
    expect(screen.getByLabelText('Line 2 quantity')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove line 1' }));
    expect(screen.queryByLabelText('Line 2 quantity')).toBeNull();
    expect(screen.getByLabelText('Line 1 quantity')).toBeInTheDocument();
  });

  it('still checks the quantity first, and shows the problem as an alert', async () => {
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Save shipment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Line 1: enter how many arrived.');
    expect(stockApi.receive).not.toHaveBeenCalled();
  });

  it('opens "More" by itself when a reopened draft line has a batch or expiry', async () => {
    stockApi.receiptDrafts.mockResolvedValue({ data: { data: [{ id: 4, supplier_name: null, reference: null, line_count: 1, created_by_name: 'Kim', updated_at: '2026-11-06 09:30:00' }] } });
    stockApi.receiptDraft.mockResolvedValue({ data: { data: { id: 4, body: { items: [{ product_id: 5, quantity: 3, batch_no: 'B-7', display: { name: 'Soap bar', sku: 'S-1', sell_price: 120000 } }] } } } });
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    const batch = await screen.findByLabelText('Batch / lot no. (optional)');
    expect(batch).toHaveValue('B-7');
    expect(batch.closest('details')).toHaveAttribute('open');
    expect(screen.getByText('KES 1,200')).toBeInTheDocument(); // the price came back with the draft
  });

  it('"Start a new delivery instead" drops the draft: the next Save draft makes a new one', async () => {
    stockApi.receiptDrafts.mockResolvedValue({ data: { data: [{ id: 4, supplier_name: 'Acme', reference: 'DN-1', line_count: 1, created_by_name: 'Kim', updated_at: '2026-11-06 09:30:00' }] } });
    stockApi.receiptDraft.mockResolvedValue({ data: { data: { id: 4, body: { reference: 'DN-1', items: [{ product_id: 5, quantity: 3, display: { name: 'Soap bar', sku: 'S-1' } }] } } } });
    stockApi.saveReceiptDraft.mockResolvedValue({ data: { data: { id: 9 } } });
    const user = mount();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Start a new delivery instead' }));
    expect(screen.getByRole('heading', { name: 'New delivery' })).toBeInTheDocument();
    expect(screen.getByLabelText('Delivery note number')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(stockApi.saveReceiptDraft).toHaveBeenCalled());
    expect(stockApi.updateReceiptDraft).not.toHaveBeenCalled();
  });
});

describe('Receive, new layout: recent activity and history', () => {
  it('lists the latest shipments with how many units, when and from whom, and any new products waiting', async () => {
    stockApi.receipts.mockResolvedValue({ data: { data: [
      receipt({ id: 2, total_units: 36, items: [{ id: 1, quantity: 36, product_name: 'Tee', product_status: 'pending', is_new_product: 1, sell_price: 120000 }] }),
      receipt({ id: 3, total_units: 1, supplier_name: null, reference: null, received_on: '2026-11-05' }),
    ], total: 2 } });
    mount();
    const aside = await screen.findByRole('complementary', { name: 'Drafts and recent activity' });
    expect(await within(aside).findByText('Received 36 units')).toBeInTheDocument();
    expect(within(aside).getByText(/Acme Ltd · Ref DN-9 · 1 new product waiting for approval/)).toBeInTheDocument();
    expect(within(aside).getByText('Received 1 unit')).toBeInTheDocument();
    expect(within(aside).getByText(/No supplier/)).toBeInTheDocument();
  });

  it('says so when nothing has been received', async () => {
    stockApi.receipts.mockResolvedValue({ data: { data: [], total: 0 } });
    mount();
    expect(await screen.findByText('Nothing has been received yet.')).toBeInTheDocument();
  });

  it('keeps the full shipment table below, with batches and statuses', async () => {
    stockApi.receipts.mockResolvedValue({ data: { data: [receipt({ items: [{ id: 1, quantity: 6, product_name: 'Tee', batch_no: 'B-1', expiry_date: '2027-01-01' }] })], total: 1 } });
    mount();
    expect(await screen.findByRole('heading', { name: 'Past shipments' })).toBeInTheDocument();
    expect(await screen.findByText('batch B-1')).toBeInTheDocument();
  });

  it('at an outlet: no form, the main-store notice, and the history', async () => {
    mount({ isMainStore: false });
    expect(await screen.findByText(/Shipments are received at the main store/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'New delivery' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Past shipments' })).toBeInTheDocument();
  });
});

describe('Receive, the old sheet is gone', () => {
  it('has no "+ Receive shipment" button: the form is on the page', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'New delivery' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Receive shipment' })).toBeNull();
  });
});
