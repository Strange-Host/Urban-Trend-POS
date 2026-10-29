import { useState } from 'react';
import StatCard from '../components/StatCard';
import Panel from '../components/Panel';
import RevenueChart from '../components/RevenueChart';
import useSlidingPill from '../hooks/useSlidingPill';
import { useAuth } from '../context/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { reportsApi } from '../api/endpoints';

const CHANNEL_LABEL = { local: 'Local store', shopify: 'Shopify', woocommerce: 'WooCommerce' };
const CHANNEL_COLOR = { local: 'bg-ink', shopify: 'bg-success', woocommerce: 'bg-accent' };

const money = (cents) => `KES ${Math.round(cents / 100).toLocaleString()}`;
// Same amount with "KES" as a small label, for the big numbers - saves width in narrow cards.
const Money = ({ cents }) => (
  <>
    <span className="text-[0.5em] font-500 text-text-muted mr-1.5 align-middle">KES</span>
    {Math.round(cents / 100).toLocaleString()}
  </>
);

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/* Where the revenue came from: one segmented bar plus a chip per channel. */
function ChannelSplit({ rows }) {
  const totals = {};
  for (const r of rows || []) totals[r.source_type] = (totals[r.source_type] || 0) + r.revenue;
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (sum === 0) return null;
  return (
    <div className="px-5 pb-5">
      <div className="flex gap-1 h-2" role="img" aria-label="Revenue share by channel">
        {entries.map(([ch, v]) => (
          <div key={ch} className={`${CHANNEL_COLOR[ch] || 'bg-ink'} rounded-full`} style={{ flex: `${v} 1 0%`, minWidth: 6 }} />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2 mt-3">
        {entries.map(([ch, v]) => (
          <div key={ch} className="bg-paper rounded-xl px-3 py-2.5">
            <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
              <span className="flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${CHANNEL_COLOR[ch] || 'bg-ink'}`} />
                {CHANNEL_LABEL[ch] || ch}
              </span>
              <span className="font-mono">{((v / sum) * 100).toFixed(0)}%</span>
            </div>
            <div className="font-display font-700 text-base tabular-nums mt-1 whitespace-nowrap">{money(v)}</div>
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
          <th className="px-5 py-2 font-medium">Channel</th>
          <th className="px-5 py-2 font-medium text-right">Transactions</th>
          <th className="px-5 py-2 font-medium text-right">Revenue</th>
          <th className="px-5 py-2 font-medium text-right">Avg. basket</th>
          <th className="px-5 py-2 font-medium text-right">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows?.map((r) => (
          <tr key={`${r.source_type}-${r.income_source_id}`} className="border-t border-line">
            <td className="px-5 py-2.5">
              <span className="font-medium">{r.channel_name}</span>
              {r.platform && <span className="text-xs text-text-muted ml-1.5">({r.platform})</span>}
            </td>
            <td className="px-5 py-2.5 text-right font-mono">{r.transaction_count}</td>
            <td className="px-5 py-2.5 text-right font-mono">{(r.revenue / 100).toFixed(2)}</td>
            <td className="px-5 py-2.5 text-right font-mono">{(r.avg_basket / 100).toFixed(2)}</td>
            <td className="px-5 py-2.5 text-right font-mono text-text-muted">{((r.revenue / totalRevenue) * 100).toFixed(1)}%</td>
          </tr>
        ))}
        {rows?.length === 0 && (
          <tr><td colSpan={5} className="px-5 py-8 text-center text-text-muted">No sales yet.</td></tr>
        )}
      </tbody>
    </table>
    </div>
  );
}

function PaymentMethods({ rows }) {
  const total = (rows || []).reduce((s, r) => s + r.total_amount, 0) || 1;
  return (
    <div className="px-5 pb-5 pt-2 space-y-3">
      {rows?.map((r) => (
        <div key={r.method}>
          <div className="flex justify-between gap-3 text-sm mb-1">
            <span className="capitalize">{r.method.replace('_', ' ')}</span>
            <span className="font-mono text-text-muted whitespace-nowrap">{Math.round(r.total_amount / 100).toLocaleString()} ({r.payment_count})</span>
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
    return <div className="px-5 py-8 text-center text-text-muted text-sm">No sales yet.</div>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-line">
      {channels.map((ch) => (
        <div key={ch} className="px-5 py-4">
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

/* Segmented range picker; the dark pill glides between options. */
function RangeToggle({ value, onChange }) {
  const { rootRef, pillProps } = useSlidingPill('x', value);
  return (
    <div ref={rootRef} role="tablist" aria-label="Date range" className="relative inline-flex gap-0.5 p-1 rounded-xl bg-surface border border-line">
      <span {...pillProps} className="sliding-pill rounded-lg bg-ink" />
      {RANGE_OPTIONS.map((r) => (
        <button
          key={r.key}
          type="button"
          role="tab"
          aria-selected={value === r.key}
          onClick={() => onChange(r.key)}
          className={`relative px-3 py-2 sm:py-1.5 rounded-lg text-xs font-medium transition-colors ${value === r.key ? 'text-white' : 'text-text-muted hover:text-text'}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
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

  const firstName = user?.name?.trim().split(/\s+/)[0];
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const rangeLabel = range === 'all' ? 'All time' : `Last ${range} days`;

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div>
          <div className="inline-flex items-center text-xs text-text-muted font-mono bg-surface border border-line rounded-full px-2.5 py-1 mb-3">{today}</div>
          <h1 className="font-display font-700 text-3xl tracking-tight">{firstName ? `${greeting()}, ${firstName}` : 'Dashboard'}</h1>
          <p className="text-text-muted text-sm mt-1">Across every store and channel — local register plus connected Shopify/WooCommerce sources.</p>
        </div>
        <RangeToggle value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard size="large" label="Revenue" value={summary ? <Money cents={summary.revenue} /> : '—'} sub={summary ? `${summary.transaction_count} transactions` : undefined} />
        <StatCard size="large" label="Local store" value={<Money cents={localRevenue} />} />
        <StatCard size="large" label="Online channels" value={<Money cents={onlineRevenue} />} />
        <StatCard size="large" label="Inventory value" value={inventoryValue ? <Money cents={inventoryValue.total_retail_value} /> : '—'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <Panel className="lg:col-span-2">
          <div className="px-5 pt-5">
            <div className="text-sm text-text-muted">Revenue trend</div>
            <div className="font-display font-700 text-3xl tracking-tight tabular-nums mt-1">{summary ? <Money cents={summary.revenue} /> : '—'}</div>
            <div className="text-xs text-text-muted mt-1">{rangeLabel}, day by day</div>
          </div>
          <RevenueChart rows={trend} labels={CHANNEL_LABEL} colors={CHANNEL_COLOR} />
          <ChannelSplit rows={byChannel} />
        </Panel>
        <Panel title="Payment methods" description="How customers paid.">
          <PaymentMethods rows={paymentMethods} />
        </Panel>
      </div>

      <Panel title="Revenue by channel" className="mb-6">
        <ChannelBreakdown rows={byChannel} />
      </Panel>

      <Panel title="Top products by channel" description="Which products move where.">
        <TopProductsByChannel data={topByChannel} />
      </Panel>
    </div>
  );
}
