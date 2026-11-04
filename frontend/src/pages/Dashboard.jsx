import { useState } from 'react';
import StatCard from '../components/StatCard';
import Panel from '../components/Panel';
import RevenueChart from '../components/RevenueChart';
import useSlidingPill from '../hooks/useSlidingPill';
import { useAuth } from '../context/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { reportsApi, stockApi } from '../api/endpoints';
import EmptyState, { EmptyRow } from '../components/EmptyState';
import { SkeletonCards } from '../components/Skeleton';
import { CircleCheck } from 'lucide-react';
import { dailySeries, pctChange } from '../utils/trends';

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
          <EmptyRow colSpan={5}>No sales yet.</EmptyRow>
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
      {rows?.length === 0 && <EmptyState className="py-4">No payments yet.</EmptyState>}
    </div>
  );
}

function TopProductsByChannel({ data }) {
  const channels = Object.keys(data || {});
  if (channels.length === 0) {
    return <EmptyState className="px-5 py-8">No sales yet.</EmptyState>;
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

/* How loud each kind of alert is: red for things that must come off the shelf, orange for a warning, amber for
   "needs doing soon". Quiet checks never get a tile of their own (see AttentionSection). */
const TONES = {
  danger: { border: 'border-danger', count: 'text-danger', rank: 0 },
  warning: { border: 'border-warning', count: 'text-warning', rank: 1 },
  accent: { border: 'border-accent', count: 'text-accent-text', rank: 2 },
};

function AlertTile({ to, label, count, detail, tone }) {
  const t = TONES[tone] || TONES.accent;
  return (
    <Link to={to} className={`@container block rounded-xl border bg-surface p-4 sm:p-5 transition-colors hover:border-text ${t.border}`}>
      <div className="text-sm text-text-muted mb-2">{label}</div>
      <div className={`font-display font-700 tracking-tight tabular-nums text-3xl ${t.count}`}>{count}</div>
      <div className="text-xs text-text-muted mt-1.5">{detail}</div>
    </Link>
  );
}

/* "Needs attention": only the checks that found something get a tile, worst first. Everything that is fine is
   folded into one quiet line, so a healthy shop shows one calm card instead of six rows of zeros. */
function AttentionSection({ alerts }) {
  const hot = alerts.filter((a) => a.count > 0).sort((a, b) => (TONES[a.tone]?.rank ?? 9) - (TONES[b.tone]?.rank ?? 9));
  const quiet = alerts.filter((a) => !a.count);
  if (alerts.length === 0) return null;
  const quietNames = quiet.map((a) => a.label).join(', ');
  return (
    <section aria-label="Needs attention" className="mb-6">
      {hot.length > 0 ? (
        <>
          <h2 className="font-display font-700 text-sm mb-3 flex items-center gap-2">
            Needs attention
            <span className="font-mono text-[11px] bg-accent/20 text-accent-text rounded-full px-2 py-0.5">{hot.length}</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {hot.map(({ id, ...tile }) => <AlertTile key={id} {...tile} />)}
          </div>
          {quiet.length > 0 && (
            <p className="flex items-start gap-2 text-xs text-text-muted mt-3">
              <CircleCheck size={14} className="text-success shrink-0 mt-px" aria-hidden="true" />
              <span>All clear: {quietNames}.</span>
            </p>
          )}
        </>
      ) : (
        <div className="bg-surface border border-line rounded-xl p-4 sm:p-5 flex items-start gap-3">
          <CircleCheck size={20} className="text-success shrink-0" aria-hidden="true" />
          <div>
            <div className="font-display font-700">All clear</div>
            <p className="text-sm text-text-muted mt-0.5">Nothing needs attention right now. Checked: {quietNames}.</p>
          </div>
        </div>
      )}
    </section>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [range, setRange] = useState('30');
  const from = range === 'all' ? '1970-01-01' : new Date(Date.now() - Number(range) * 86400000).toISOString();
  const params = { from };
  // The period just before this one, same length, for "vs previous" arrows. Not available for All time.
  const prevFrom = range === 'all' ? null : new Date(Date.now() - 2 * Number(range) * 86400000).toISOString();
  const prevParams = prevFrom ? { from: prevFrom, to: from } : null;

  const { data: summary } = useQuery({ queryKey: ['reports', 'summary', range], queryFn: () => reportsApi.salesSummary(params).then((r) => r.data.data) });
  const { data: inventoryValue } = useQuery({ queryKey: ['reports', 'inventory-value'], queryFn: () => reportsApi.inventoryValue().then((r) => r.data.data) });
  // Stock alerts: low stock, expiring / expired / recalled batches, damaged stock. Quiet if the caller may not see stock.
  const { data: stockAlerts, isLoading: stockAlertsLoading } = useQuery({ queryKey: ['stock', 'alerts'], queryFn: () => stockApi.alerts().then((r) => r.data.data), retry: false, staleTime: 60000 });
  const { data: prevSummary } = useQuery({ queryKey: ['reports', 'summary', 'prev', range], queryFn: () => reportsApi.salesSummary(prevParams).then((r) => r.data.data), enabled: !!prevParams });
  const { data: prevByChannel } = useQuery({ queryKey: ['reports', 'by-channel', 'prev', range], queryFn: () => reportsApi.salesByChannel(prevParams).then((r) => r.data.data), enabled: !!prevParams });
  const { data: byChannel } = useQuery({ queryKey: ['reports', 'by-channel', range], queryFn: () => reportsApi.salesByChannel(params).then((r) => r.data.data) });
  const { data: trend } = useQuery({ queryKey: ['reports', 'trend', range], queryFn: () => reportsApi.salesTrend({ from: range === 'all' ? undefined : from.slice(0, 10) }).then((r) => r.data.data) });
  const { data: paymentMethods } = useQuery({ queryKey: ['reports', 'payments', range], queryFn: () => reportsApi.paymentMethods(params).then((r) => r.data.data) });
  const { data: topByChannel } = useQuery({ queryKey: ['reports', 'top-by-channel', range], queryFn: () => reportsApi.topProductsByChannel({ ...params, limit: 6 }).then((r) => r.data.data) });

  const { data: overview, isLoading: overviewLoading } = useQuery({ queryKey: ['reports', 'dashboard-overview'], queryFn: () => reportsApi.dashboardOverview().then((r) => r.data.data) });
  const unpaidParcels = (overview?.unpaidParcelsByCourier || []).reduce((s, c) => s + c.parcel_count, 0);
  const capitalTiedUp = (overview?.unpaidParcelsByCourier || []).reduce((s, c) => s + c.capital_tied_up, 0);

  const onlineRevenue = (byChannel || []).filter((c) => c.source_type !== 'local').reduce((s, c) => s + c.revenue, 0);
  const localRevenue = (byChannel || []).filter((c) => c.source_type === 'local').reduce((s, c) => s + c.revenue, 0);

  const prevLocal = (prevByChannel || []).filter((c) => c.source_type === 'local').reduce((s, c) => s + c.revenue, 0);
  const prevOnline = (prevByChannel || []).filter((c) => c.source_type !== 'local').reduce((s, c) => s + c.revenue, 0);
  const vsLabel = `vs previous ${range} days`;
  const deltaOf = (cur, prev) => (prevParams && prevByChannel ? { pct: pctChange(cur, prev), label: vsLabel } : undefined);
  const sparkAll = dailySeries(trend);
  const sparkLocal = dailySeries(trend, (r) => r.source_type === 'local');
  const sparkOnline = dailySeries(trend, (r) => r.source_type !== 'local');

  // The checks this person is allowed to see (each source is quiet for roles without stock access).
  const alerts = [
    overview && { id: 'low', to: '/stock', label: 'Low stock', count: overview.lowStockCount, tone: 'accent', detail: 'Products at or below their reorder level' },
    overview && { id: 'parcels', to: '/money-at-risk', label: 'Unpaid parcels', count: unpaidParcels, tone: 'accent', detail: `${money(capitalTiedUp)} still owed on dispatched parcels` },
    stockAlerts && { id: 'expiring', to: '/stock', label: 'Expiring soon', count: stockAlerts.counts.expiring, tone: 'warning', detail: `Batches expiring within ${stockAlerts.expiry_alert_days} days` },
    stockAlerts && { id: 'expired', to: '/stock', label: 'Expired in stock', count: stockAlerts.counts.expired, tone: 'danger', detail: 'Expired batches still on a shelf' },
    stockAlerts && { id: 'recalled', to: '/stock', label: 'Recalled batches', count: stockAlerts.counts.recalled, tone: 'danger', detail: 'Batches recalled and taken off sale' },
    stockAlerts && {
      id: 'damaged', to: '/stock', label: 'Damaged stock (30 days)', tone: 'warning',
      count: stockAlerts.counts.damaged_units_30d + stockAlerts.counts.damaged_returns_awaiting_decision,
      detail: `${stockAlerts.counts.damaged_units_30d} unit(s) written off, ${stockAlerts.counts.damaged_returns_awaiting_decision} damaged return(s) awaiting a decision`,
    },
  ].filter(Boolean);

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

      {overviewLoading || stockAlertsLoading
        ? <SkeletonCards count={3} className="md:grid-cols-3 mb-6" />
        : <AttentionSection alerts={alerts} />}

      {!summary ? (
        <SkeletonCards count={4} className="mb-6" />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard size="large" label="Revenue" value={<Money cents={summary.revenue} />} sub={`${summary.transaction_count} transactions`}
            delta={prevParams && prevSummary ? { pct: pctChange(summary.revenue, prevSummary.revenue), label: vsLabel } : undefined} spark={sparkAll} />
          <StatCard size="large" label="Local store" value={<Money cents={localRevenue} />} delta={deltaOf(localRevenue, prevLocal)} spark={sparkLocal} />
          <StatCard size="large" label="Online channels" value={<Money cents={onlineRevenue} />} delta={deltaOf(onlineRevenue, prevOnline)} spark={sparkOnline} />
          <StatCard size="large" label="Inventory value" value={inventoryValue ? <Money cents={inventoryValue.total_retail_value} /> : '—'} />
        </div>
      )}

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
