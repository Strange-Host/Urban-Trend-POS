import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reportsApi } from '../api/endpoints';
import { downloadFile, getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/UIContext';
import StatCard from '../components/StatCard';
import TabBar from '../components/TabBar';
import Panel from '../components/Panel';
import { inputCls } from '../components/SettingsUI';

// Profit & loss and the Priority 5 reports. Every tab reads the same endpoint its Excel/PDF export is built
// from, so a downloaded sheet always matches what is on screen. Money arrives in cents.

const TABS = [
  { key: 'pnl', label: 'Profit & loss' },
  { key: 'discounts', label: 'Discounts' },
  { key: 'vat', label: 'VAT' },
  { key: 'branches', label: 'Branches' },
  { key: 'agents', label: 'Sales agents' },
];

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const kes = (cents) => (cents == null ? '—' : (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? '—' : `${v}%`);
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-KE'));

const FORMAT = { money: kes, percent: pct, int: num, text: (v) => v ?? '—' };

function Table({ columns, rows, totals, empty = 'No data for this period.' }) {
  if (!rows.length) return <div className="px-5 pb-5 text-sm text-text-muted">{empty}</div>;
  const cell = (c, row) => FORMAT[c.type || 'text'](row[c.key]);
  return (
    <div className="scroll-x">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th key={c.key} className={`font-mono text-[11px] uppercase tracking-wider text-text-muted px-4 py-2.5 whitespace-nowrap ${c.type && c.type !== 'text' ? 'text-right' : 'text-left'}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {columns.map((c) => <td key={c.key} className={`px-4 py-2.5 whitespace-nowrap ${c.type && c.type !== 'text' ? 'text-right tabular-nums' : ''}`}>{cell(c, row)}</td>)}
            </tr>
          ))}
          {totals && (
            <tr className="bg-paper font-semibold">
              {columns.map((c) => <td key={c.key} className={`px-4 py-2.5 whitespace-nowrap ${c.type && c.type !== 'text' ? 'text-right tabular-nums' : ''}`}>{totals[c.key] === undefined ? '' : cell(c, totals)}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const T = (key, header) => ({ key, header });
const M = (key, header) => ({ key, header, type: 'money' });
const I = (key, header) => ({ key, header, type: 'int' });
const P = (key, header) => ({ key, header, type: 'percent' });

function ForecastEditor({ months, onSaved }) {
  const toast = useToast();
  const [month, setMonth] = useState(months[months.length - 1]?.month || '');
  const [target, setTarget] = useState('');
  const [budget, setBudget] = useState('');
  const [saving, setSaving] = useState(false);
  const row = months.find((m) => m.month === month);
  const toCents = (v) => Math.round(parseFloat(String(v).replace(/,/g, '')) * 100);

  async function save() {
    const revenue_target = toCents(target); const expense_budget = toCents(budget);
    if (!month || !Number.isFinite(revenue_target) || !Number.isFinite(expense_budget) || revenue_target < 0 || expense_budget < 0) {
      toast.error('Enter the target and budget as amounts in KES.');
      return;
    }
    setSaving(true);
    try {
      await reportsApi.setForecast(month, { revenue_target, expense_budget });
      toast.success(`Forecast for ${month} saved.`);
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
      <label className="block text-xs font-medium text-text-muted">Month
        <select className={`${inputCls} mt-1`} value={month} onChange={(e) => { setMonth(e.target.value); setTarget(''); setBudget(''); }}>
          {months.map((m) => <option key={m.month} value={m.month}>{m.month}</option>)}
        </select>
      </label>
      <label className="block text-xs font-medium text-text-muted">Revenue target (KES)
        <input className={`${inputCls} mt-1`} inputMode="decimal" value={target} placeholder={row?.revenue_target != null ? String(row.revenue_target / 100) : ''} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <label className="block text-xs font-medium text-text-muted">Expense budget (KES)
        <input className={`${inputCls} mt-1`} inputMode="decimal" value={budget} placeholder={row?.expense_budget != null ? String(row.expense_budget / 100) : ''} onChange={(e) => setBudget(e.target.value)} />
      </label>
      <button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{saving ? 'Saving…' : 'Save forecast'}</button>
    </div>
  );
}

function PnlTab({ params }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['reports', 'pnl', params], queryFn: () => reportsApi.pnl(params).then((r) => r.data.data) });
  if (isLoading) return <div className="text-sm text-text-muted">Loading…</div>;
  if (error) return <div className="text-sm text-danger">{getErrorMessage(error)}</div>;
  const { summary: s, byCategory, byBranch, forecast } = data;
  const line = (label, amount) => ({ label, amount });
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Revenue" value={`KES ${kes(s.revenue)}`} />
        <StatCard label="Gross margin" value={`KES ${kes(s.grossMargin)}`} />
        <StatCard label="Net profit" value={`KES ${kes(s.netProfit)}`} />
        <StatCard label="Net margin" value={s.revenue > 0 ? pct(Math.round((s.netProfit / s.revenue) * 1000) / 10) : '—'} />
      </div>
      <Panel title="Summary" className="mb-4">
        <Table columns={[T('label', 'Line'), M('amount', 'Amount (KES)')]} rows={[
          line('Revenue (goods collected, net of discounts)', s.revenue), line('Less: cost of goods sold', -s.costOfGoodsSold), line('Gross margin', s.grossMargin),
          line('Less: delivery fees', -s.deliveryFees), line('Less: telesales pay (retainer + commission)', -s.laborCost), line('Less: business expenses (approved)', -s.businessExpenses),
        ]} totals={{ label: 'Net profit', amount: s.netProfit }} />
      </Panel>
      <Panel title="By category" description="Till and online sales together. Sale-level discounts cannot be split by category, so they show as their own row." className="mb-4">
        <Table columns={[T('category', 'Category'), I('units', 'Units'), M('revenue', 'Revenue'), M('cost', 'Cost'), M('margin', 'Margin'), P('margin_percent', 'Margin %')]} rows={byCategory.rows}
          totals={{ category: 'Total', ...byCategory.total, margin_percent: byCategory.total.revenue > 0 ? Math.round((byCategory.total.margin / byCategory.total.revenue) * 1000) / 10 : null }} />
      </Panel>
      <Panel title="Branch comparison" className="mb-4">
        <Table columns={[T('branch', 'Branch'), M('revenue', 'Revenue'), M('costOfGoodsSold', 'Cost of goods'), M('deliveryFees', 'Delivery'), M('laborCost', 'Telesales pay'), M('businessExpenses', 'Expenses'), M('netProfit', 'Net profit'), P('margin_percent', 'Net margin %')]}
          rows={byBranch.rows} totals={byBranch.rows.length > 1 ? { branch: 'All branches', ...byBranch.total } : undefined} />
      </Panel>
      <Panel title="Forecast vs actual" description="Operating expenses = delivery + telesales pay + business expenses (everything except cost of goods). The current month is month-to-date.">
        <Table columns={[T('month', 'Month'), M('revenue_target', 'Revenue target'), M('revenue_actual', 'Revenue actual'), M('revenue_variance', 'Variance'), P('revenue_attainment_percent', 'Attained'), P('on_pace_percent', 'On pace'),
          M('expense_budget', 'Expense budget'), M('operating_expenses_actual', 'Expenses actual'), M('expense_variance', 'Over(+) / under(−)'), M('net_profit_actual', 'Net profit')]}
          rows={forecast.rows} totals={{ month: 'Total (months with a forecast)', ...forecast.total }} />
        {can('reports.forecast') && forecast.rows.length > 0 && (
          <div className="border-t border-line pt-4 mt-2">
            <ForecastEditor key={forecast.rows.map((m) => m.month).join()} months={forecast.rows} onSaved={() => queryClient.invalidateQueries({ queryKey: ['reports', 'pnl'] })} />
          </div>
        )}
      </Panel>
    </>
  );
}

function DiscountsTab({ params }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['reports', 'discounts', params], queryFn: () => reportsApi.discounts(params).then((r) => r.data.data) });
  if (isLoading) return <div className="text-sm text-text-muted">Loading…</div>;
  if (error) return <div className="text-sm text-danger">{getErrorMessage(error)}</div>;
  const { summary: s } = data;
  const base = (first) => [first, I('transactions', 'Transactions'), I('discounted_transactions', 'Discounted'), M('list_value', 'List value'), M('discount', 'Discount'), P('discount_percent', 'Discount %')];
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Total discount" value={`KES ${kes(s.discount_total)}`} />
        <StatCard label="Share of list value" value={pct(s.discount_percent)} />
        <StatCard label="Discounted sales" value={`${num(s.discounted_transactions)} of ${num(s.transactions)}`} />
        <StatCard label="List value" value={`KES ${kes(s.list_value)}`} />
      </div>
      <Panel title="By staff member" className="mb-4"><Table columns={base(T('staff', 'Staff'))} rows={data.by_staff} /></Panel>
      <Panel title="By day" className="mb-4"><Table columns={base(T('date', 'Date'))} rows={data.by_day} /></Panel>
      <Panel title="Largest discounts">
        <Table columns={[T('date', 'Date'), T('kind', 'Type'), T('reference', 'Reference'), T('staff', 'Staff'), T('channel', 'Channel'), M('list_value', 'List value'), M('discount', 'Discount'), P('discount_percent', 'Discount %')]} rows={data.largest} />
      </Panel>
    </>
  );
}

function VatTab({ params }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['reports', 'vat', params], queryFn: () => reportsApi.vat(params).then((r) => r.data.data) });
  if (isLoading) return <div className="text-sm text-text-muted">Loading…</div>;
  if (error) return <div className="text-sm text-danger">{getErrorMessage(error)}</div>;
  const base = (first) => [first, M('gross', 'Sales incl. VAT'), M('net', 'Sales excl. VAT'), M('vat', `VAT @ ${data.vat_rate_percent}%`)];
  return (
    <>
      <div className="mb-4 px-4 py-3 rounded-xl border border-line bg-surface text-sm text-text-muted">
        <strong className="text-text">Estimate.</strong> {data.note} Change the rate in Settings.
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        <StatCard label="Sales incl. VAT" value={`KES ${kes(data.total.gross)}`} />
        <StatCard label="Sales excl. VAT" value={`KES ${kes(data.total.net)}`} />
        <StatCard label={`VAT @ ${data.vat_rate_percent}%`} value={`KES ${kes(data.total.vat)}`} />
      </div>
      <Panel title="By month" className="mb-4"><Table columns={base(T('month', 'Month'))} rows={data.months} totals={{ month: 'Total', ...data.total }} /></Panel>
      <Panel title="By day"><Table columns={base(T('date', 'Date'))} rows={data.daily} /></Panel>
    </>
  );
}

function BranchesTab({ params }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['reports', 'branches', params], queryFn: () => reportsApi.branchComparison(params).then((r) => r.data.data) });
  if (isLoading) return <div className="text-sm text-text-muted">Loading…</div>;
  if (error) return <div className="text-sm text-danger">{getErrorMessage(error)}</div>;
  return (
    <Panel title="Branches" description="Admins see every active branch; managers see their own.">
      <Table columns={[T('branch', 'Branch'), I('transactions', 'Transactions'), M('revenue', 'Revenue'), M('costOfGoodsSold', 'Cost of goods'), M('deliveryFees', 'Delivery'), M('laborCost', 'Telesales pay'), M('businessExpenses', 'Expenses'), M('netProfit', 'Net profit'), P('margin_percent', 'Net margin %')]}
        rows={data.rows} totals={data.rows.length > 1 ? { branch: 'All branches', ...data.total } : undefined} />
    </Panel>
  );
}

function AgentsTab({ params }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['reports', 'agents', params], queryFn: () => reportsApi.agentPerformance(params).then((r) => r.data.data) });
  if (isLoading) return <div className="text-sm text-text-muted">Loading…</div>;
  if (error) return <div className="text-sm text-danger">{getErrorMessage(error)}</div>;
  return (
    <Panel title="Agents ranked by revenue" description="Online revenue = collected value of dispatched orders assigned to the agent. Leads are those assigned in the period; Lost = cancelled.">
      <Table columns={[I('rank', '#'), T('staff', 'Agent'), I('leads_assigned', 'Leads'), I('leads_converted', 'Converted'), I('leads_lost', 'Lost'), P('lead_conversion_percent', 'Conv. %'), I('orders_created', 'Orders'), I('orders_collected', 'Collected'),
        M('online_revenue', 'Online revenue'), M('avg_order_value', 'Avg order'), I('till_sales', 'Till sales'), M('till_revenue', 'Till revenue'), M('total_revenue', 'Total revenue'), M('discounts_given', 'Discounts'), M('commission', 'Commission')]}
        rows={data.rows} totals={{ staff: 'Total', ...data.total }} />
    </Panel>
  );
}

export default function Reports() {
  const toast = useToast();
  const [tab, setTab] = useState('pnl');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(daysAgo(0));
  const [busy, setBusy] = useState('');
  const params = { from, to };
  const validRange = from && to && from <= to;

  async function exportAs(format) {
    setBusy(format);
    try {
      await downloadFile(`/reports/export/${tab}`, { ...params, format }, `${tab}.${format}`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'The export failed.'));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="p-4 md:p-8">
      <h1 className="font-display font-700 text-2xl tracking-tight mb-4">Reports</h1>
      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-4" />
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-xs font-medium text-text-muted">From
          <input type="date" className={`${inputCls} mt-1`} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-text-muted">To
          <input type="date" className={`${inputCls} mt-1`} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="flex gap-2 sm:ml-auto">
          <button onClick={() => exportAs('xlsx')} disabled={!validRange || !!busy} className="px-3 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50">{busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}</button>
          <button onClick={() => exportAs('pdf')} disabled={!validRange || !!busy} className="px-3 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50">{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</button>
        </div>
      </div>
      {!validRange ? (
        <div className="text-sm text-danger">Pick a start date that is on or before the end date.</div>
      ) : (
        <>
          {tab === 'pnl' && <PnlTab params={params} />}
          {tab === 'discounts' && <DiscountsTab params={params} />}
          {tab === 'vat' && <VatTab params={params} />}
          {tab === 'branches' && <BranchesTab params={params} />}
          {tab === 'agents' && <AgentsTab params={params} />}
        </>
      )}
    </div>
  );
}
