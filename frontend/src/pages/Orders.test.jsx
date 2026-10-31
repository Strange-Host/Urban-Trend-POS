import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Orders from './Orders';
import { ordersApi } from '../api/endpoints';

vi.mock('../api/endpoints', () => ({
  ordersApi: { list: vi.fn(), get: vi.fn(), pendingOwnerDecision: vi.fn(), integrity: vi.fn(), ownerDecision: vi.fn(), shopCash: vi.fn() },
  couriersApi: { list: vi.fn(() => Promise.resolve({ data: { data: [] } })) },
}));
let role = 'cashier';
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasRole: (...r) => r.includes(role) }) }));
vi.mock('../context/UIContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
  useDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }),
}));
vi.mock('../hooks/useModules', () => ({ default: () => ({ control: false }) }));
vi.mock('../components/PullOnlineOrders', () => ({ default: () => null }));
vi.mock('../components/PrintReceipt', () => ({ default: () => null }));
vi.mock('../components/InvoiceButton', () => ({ default: () => null }));
vi.mock('../components/PrintWaybill', () => ({ default: () => null }));
vi.mock('../components/AddItemsSheet', () => ({ default: () => null }));
vi.mock('../components/CustomerOrderHistory', () => ({ default: () => null }));

const ok = (data, extra = {}) => Promise.resolve({ data: { data, ...extra } });
const row = { id: 1, product_code: 'UT-1', customer_name: 'Wanjiru', customer_phone: '0712', status: 'dispatched_unpaid', total: 100000, amount_paid: 0 };
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Orders /></QueryClientProvider>);

beforeEach(() => {
  Object.values(ordersApi).forEach((f) => f.mockReset());
  ordersApi.list.mockReturnValue(ok([row], { total: 1 }));
  ordersApi.get.mockImplementation(() => ok({ ...row, customer: { name: 'Wanjiru', phone: '0712' }, items: [] }));
  ordersApi.pendingOwnerDecision.mockReturnValue(ok([], { total: 3 }));
  ordersApi.integrity.mockReturnValue(ok([]));
});

describe('Orders admin views', () => {
  it('hides the admin views from a cashier and never calls the admin endpoints', async () => {
    role = 'cashier';
    mount();
    expect(await screen.findByText('Wanjiru')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Needs decision/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Integrity' })).not.toBeInTheDocument();
    expect(ordersApi.pendingOwnerDecision).not.toHaveBeenCalled();
  });

  it('shows a manager the views, with the waiting count on the decision tab', async () => {
    role = 'manager';
    mount();
    expect(await screen.findByRole('tab', { name: 'Needs decision (3)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Integrity' }));
    expect(await screen.findByText(/Every order adds up/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'All orders' }));
    expect(await screen.findByText('Wanjiru')).toBeInTheDocument();
  });

  it('offers shop cash on an unpaid dispatched order, for any role', async () => {
    role = 'cashier';
    mount();
    fireEvent.click(await screen.findByText('Wanjiru'));
    expect(await screen.findByRole('button', { name: 'Record shop cash' })).toBeInTheDocument();
  });

  it('does not offer shop cash on an order that cannot take a payment', async () => {
    role = 'cashier';
    ordersApi.list.mockReturnValue(ok([{ ...row, status: 'awaiting_dispatch' }], { total: 1 }));
    ordersApi.get.mockImplementation(() => ok({ ...row, status: 'awaiting_dispatch', customer: { name: 'Wanjiru' }, items: [] }));
    mount();
    fireEvent.click(await screen.findByText('Wanjiru'));
    await screen.findByText('Dispatch — deducts stock');
    expect(screen.queryByRole('button', { name: 'Record shop cash' })).not.toBeInTheDocument();
  });
});
