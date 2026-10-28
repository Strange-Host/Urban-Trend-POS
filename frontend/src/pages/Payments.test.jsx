import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Payments from './Payments';
import { paymentsApi } from '../api/endpoints';

vi.mock('../api/newServer', async (orig) => ({ ...(await orig()), USE_NEW_SERVER: true }));
vi.mock('../api/endpoints', () => ({ paymentsApi: { list: vi.fn(), summary: vi.fn(), create: vi.fn(), refund: vi.fn() } }));
vi.mock('../context/UIContext', () => ({ useDialog: () => ({ confirm: vi.fn(), prompt: vi.fn() }), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const row = { id: 1, created_at: '2026-10-27T09:00:00Z', direction: 'incoming', sale_id: null, order_ref: 'UT-7K49M2XQ', receipt_no: 'RC-2026-000001', supplier_name: null, method: 'mobile_money', amount: 200_000, status: 'completed' };

beforeEach(() => {
  paymentsApi.list.mockResolvedValue({ data: { data: [row], page: 1, pageSize: 25, total: 1, totalPages: 1 } });
  paymentsApi.summary.mockResolvedValue({ data: { data: { by_method: [{ direction: 'incoming', method: 'mobile_money', total: 200_000 }] } } });
});

describe('the Payments tab on the new server', () => {
  it('shows each receipt with its order, and offers no way to record or refund a payment here', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><Payments /></QueryClientProvider>);
    expect(await screen.findByText('UT-7K49M2XQ · RC-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('mobile money')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record payment/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
    expect(screen.getByText(/refunded from Payment reconciliation/)).toBeInTheDocument();
  });
});
