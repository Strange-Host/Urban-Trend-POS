import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { salesApi } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import PrintReceiptButton from '../components/PrintReceipt';
import InvoiceButton from '../components/InvoiceButton';
import TabBar from '../components/TabBar';
import { useDialog } from '../context/UIContext';
import Pager, { usePager } from '../components/Pager';

const CHANNELS = [
  { key: 'all', label: 'All channels' },
  { key: 'local', label: 'Local store' },
  { key: 'shopify', label: 'Shopify' },
  { key: 'woocommerce', label: 'WooCommerce' },
];

const CHANNEL_STYLE = {
  local: { label: 'Local store', cls: 'bg-line text-text-muted' },
  shopify: { label: 'Shopify', cls: 'bg-success-soft text-success' },
  woocommerce: { label: 'WooCommerce', cls: 'bg-accent/20 text-accent-ink' },
};

function ChannelBadge({ sale }) {
  const style = CHANNEL_STYLE[sale.source_type] || CHANNEL_STYLE.local;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${style.cls}`}>
      {style.label}
      {sale.income_source_name ? ` · ${sale.income_source_name}` : ''}
    </span>
  );
}

export default function SalesHistory() {
  const dialog = useDialog();
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState('all');

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['sales', channel, { page: pager.page, size: pager.pageSize }],
    queryFn: () =>
      salesApi
        .list({ ...pager.params, ...(channel !== 'all' ? { source_type: channel } : {}) })
        .then((r) => r.data),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,            // live-synced online sales appear without a reload
  });

  async function handleVoid(id) {
    if (!(await dialog.confirm({ message: 'Void this sale? Stock will be restored.', danger: true }))) return;
    await salesApi.void(id);
    queryClient.invalidateQueries({ queryKey: ['sales'] });
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
        <h1 className="font-display font-700 text-2xl">Sales history</h1>
      </div>
      <p className="text-text-muted text-sm mb-4">
        {data?.total ?? '—'} transactions across every store and channel — local register plus any connected Shopify or WooCommerce sources.
      </p>

      <TabBar tabs={CHANNELS} active={channel} onChange={(k) => { setChannel(k); pager.reset(); }} variant="filter" className="mb-6" />

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="scroll-x">
        <table className="stack-sm w-full text-sm min-w-[720px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">#</th>
              <th className="px-4 py-3 font-medium">Channel</th>
              <th className="px-4 py-3 font-medium">Store</th>
              <th className="px-4 py-3 font-medium">Cashier</th>
              <th className="px-4 py-3 font-medium">Payment</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Total</th>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={9} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {data?.data.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-mono">
                  {s.external_order_number || `#${s.id}`}
                </td>
                <td className="px-4 py-3"><ChannelBadge sale={s} /></td>
                <td className="px-4 py-3 text-text-muted">{s.store_name || '—'}</td>
                <td className="px-4 py-3">{s.cashier_name}</td>
                <td className="px-4 py-3 capitalize text-text-muted">{s.payment_method.replace('_', ' ')}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    s.status === 'completed' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
                  }`}>
                    {s.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono">{(s.total / 100).toFixed(2)}</td>
                <td className="px-4 py-3 text-text-muted text-xs">{new Date(s.created_at).toLocaleString()}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {s.source_type === 'local' && (
                    <>
                      <PrintReceiptButton kind="sale" id={s.id} label="Print" className="text-xs text-text-muted hover:text-text mr-3 disabled:opacity-50" />
                      <InvoiceButton kind="sale" id={s.id} className="text-xs text-text-muted hover:text-text mr-3 disabled:opacity-50" />
                    </>
                  )}
                  {hasRole('admin', 'manager') && s.status === 'completed' && s.source_type === 'local' && (
                    <button onClick={() => handleVoid(s.id)} className="text-xs text-danger hover:opacity-70">Void</button>
                  )}
                </td>
              </tr>
            ))}
            {data?.data.length === 0 && !isLoading && (
              <tr><td colSpan={9} className="px-4 py-12 text-center text-text-muted">No transactions for this channel yet.</td></tr>
            )}
          </tbody>
        </table>
        </div>

      <Pager pager={pager} data={data} noun="sales" />
      </div>
    </div>
  );
}
