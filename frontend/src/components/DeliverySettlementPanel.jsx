import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ordersApi, deliveryApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDialog, useToast } from '../context/UIContext';
import { toCents } from '../utils/splitPayment';

const money = (cents) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'KES' });
const inputCls = 'w-full px-2 py-1.5 rounded-lg border border-line bg-surface text-xs outline-none focus:border-accent';
const METHODS = [['mobile_money', 'M-Pesa'], ['cash', 'Cash'], ['bank_transfer', 'Bank']];
const KINDS = [
  ['outpost_leg', 'Outpost to destination'], ['onward_transport', 'Onward transport'], ['handling', 'Handling'], ['storage', 'Storage'],
  ['fuel', 'Fuel'], ['return_trip', 'Return trip'], ['packaging', 'Packaging'], ['other', 'Other'],
];
const kindLabel = (k) => KINDS.find(([v]) => v === k)?.[1] || k;
const STATUS_CLS = { pending: 'bg-accent/20 text-accent-ink', approved: 'bg-success-soft text-success', rejected: 'bg-danger-soft text-danger' };

// What this delivery earned against what it cost. Open until someone confirms the outcome: until then extra costs and
// late fee payments can be added, each with its reason. Mistakes are fixed by a reversal, never by editing. Closing
// freezes the figures; only an administrator can reopen.
export default function DeliverySettlementPanel({ order }) {
  const { can, user } = useAuth();
  const dialog = useDialog();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);       // null | 'cost' | 'fee'
  const [cost, setCost] = useState({ kind: 'outpost_leg', amount: '', reason: '', paid_via: 'mobile_money', reference: '' });
  const [fee, setFee] = useState({ amount: '', method: 'mobile_money', reference: '' });
  const [reversing, setReversing] = useState(null);

  const { data: s } = useQuery({
    queryKey: ['orders', 'delivery', order.id],
    queryFn: () => ordersApi.delivery(order.id).then((r) => r.data.data),
  });
  if (!s) return null;

  const open = s.settlement.status === 'open';
  const canRecord = can('delivery.costs.record');
  const canApprove = can('delivery.costs.approve');
  const canClose = can('delivery.settlement.close');

  async function run(fn, success) {
    setBusy(true); setError('');
    try {
      await fn();
      if (success) toast.success(success);
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['delivery'] });
      return true;
    } catch (err) {
      setError(getErrorMessage(err, 'That did not work.'));
      return false;
    } finally { setBusy(false); }
  }

  async function addCost(e) {
    e.preventDefault();
    const amount = toCents(cost.amount);
    if (!amount) { setError('Enter the amount.'); return; }
    if (!cost.reason.trim()) { setError('Say why this cost was incurred.'); return; }
    const ok = await run(() => ordersApi.addDeliveryCost(order.id, {
      kind: cost.kind, amount, reason: cost.reason.trim(), paid_via: cost.paid_via, ...(cost.reference.trim() ? { reference: cost.reference.trim() } : {}),
    }), 'Cost entered. It counts once someone else approves it.');
    if (ok) { setForm(null); setCost({ ...cost, amount: '', reason: '', reference: '' }); }
  }

  async function addFee(e) {
    e.preventDefault();
    const amount = toCents(fee.amount);
    if (!amount) { setError('Enter the amount the customer paid.'); return; }
    const ok = await run(() => ordersApi.addFeeReceipt(order.id, { amount, method: fee.method, ...(fee.reference.trim() ? { reference: fee.reference.trim() } : {}) }), 'Fee payment recorded.');
    if (ok) { setForm(null); setFee({ ...fee, amount: '', reference: '' }); }
  }

  async function reject(line) {
    const reason = await dialog.prompt({ title: 'Why is this cost being rejected?', placeholder: 'Reason', required: true });
    if (!reason) return;
    await run(() => deliveryApi.rejectCost(line.id, reason), 'Cost rejected.');
  }

  async function reverse(e) {
    e.preventDefault();
    const amount = toCents(reversing.amount);
    if (!amount) { setError('Enter the amount to take back.'); return; }
    if (!reversing.reason.trim()) { setError('Say why this cost is being reversed.'); return; }
    const ok = await run(() => deliveryApi.reverseCost(reversing.id, { amount, reason: reversing.reason.trim() }), 'Reversal entered. It counts once someone else approves it.');
    if (ok) setReversing(null);
  }

  async function close() {
    const returned = order.status.startsWith('returned');
    const confirmed = await dialog.confirm({
      title: returned ? 'Close this settlement as returned?' : 'Confirm the parcel was delivered?',
      message: `This freezes the figures: fee collected ${money(s.fee_collected)}, costs ${money(s.costs_total)}, `
        + `${s.result >= 0 ? 'earned' : 'cost the shop'} ${money(Math.abs(s.result))}. Nothing more can be added unless an administrator reopens it.`,
      confirmLabel: 'Confirm and close',
    });
    if (!confirmed) return;
    await run(() => ordersApi.closeDelivery(order.id), 'Delivery settlement closed.');
  }

  async function reopen() {
    const reason = await dialog.prompt({ title: 'Why is this settlement being reopened?', placeholder: 'Reason', required: true });
    if (!reason) return;
    await run(() => ordersApi.reopenDelivery(order.id, reason), 'Settlement reopened.');
  }

  const lines = [
    ...(s.package_fee > 0 ? [{ key: 'pkg', label: `Package fee · ${s.package_fee_courier || 'courier'}`, amount: s.package_fee, status: 'approved' }] : []),
    ...s.rider_cost_lines.map((l) => ({ key: `r${l.id}`, label: `${l.courier_name}: ${kindLabel(l.kind)} · ${l.reason}`, amount: l.amount, status: l.status })),
    ...s.extra_cost_lines.map((l) => ({
      key: `e${l.id}`, line: l, label: `${l.reverses_cost_id ? 'Reversal · ' : ''}${kindLabel(l.kind)} · ${l.reason}`,
      amount: l.reverses_cost_id ? -l.amount : l.amount, status: l.status,
      by: l.recorded_by_name,
    })),
  ];

  return (
    <div className="mt-5 pt-4 border-t border-dashed border-line" data-testid="delivery-settlement">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium">Delivery earnings and costs</div>
        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${open ? 'bg-accent/20 text-accent-ink' : 'bg-success-soft text-success'}`}>
          {open ? 'Open until delivery is confirmed' : `Closed · ${s.settlement.outcome}`}
        </span>
      </div>

      {error && <div role="alert" className="mb-2 px-3 py-2 rounded-lg bg-danger-soft text-danger text-xs">{error}</div>}

      <div className="font-mono text-xs space-y-1 mb-3">
        <div className="flex justify-between"><span>Delivery fee charged</span><span>{money(s.fee_charged)}</span></div>
        <div className="flex justify-between"><span>Fee the customer paid</span><span>{money(s.fee_collected)}</span></div>
        {s.fee_uncollected > 0 && <div className="flex justify-between text-danger"><span>Fee not paid (shop carries it)</span><span>{money(s.fee_uncollected)}</span></div>}
        <div className="flex justify-between pt-1 border-t border-dashed border-line"><span>Costs so far</span><span>{money(s.costs_total)}</span></div>
        <div className={`flex justify-between font-600 ${s.result < 0 ? 'text-danger' : 'text-success'}`}>
          <span>{s.result < 0 ? 'Cost to the shop' : 'Earned by the delivery'}</span><span>{money(Math.abs(s.result))}</span>
        </div>
        {s.pending_count > 0 && <div className="text-text-muted font-sans">{s.pending_count} cost(s) waiting for approval are not counted yet.</div>}
      </div>

      {lines.length > 0 && (
        <ul className="text-xs space-y-1.5 mb-3">
          {lines.map((l) => (
            <li key={l.key} className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="break-words">{l.label}</span>
                <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] ${STATUS_CLS[l.status]}`}>{l.status}</span>
                {l.by && <span className="text-text-muted"> · {l.by}</span>}
                {l.line && l.status === 'pending' && open && canApprove && l.line.recorded_by !== user?.id && (
                  <span className="ml-2 whitespace-nowrap">
                    <button type="button" disabled={busy} onClick={() => run(() => deliveryApi.approveCost(l.line.id), 'Cost approved.')} className="font-medium text-success hover:underline mr-2">Approve</button>
                    <button type="button" disabled={busy} onClick={() => reject(l.line)} className="font-medium text-danger hover:underline">Reject</button>
                  </span>
                )}
                {l.line && l.status === 'approved' && !l.line.reverses_cost_id && open && canRecord && (
                  <button type="button" onClick={() => setReversing({ id: l.line.id, amount: '', reason: '' })} className="ml-2 text-text-muted hover:text-text underline">Reverse</button>
                )}
              </div>
              <span className="font-mono whitespace-nowrap">{money(l.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {reversing && (
        <form onSubmit={reverse} className="border border-line rounded-lg p-2 mb-3 space-y-2" aria-label="Reverse a cost">
          <div className="text-xs font-medium">Take back all or part of this cost</div>
          <input type="number" step="0.01" min="0" placeholder="Amount (KES)" value={reversing.amount} onChange={(e) => setReversing({ ...reversing, amount: e.target.value })} className={`${inputCls} font-mono`} />
          <input placeholder="Why is it being reversed?" value={reversing.reason} onChange={(e) => setReversing({ ...reversing, reason: e.target.value })} className={inputCls} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setReversing(null)} className="flex-1 py-1.5 rounded-lg border border-line text-xs">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-1.5 rounded-lg bg-ink text-white text-xs font-medium disabled:opacity-50">Enter reversal</button>
          </div>
        </form>
      )}

      {open && canRecord && !form && (
        <div className="flex gap-2 mb-2">
          <button type="button" onClick={() => { setError(''); setForm('cost'); }} className="flex-1 py-2 rounded-lg border border-line text-xs font-medium hover:border-text-muted">+ Add a cost</button>
          {s.fee_uncollected > 0 && (
            <button type="button" onClick={() => { setError(''); setForm('fee'); }} className="flex-1 py-2 rounded-lg border border-line text-xs font-medium hover:border-text-muted">Customer paid more of the fee</button>
          )}
        </div>
      )}

      {form === 'cost' && (
        <form onSubmit={addCost} className="border border-line rounded-lg p-2 mb-3 space-y-2" aria-label="Add a delivery cost">
          <select value={cost.kind} onChange={(e) => setCost({ ...cost, kind: e.target.value })} aria-label="What the cost was" className={inputCls}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="flex gap-2">
            <input type="number" step="0.01" min="0" placeholder="Amount (KES)" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} aria-label="Cost amount" className={`${inputCls} font-mono flex-1`} />
            <select value={cost.paid_via} onChange={(e) => setCost({ ...cost, paid_via: e.target.value })} aria-label="How it was paid" className={`${inputCls} flex-1`}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <input placeholder="Why was this cost incurred? (required)" value={cost.reason} onChange={(e) => setCost({ ...cost, reason: e.target.value })} aria-label="Reason for the cost" className={inputCls} />
          <input placeholder="Receipt or M-Pesa reference (optional)" value={cost.reference} onChange={(e) => setCost({ ...cost, reference: e.target.value })} className={`${inputCls} font-mono`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setForm(null)} className="flex-1 py-1.5 rounded-lg border border-line text-xs">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-1.5 rounded-lg bg-ink text-white text-xs font-medium disabled:opacity-50">Enter cost</button>
          </div>
        </form>
      )}

      {form === 'fee' && (
        <form onSubmit={addFee} className="border border-line rounded-lg p-2 mb-3 space-y-2" aria-label="Record delivery fee paid">
          <div className="flex gap-2">
            <input type="number" step="0.01" min="0" placeholder={`Up to ${(s.fee_uncollected / 100).toFixed(2)}`} value={fee.amount} onChange={(e) => setFee({ ...fee, amount: e.target.value })} aria-label="Fee amount paid" className={`${inputCls} font-mono flex-1`} />
            <select value={fee.method} onChange={(e) => setFee({ ...fee, method: e.target.value })} aria-label="How the fee was paid" className={`${inputCls} flex-1`}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <input placeholder="Reference (optional)" value={fee.reference} onChange={(e) => setFee({ ...fee, reference: e.target.value })} className={`${inputCls} font-mono`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setForm(null)} className="flex-1 py-1.5 rounded-lg border border-line text-xs">Cancel</button>
            <button type="submit" disabled={busy} className="flex-1 py-1.5 rounded-lg bg-ink text-white text-xs font-medium disabled:opacity-50">Record payment</button>
          </div>
        </form>
      )}

      {open && canClose && (
        <button type="button" onClick={close} disabled={busy} className="w-full py-2 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft disabled:opacity-50">
          {order.status.startsWith('returned') ? 'Close settlement (parcel returned)' : 'Confirm delivered and close'}
        </button>
      )}
      {!open && user?.role === 'admin' && (
        <button type="button" onClick={reopen} disabled={busy} className="w-full py-2 rounded-lg border border-line text-xs font-medium hover:border-text-muted disabled:opacity-50">Reopen (administrator)</button>
      )}
    </div>
  );
}
