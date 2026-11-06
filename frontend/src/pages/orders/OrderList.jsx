import { StatusPill } from '../../components/DataUI';
import { LoadingBlock } from '../../components/Skeleton';
import ChannelBadge from './ChannelBadge';
import { CHANNELS, STATUS_LABELS, STATUS_TONES, money } from './helpers';

/** The table of orders (loading, empty and filtered-empty messages included). Picking a row calls onSelect(id). */
export default function OrderList({ orders, isLoading, statusFilter, search, channel, selectedId, onSelect, modules }) {
  return (
      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        {isLoading && <LoadingBlock />}
        {!isLoading && orders.length === 0 && (
          <div className="p-10 text-center text-text-muted text-sm">
            {statusFilter || search || channel !== 'all'
              ? `No ${channel === 'all' ? '' : `${CHANNELS.find((c) => c.key === channel).label} `}orders match these filters.${channel === 'shopify' || channel === 'woocommerce' ? ' Use “Pull online orders” to bring in orders that still need shipping.' : ''}`
              : 'No orders yet. Orders from your Shopify / WooCommerce store do not arrive by themselves - use “Pull online orders” above (they also show under Sales history once synced).'}
          </div>
        )}
        {orders.length > 0 && (
          <table className="stack-sm w-full text-sm">
            <thead>
              <tr className="border-b border-line">
                {['Code', 'Customer', 'Status', 'Total', 'Due'].map((h, i) => (
                  <th key={h} className={`font-mono text-[11px] uppercase tracking-wider text-text-muted font-500 px-4 py-2.5 ${i >= 3 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {orders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => onSelect(o.id)}
                  className={`cursor-pointer hover:bg-paper ${selectedId === o.id ? 'bg-accent/10' : ''}`}
                >
                  <td className="px-4 py-2.5 font-mono text-xs">{o.product_code}<ChannelBadge order={o} /></td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{o.customer_name}</div>
                    <div className="text-xs text-text-muted font-mono">
                      {o.customer_phone}
                      {modules.control && o.customer_risk_flag === 'high' && <span className="text-danger"> · prepay only</span>}
                      {modules.control && o.customer_risk_flag === 'watch' && <span className="text-danger"> · watch</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill tone={STATUS_TONES[o.status]}>{STATUS_LABELS[o.status]}</StatusPill>
                    {modules.control && o.dispute_status === 'open' && (
                      <span className="ml-1"><StatusPill tone="danger">dispute</StatusPill></span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono">{money(o.total)}</td>
                  <td className="px-4 py-2.5 text-right font-mono">
                    {o.total - o.amount_paid > 0
                      ? <span className="text-danger">{money(o.total - o.amount_paid)}</span>
                      : <span className="text-text-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
  );
}
