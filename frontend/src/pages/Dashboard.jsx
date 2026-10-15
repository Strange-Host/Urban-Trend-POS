import { useState } from 'react';
import StatCard from '../components/StatCard';
import { useQuery } from '@tanstack/react-query';
import { reportsApi } from '../api/endpoints';

const CHANNEL_LABEL = { local: 'Local store', shopify: 'Shopify', woocommerce: 'WooCommerce' };
const CHANNEL_COLOR = { local: 'bg-ink', shopify: 'bg-success', woocommerce: 'bg-accent' };

function Panel({ title, description, children, className = '' }) {
  return (
    <div className={`bg-surface border border-line rounded-xl overflow-hidden ${className}`}>
      <div className="px-4 py-3 border-b border-line">
        <div className="font-medium text-sm">{title}</div>
        {description && <div className="text-xs text-text-muted mt-0.5">{description}</div>}
      </div>
      {children}
    </div>
  );
}

/* Simple dependency-free stacked bar chart — daily revenue split by channel. */
function TrendChart({ rows }) {
  const days = {};
  const channels = new Set();
  for (const r of rows || []) {
    days[r.day] = days[r.day] || {};
    days[r.day][r.source_type] = r.revenue;
    channels.add(r.source_type);
  }
  const dayKeys = Object.keys(days).sort();
  const maxTotal = Math.max(1, ...dayKeys.map((d) => Object.values(days[d]).reduce((a, b) => a + b, 0)));

  if (dayKeys.length === 0) {
    return <div className="px-4 py-12 text-center text-text-muted text-sm">No sales in this period yet.</div>;
  }

  return (
    <div className="p-4">
      <div className="flex items-end gap-1 h-40">
        {dayKeys.map((day) => {
          const dayData = days[day];
          const total = Object.values(dayData).reduce((a, b) => a + b, 0);
          return (
            <div key={day} className="flex-1 flex flex-col justify-end h-full group relative" title={day}>
              <div className="flex flex-col-reverse w-full rounded-sm overflow-hidden" style={{ height: `${(total / maxTotal) * 100}%`, minHeight: total > 0 ? '2px' : 0 }}>
                {Object.entries(dayData).map(([ch, rev]) => (
                  <div
                    key={ch}
                    className={CHANNEL_COLOR[ch] || 'bg-ink'}
                    style={{ height: `${(rev / total) * 100}%` }}
                  />
                ))}
              </div>
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:block bg-ink text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                {day}: {(total / 100).toFixed(0)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-text-muted mt-2 font-mono">
        <span>{dayKeys[0]}</span>
        <span>{dayKeys[dayKeys.length - 1]}</span>
      </div>
      <div className="flex gap-4 mt-3">
        {[...channels].map((ch) => (
          <div key={ch} className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className={`w-2.5 h-2.5 rounded-sm ${CHANNEL_COLOR[ch] || 'bg-ink'}`} />
            {CHANNEL_LABEL[ch] || ch}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChannelBreakdown({ rows }) {
  const totalRevenue = (rows || []).reduce((s, r) => s + r.revenue, 0) || 1;
  return (
    <div className="scroll-x">
    <table className="stack-sm w-full text-sm min-w-[520px]">
      <thead>
        <tr className="text-left text-text-muted">
          <th className="px-4 py-2 font-medium">Channel</th>
          <th className="px-4 py-2 font-medium text-right">Transactions</th>
          <th className="px-4 py-2 font-medium text-right">Revenue</th>
          <th className="px-4 py-2 font-medium text-right">Avg. basket</th>
          <th className="px-4 py-2 font-medium text-right">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows?.map((r) => (
          <tr key={`${r.source_type}-${r.income_source_id}`} className="border-t border-line">
            <td className="px-4 py-2.5">
              <span className="font-medium">{r.channel_name}</span>
              {r.platform && <span className="text-xs text-text-muted ml-1.5">({r.platform})</span>}
            </td>
            <td className="px-4 py-2.5 text-right font-mono">{r.transaction_count}</td>
            <td className="px-4 py-2.5 text-right font-mono">{(r.revenue / 100).toFixed(2)}</td>
            <td className="px-4 py-2.5 text-right font-mono">{(r.avg_basket / 100).toFixed(2)}</td>
            <td className="px-4 py-2.5 text-right font-mono text-text-muted">{((r.revenue / totalRevenue) * 100).toFixed(1)}%</td>
          </tr>
        ))}
        {rows?.length === 0 && (
          <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No sales yet.</td></tr>
        )}
      </tbody>
    </table>
    </div>
  );
}

function PaymentMethods({ rows }) {
  const total = (rows || []).reduce((s, r) => s + r.total_amount, 0) || 1;
  return (
    <div className="p-4 space-y-3">
      {rows?.map((r) => (
        <div key={r.method}>
          <div className="flex justify-between text-sm mb-1">
            <span className="capitalize">{r.method.replace('_', ' ')}</span>
            <span className="font-mono text-text-muted">{(r.total_amount / 100).toFixed(2)} ({r.payment_count})</span>
          </div>
          <div className="h-1.5 bg-line rounded-full overflow-hidden">
            <div className="h-full bg-accent" style={{ width: `${(r.total_amount / total) * 100}%` }} />
          </div>
        </div>
      ))}
      {rows?.length === 0 && <div className="text-text-muted text-sm text-center py-4">No payments yet.</div>}
    </div>
  );
}

function TopProductsByChannel({ data }) {
  const channels = Object.keys(data || {});
  if (channels.length === 0) {
    return <div className="px-4 py-8 text-center text-text-muted text-sm">No sales yet.</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-line">
      {channels.map((ch) => (
        <div key={ch} className="p-4">
          <div className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wide">{CHANNEL_LABEL[ch] || ch}</div>
          <div className="space-y-2">
            {data[ch].map((p) => (
              <div key={p.id} className="flex justify-between text-sm">
                <span className="truncate pr-2">{p.name}</span>
                <span className="font-mono text-text-muted whitespace-nowrap">{p.units_sold}× · {(p.revenue / 100).toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const RANGE_OPTIONS = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
  { key: 'all', label: 'All time' },
];

export default function Dashboard() {
  const [range, setRange] = useState('30');
  const from = range === 'all' ? '1970-01-01' : new Date(Date.now() - Number(range) * 86400000).toISOString();
  const params = { from };

  const { data: summary } = useQuery({ queryKey: ['reports', 'summary', range], queryFn: () => reportsApi.salesSummary(params).then((r) => r.data.data) });
  const { data: inventoryValue } = useQuery({ queryKey: ['reports', 'inventory-value'], queryFn: () => reportsApi.inventoryValue().then((r) => r.data.data) });
  const { data: byChannel } = useQuery({ queryKey: ['reports', 'by-channel', range], queryFn: () => reportsApi.salesByChannel(params).then((r) => r.data.data) });
  const { data: trend } = useQuery({ queryKey: ['reports', 'trend', range], queryFn: () => reportsApi.salesTrend({ from: range === 'all' ? undefined : from.slice(0, 10) }).then((r) => r.data.data) });
  const { data: paymentMethods } = useQuery({ queryKey: ['reports', 'payments', range], queryFn: () => reportsApi.paymentMethods(params).then((r) => r.data.data) });
  const { data: topByChannel } = useQuery({ queryKey: ['reports', 'top-by-channel', range], queryFn: () => reportsApi.topProductsByChannel({ ...params, limit: 6 }).then((r) => r.data.data) });

  const onlineRevenue = (byChannel || []).filter((c) => c.source_type !== 'local').reduce((s, c) => s + c.revenue, 0);
  const localRevenue = (byChannel || []).filter((c) => c.source_type === 'local').reduce((s, c) => s + c.revenue, 0);

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
        <h1 className="font-display font-700 text-2xl">Dashboard</h1>
        <div className="flex gap-1.5">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${range === r.key ? 'bg-ink text-white border-ink' : 'border-line text-text-muted hover:border-text-muted'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-text-muted text-sm mb-6">Across every store and channel — local register plus connected Shopify/WooCommerce sources.</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard size="large" label="Revenue" value={summary ? `KES ${(summary.revenue / 100).toFixed(0)}` : '—'} sub={summary ? `${summary.transaction_count} transactions` : undefined} />
        <StatCard size="large" label="Local store" value={`KES ${(localRevenue / 100).toFixed(0)}`} />
        <StatCard size="large" label="Online channels" value={`KES ${(onlineRevenue / 100).toFixed(0)}`} />
        <StatCard size="large" label="Inventory value" value={inventoryValue ? `KES ${(inventoryValue.total_retail_value / 100).toFixed(0)}` : '—'} />
      </div>

      <Panel title="Revenue trend" description="Daily revenue, split by channel." className="mb-6">
        <TrendChart rows={trend} />
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <Panel title="Revenue by channel" className="lg:col-span-2">
          <ChannelBreakdown rows={byChannel} />
        </Panel>
        <Panel title="Payment methods">
          <PaymentMethods rows={paymentMethods} />
        </Panel>
      </div>

      <Panel title="Top products by channel" description="Which products move where.">
        <TopProductsByChannel data={topByChannel} />
      </Panel>
    </div>
  );
}
