import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveryApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useDialog, useToast } from '../../context/UIContext';
import StatCard from '../StatCard';
import { money, shortDate, inputCls } from './format';
import { EmptyRow } from '../EmptyState';

// What every delivery earned against what it cost, and the extra costs waiting for a second person to approve them.
// Closed deliveries show their frozen figures; open ones show the live position.
export default function DeliveryResultsTab() {
  const { user } = useAuth();
  const dialog = useDialog();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [lossOnly, setLossOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data } = useQuery({
    queryKey: ['delivery', 'settlements', { status, lossOnly, from, to }],
    queryFn: () => deliveryApi.settlements({ status: status || undefined, loss_only: lossOnly ? 1 : undefined, from: from || undefined, to: to || undefined }).then((r) => r.data),
  });
  const { data: pending = [] } = useQuery({
    queryKey: ['delivery', 'pending-costs'],
    queryFn: () => deliveryApi.pendingCosts().then((r) => r.data.data),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['delivery'] });
  async function decide(fn, success) {
    try { await fn(); toast.success(success); refresh(); queryClient.invalidateQueries({ queryKey: ['orders'] }); } catch (err) { toast.error(getErrorMessage(err, 'Could not save that decision.')); }
  }
  async function reject(c) {
    const reason = await dialog.prompt({ title: 'Why is this cost being rejected?', placeholder: 'Reason', required: true });
    if (reason) await decide(() => deliveryApi.rejectCost(c.id, reason), 'Cost rejected.');
  }

  const t = data?.totals;
  const rows = data?.rows || [];
  return (
    <div className="space-y-5">
      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Fees collected" value={money(t.fee_collected)} sub={`of ${money(t.fee_charged)} charged`} />
          <StatCard label="Delivery costs" value={money(t.costs_total)} sub={`${t.deliveries} deliveries`} />
          <StatCard label={t.result < 0 ? 'Cost to the shop' : 'Earned'} value={money(Math.abs(t.result))} sub={`${t.losing_deliveries} lost money`} />
          <StatCard label="Still open" value={String(t.open)} sub="awaiting confirmation" />
        </div>
      )}

      {pending.length > 0 && (
        <div className="bg-surface border border-line rounded-xl p-4">
          <div className="text-sm font-medium mb-2">Extra delivery costs waiting for approval ({pending.length})</div>
          <ul className="space-y-2">
            {pending.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div>{c.reverses_cost_id ? 'Reversal' : c.kind.replace(/_/g, ' ')} · order #{c.order_id} · <span className="font-mono">{money(c.amount)}</span></div>
                  <div className="text-xs text-text-muted">{c.reason} · entered by {c.recorded_by_name}</div>
                </div>
                {c.recorded_by === user?.id ? (
                  <span className="text-xs text-text-muted">Someone else must approve this</span>
                ) : (
                  <span className="whitespace-nowrap">
                    <button type="button" onClick={() => decide(() => deliveryApi.approveCost(c.id), 'Cost approved.')} className="text-xs font-medium text-success hover:underline mr-3">Approve</button>
                    <button type="button" onClick={() => reject(c)} className="text-xs font-medium text-danger hover:underline">Reject</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Settlement status" className={`${inputCls} w-auto`}>
          <option value="">Open and closed</option><option value="open">Open</option><option value="closed">Closed</option>
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Dispatched from" className={`${inputCls} w-auto`} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Dispatched to" className={`${inputCls} w-auto`} />
        <label className="text-sm flex items-center gap-1.5"><input type="checkbox" checked={lossOnly} onChange={(e) => setLossOnly(e.target.checked)} /> Only deliveries that lost money</label>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[720px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Dispatched</th>
              <th className="px-4 py-3 font-medium text-right">Fee charged</th>
              <th className="px-4 py-3 font-medium text-right">Fee paid</th>
              <th className="px-4 py-3 font-medium text-right">Costs</th>
              <th className="px-4 py-3 font-medium text-right">Result</th>
              <th className="px-4 py-3 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow colSpan={7}>No deliveries match.</EmptyRow>}
            {rows.map((r) => (
              <tr key={r.order_id} className="border-b border-line last:border-0">
                <td className="px-4 py-3">#{r.order_id} · {r.customer_name}<div className="text-xs text-text-muted">{r.customer_city}</div></td>
                <td className="px-4 py-3">{shortDate(r.dispatched_at)}</td>
                <td className="px-4 py-3 text-right font-mono">{money(r.fee_charged)}</td>
                <td className="px-4 py-3 text-right font-mono">{money(r.fee_collected)}</td>
                <td className="px-4 py-3 text-right font-mono">{money(r.costs_total)}</td>
                <td className={`px-4 py-3 text-right font-mono font-600 ${r.result < 0 ? 'text-danger' : 'text-success'}`}>{r.result < 0 ? '−' : ''}{money(Math.abs(r.result))}</td>
                <td className="px-4 py-3 text-xs">{r.settlement_status === 'closed' ? `Closed · ${r.outcome}` : `Open${r.pending_count ? ` · ${r.pending_count} to approve` : ''}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
