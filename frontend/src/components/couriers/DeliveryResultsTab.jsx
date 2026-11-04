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

  const { data: unverified } = useQuery({
    queryKey: ['delivery', 'unverified-receipts'],
    queryFn: () => deliveryApi.unverifiedReceipts().then((r) => r.data),
  });
  async function verify(r) {
    const note = await dialog.prompt({
      title: r.method === 'cash' ? 'How do you know this cash reached the shop?' : 'How was this payment confirmed?',
      placeholder: r.method === 'cash' ? 'Deposit slip number, who handed it in' : 'Statement line or M-Pesa message seen', required: true,
    });
    if (note) await decide(() => deliveryApi.verifyReceipt(r.id, note), 'Fee payment confirmed.');
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['delivery'] });
  async function decide(fn, success) {
    try { await fn(); toast.success(success); refresh(); queryClient.invalidateQueries({ queryKey: ['orders'] }); } catch (err) { toast.error(getErrorMessage(err, 'Could not save that decision.')); }
  }
  async function reject(c) {
    const reason = await dialog.prompt({ title: 'Why is this being rejected?', placeholder: 'Reason', required: true });
    if (!reason) return;
    await decide(() => (c.item_type === 'adjustment' ? deliveryApi.rejectAdjustment(c.id, reason) : deliveryApi.rejectCost(c.id, reason)), 'Rejected.');
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
          <StatCard label="Still open" value={String(t.open)} sub={`awaiting confirmation · ${money(t.fee_outstanding)} of fees unpaid`} />
        </div>
      )}

      {pending.length > 0 && (
        <div className="bg-surface border border-line rounded-xl p-4">
          <div className="text-sm font-medium mb-2">Extra delivery costs waiting for approval ({pending.length})</div>
          <ul className="space-y-2">
            {pending.map((c) => (
              <li key={`${c.item_type}-${c.id}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div>{c.item_type === 'adjustment' ? `Correction to ${c.target_type.replace('_', ' ')} (${c.delta < 0 ? 'take back' : 'owe more'})` : c.reverses_cost_id ? 'Reversal' : c.kind.replace(/_/g, ' ')} · order #{c.order_id} · <span className="font-mono">{money(c.amount)}</span></div>
                  <div className="text-xs text-text-muted">{c.reason} · entered by {c.recorded_by_name}</div>
                </div>
                {c.recorded_by === user?.id && user?.role !== 'admin' ? (
                  <span className="text-xs text-text-muted">Someone else must approve this</span>
                ) : (
                  <span className="whitespace-nowrap">
                    <button type="button" onClick={() => decide(() => (c.item_type === 'adjustment' ? deliveryApi.approveAdjustment(c.id) : deliveryApi.approveCost(c.id)), 'Approved.')} className="text-xs font-medium text-success hover:underline mr-3">Approve</button>
                    <button type="button" onClick={() => reject(c)} className="text-xs font-medium text-danger hover:underline">Reject</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unverified?.rows?.length > 0 && (
        <div className="bg-surface border border-line rounded-xl p-4">
          <div className="text-sm font-medium mb-2">Fee payments not yet confirmed as real money ({unverified.rows.length} · {money(unverified.total)})</div>
          <ul className="space-y-2">
            {unverified.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div>Order #{r.order_id} · {r.customer_name} · <span className="font-mono">{money(r.amount)}</span> · {r.method.replace('_', ' ')}{r.reference ? ` · ${r.reference}` : ''}</div>
                  <div className="text-xs text-text-muted">entered by {r.recorded_by_name} on {shortDate(r.recorded_at)}</div>
                </div>
                {r.recorded_by === user?.id && user?.role !== 'admin' ? (
                  <span className="text-xs text-text-muted">Someone else must confirm this</span>
                ) : (
                  <button type="button" onClick={() => verify(r)} className="text-xs font-medium underline">{r.method === 'cash' ? 'Confirm deposited' : 'Confirm received'}</button>
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
