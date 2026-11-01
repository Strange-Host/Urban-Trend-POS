import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Products from './Products';
import { productsApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  productsApi: { list: vi.fn(), listPending: vi.fn(), setCatalogue: vi.fn(), remove: vi.fn(), create: vi.fn(), update: vi.fn(), approve: vi.fn(), reject: vi.fn() },
  categoriesApi: { list: vi.fn() },
  inventoryApi: { adjust: vi.fn() },
}));

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const dialog = { confirm: vi.fn(), prompt: vi.fn() };
vi.mock('../context/UIContext', () => ({ useToast: () => toast, useDialog: () => dialog }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin' }, can: () => true }) }));

const shopRow = { id: 1, name: 'Wooden Chair', sku: 'CH-1', sell_price: 450000, total_stock: 6, category_name: 'Furniture' };
const linkedShopRow = { id: 2, name: 'Crew Tee', sku: 'TEE-1', sell_price: 150000, total_stock: 12, category_name: 'Clothing', shopify_variant_id: '555' };
const emptyLinkedRow = { id: 3, name: 'Old Cap', sku: 'CAP-1', sell_price: 90000, total_stock: 0, category_name: 'Clothing', shopify_variant_id: '777' };
const onlineRow = { id: 9, name: 'Online Hoodie', sku: 'HOOD-1', sell_price: 320000, total_stock: 0, category_name: 'Clothing', shopify_variant_id: '888' };

// The row action and the sheet's submit button can share a label; the sheet is rendered last.
const sheetButton = (name) => screen.getAllByRole('button', { name }).at(-1);

const page = (rows) => Promise.resolve({ data: { data: rows, page: 1, pageSize: 20, total: rows.length, totalPages: 1 } });
const mount = (props) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Products {...props} /></QueryClientProvider>,
);

beforeEach(async () => {
  vi.clearAllMocks();
  const { categoriesApi } = await import('../api/endpoints');
  categoriesApi.list.mockResolvedValue({ data: { data: [] } });
  productsApi.listPending.mockResolvedValue({ data: { data: [] } });
  productsApi.setCatalogue.mockResolvedValue({ data: { data: {} } });
});

describe('shop catalogue', () => {
  it('asks the server for the shop catalogue and shows stock', async () => {
    productsApi.list.mockImplementation(() => page([shopRow]));
    mount();
    expect(await screen.findByText('Wooden Chair')).toBeInTheDocument();
    expect(productsApi.list).toHaveBeenCalledWith(expect.objectContaining({ catalogue: 'shop' }));
    expect(screen.getByRole('columnheader', { name: 'Stock' })).toBeInTheDocument();
    expect(screen.getByText('Adjust stock')).toBeInTheDocument();
  });

  it('offers "Move to online" only for products that came from an online store', async () => {
    productsApi.list.mockImplementation(() => page([shopRow, linkedShopRow]));
    mount();
    await screen.findByText('Crew Tee');
    expect(screen.getAllByText('Move to online')).toHaveLength(1);
  });

  it('says how many units will be written off, then sends clear_stock', async () => {
    productsApi.list.mockImplementation(() => page([linkedShopRow]));
    mount();
    fireEvent.click(await screen.findByText('Move to online'));
    expect(await screen.findByText(/12/, { selector: 'b' })).toBeInTheDocument();
    fireEvent.click(sheetButton('Write off 12 and move'));
    await waitFor(() => expect(productsApi.setCatalogue).toHaveBeenCalledWith(2, { catalogue: 'online', clear_stock: true }));
    expect(toast.success).toHaveBeenCalled();
  });

  it('moves a product with no stock without a write-off', async () => {
    productsApi.list.mockImplementation(() => page([emptyLinkedRow]));
    mount();
    fireEvent.click(await screen.findByText('Move to online'));
    fireEvent.click(sheetButton('Move to online'));
    await waitFor(() => expect(productsApi.setCatalogue).toHaveBeenCalledWith(3, { catalogue: 'online' }));
  });
});

describe('online catalogue', () => {
  it('asks for the online catalogue and shows no stock column or stock actions', async () => {
    productsApi.list.mockImplementation(() => page([onlineRow]));
    mount({ catalogue: 'online' });
    expect(await screen.findByText('Online Hoodie')).toBeInTheDocument();
    expect(productsApi.list).toHaveBeenCalledWith(expect.objectContaining({ catalogue: 'online' }));
    expect(screen.queryByRole('columnheader', { name: 'Stock' })).toBeNull();
    expect(screen.queryByText('Adjust stock')).toBeNull();
    expect(screen.queryByText('+ Add product')).toBeNull();
    expect(productsApi.listPending).not.toHaveBeenCalled();
  });

  it('adds a product to the shop with the opening stock the person types', async () => {
    productsApi.list.mockImplementation(() => page([onlineRow]));
    mount({ catalogue: 'online' });
    fireEvent.click(await screen.findByText('Add to shop'));
    fireEvent.change(screen.getByLabelText('How many are on the shelf now?'), { target: { value: '8' } });
    fireEvent.click(sheetButton('Add to shop'));
    await waitFor(() => expect(productsApi.setCatalogue).toHaveBeenCalledWith(9, { catalogue: 'shop', opening_stock: 8 }));
  });

  it('adds with no opening stock when the field is left empty', async () => {
    productsApi.list.mockImplementation(() => page([onlineRow]));
    mount({ catalogue: 'online' });
    fireEvent.click(await screen.findByText('Add to shop'));
    fireEvent.click(sheetButton('Add to shop'));
    await waitFor(() => expect(productsApi.setCatalogue).toHaveBeenCalledWith(9, { catalogue: 'shop' }));
  });

  it('shows the server message when the move is refused', async () => {
    productsApi.list.mockImplementation(() => page([onlineRow]));
    productsApi.setCatalogue.mockRejectedValue({ response: { data: { error: { message: 'This product is already in the shop catalogue.' } } } });
    mount({ catalogue: 'online' });
    fireEvent.click(await screen.findByText('Add to shop'));
    fireEvent.click(sheetButton('Add to shop'));
    expect(await screen.findByText(/already in the shop catalogue/)).toBeInTheDocument();
  });

  it('explains how to get products when there are none', async () => {
    productsApi.list.mockImplementation(() => page([]));
    mount({ catalogue: 'online' });
    expect(await screen.findByText(/No online products yet/)).toBeInTheDocument();
  });
});
