import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import StockControl from './StockControl';

const perms = { list: ['stock.receive', 'stock.count', 'stock.transfer'] };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ can: (p) => perms.list.includes(p), user: { role: 'store' } }),
}));
vi.mock('../api/endpoints', () => ({ storesApi: { list: () => Promise.resolve({ data: { data: [] } }) } }));
// The tabs have their own tests; here each is just a marker for "this tab is showing".
vi.mock('./stock/ReceiveTab', () => ({ default: () => <div>Receive tab showing</div> }));
vi.mock('./stock/IssueTab', () => ({ default: () => <div>Issue tab showing</div> }));
vi.mock('./stock/TransfersTab', () => ({ default: () => <div>Transfers tab showing</div> }));
vi.mock('./stock/CountsTab', () => ({ default: () => <div>Counts tab showing</div> }));
vi.mock('./stock/ActivityTab', () => ({ default: () => <div>Activity tab showing</div> }));
vi.mock('./stock/BatchesTab', () => ({ default: () => <div>Batches tab showing</div> }));
vi.mock('./stock/CostingTab', () => ({ default: () => <div>Costing tab showing</div> }));
vi.mock('./stock/ReconcileTab', () => ({ ReconcileTab: () => <div>Reconcile tab showing</div> }));

function renderAt(url) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><StockControl /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { perms.list = ['stock.receive', 'stock.count', 'stock.transfer']; });

describe('Stock control opening tab', () => {
  it('opens on the first tab when there is no ?tab=', () => {
    renderAt('/stock');
    expect(screen.getByText('Receive tab showing')).toBeInTheDocument();
  });

  it('opens on the tab named in ?tab=, as the Start screen links to it', () => {
    renderAt('/stock?tab=counts');
    expect(screen.getByText('Counts tab showing')).toBeInTheDocument();
  });

  it('ignores an unknown tab name', () => {
    renderAt('/stock?tab=nonsense');
    expect(screen.getByText('Receive tab showing')).toBeInTheDocument();
  });

  it('ignores a tab this person may not open', () => {
    perms.list = ['stock.count'];
    renderAt('/stock?tab=receive');
    expect(screen.getByText('Counts tab showing')).toBeInTheDocument();
  });
});
