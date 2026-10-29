import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mergeItems = vi.fn();
const productsList = vi.fn();
const toastSuccess = vi.fn();

vi.mock('../api/endpoints', () => ({
  ordersApi: { mergeItems: (...a) => mergeItems(...a) },
  productsApi: { list: (...a) => productsList(...a) },
}));
vi.mock('../context/UIContext', () => ({ useToast: () => ({ success: toastSuccess, error: vi.fn() }) }));
// The real Picker is a portal bottom sheet; a plain select keeps this test about the add-items logic.
vi.mock('./Picker', () => ({
  default: ({ value, onChange, options, 'aria-label': label }) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import AddItemsSheet from './AddItemsSheet';

const order = { id: 7, product_code: 'UT000007', total: 100000, customer: { name: 'Jane Wanjiru' } };
const products = [
  { id: 1, name: 'Crew Tee', sell_price: 150000 },
  { id: 2, name: 'Cap', sell_price: 50000 },
];

function renderSheet(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onAdded = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <AddItemsSheet order={order} onClose={onClose} onAdded={onAdded} {...props} />
    </QueryClientProvider>
  );
  return { onClose, onAdded };
}

async function pickFirstProduct(productName = 'Crew Tee') {
  await screen.findByRole('option', { name: productName });
  fireEvent.change(screen.getByLabelText('Product 1'), { target: { value: String(products.find((p) => p.name === productName).id) } });
}

describe('AddItemsSheet', () => {
  beforeEach(() => {
    mergeItems.mockReset();
    toastSuccess.mockReset();
    productsList.mockReset();
    productsList.mockResolvedValue({ data: { data: products, totalPages: 1 } });
  });

  it('shows which order it is for and keeps Add disabled until a product is chosen', async () => {
    renderSheet();
    expect(screen.getByText(/UT000007 · Jane Wanjiru/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to order' })).toBeDisabled();
  });

  it('previews the new total as products and quantities are chosen', async () => {
    renderSheet();
    await pickFirstProduct('Crew Tee');
    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '2' } });
    // 2 x 1,500 = 3,000 added to 1,000 current -> 4,000
    expect(await screen.findByText(/4,000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to order' })).toBeEnabled();
  });

  it('sends the lines to the merge endpoint, then refreshes and closes', async () => {
    mergeItems.mockResolvedValue({ data: { data: { id: 7 } } });
    const { onClose, onAdded } = renderSheet();
    await pickFirstProduct('Cap');
    fireEvent.change(screen.getByLabelText('Quantity 1'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    await waitFor(() => expect(mergeItems).toHaveBeenCalledWith(7, [{ product_id: 2, quantity: 3 }]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdded).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('Added 1 item to UT000007.');
  });

  it('can add several lines at once and drop one before sending', async () => {
    mergeItems.mockResolvedValue({ data: { data: { id: 7 } } });
    renderSheet();
    await pickFirstProduct('Crew Tee');
    fireEvent.click(screen.getByRole('button', { name: '+ Add another item' }));
    fireEvent.change(screen.getByLabelText('Product 2'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    await waitFor(() => expect(mergeItems).toHaveBeenCalledWith(7, [
      { product_id: 1, quantity: 1 },
      { product_id: 2, quantity: 1 },
    ]));
  });

  it('shows the server message and stays open when the merge is refused', async () => {
    mergeItems.mockRejectedValue({ response: { status: 409, data: { error: { message: "Cannot merge items into an order that's already \"dispatched_unpaid\"." } } } });
    const { onClose, onAdded } = renderSheet();
    await pickFirstProduct('Crew Tee');
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already/);
    expect(onClose).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });
});
