import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { couriersApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/UIContext';
import Sheet from '../Sheet';
import CostsPanel from './CostsPanel';
import { toCents } from '../../utils/splitPayment';
import { inputCls, COST_KIND_LABELS } from './format';

const blank = { kind: 'fuel', amount: '', description: '', order_id: '', receipt_ref: '' };

export default function CostsTab({ courier }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRecord = can('couriers.costs.record');
  const canApprove = can('couriers.costs.approve');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');

  const record = useMutation({
    mutationFn: (payload) => couriersApi.recordCost(courier.id, payload),
    onSuccess: () => {
      toast.success('Cost entered. It is owed once someone else approves it.');
      queryClient.invalidateQueries({ queryKey: ['couriers'] });
      setOpen(false); setForm(blank);
    },
    onError: (err) => setError(getErrorMessage(err, 'Could not enter the cost.')),
  });

  function submit(e) {
    e.preventDefault();
    setError('');
    const amount = toCents(form.amount);
    if (!amount) { setError('Enter the amount in KES, greater than zero.'); return; }
    const orderId = form.order_id.trim() === '' ? null : Number(form.order_id);
    if (orderId !== null && (!Number.isInteger(orderId) || orderId <= 0)) { setError('Order number must be a positive whole number.'); return; }
    record.mutate({
      kind: form.kind, amount, description: form.description.trim(),
      order_id: orderId, receipt_ref: form.receipt_ref.trim() || null,
    });
  }

  return (
    <div>
      {canRecord && (
        <div className="flex justify-end mb-3">
          <button onClick={() => { setForm(blank); setError(''); setOpen(true); }} className="px-3.5 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft">+ Enter cost</button>
        </div>
      )}
      {canApprove
        ? <CostsPanel courierId={courier.id} showCourier={false} empty={`No costs recorded for ${courier.name}.`} />
        : <p className="text-sm text-text-muted text-center py-8 border border-dashed border-line rounded-xl">Costs you enter are reviewed by a manager.</p>}

      {open && (
        <Sheet onClose={() => setOpen(false)} size="sm" as="form" onSubmit={submit} zIndex={60} label="Enter courier cost">
          <h2 className="font-display font-700 text-lg mb-4">Enter a cost for {courier.name}</h2>
          {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
          <label htmlFor="cost-kind" className="block text-xs font-medium text-text-muted mb-1">Kind</label>
          <select id="cost-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={`${inputCls} mb-3`}>
            {Object.entries(COST_KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <label htmlFor="cost-amount" className="block text-xs font-medium text-text-muted mb-1">Amount (KES)</label>
          <input id="cost-amount" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={`${inputCls} mb-3`} />
          <label htmlFor="cost-desc" className="block text-xs font-medium text-text-muted mb-1">What was it for?</label>
          <input id="cost-desc" required maxLength={300} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${inputCls} mb-3`} />
          <label htmlFor="cost-order" className="block text-xs font-medium text-text-muted mb-1">Order number (optional)</label>
          <input id="cost-order" inputMode="numeric" value={form.order_id} onChange={(e) => setForm({ ...form, order_id: e.target.value })} className={`${inputCls} mb-3`} />
          <label htmlFor="cost-receipt" className="block text-xs font-medium text-text-muted mb-1">Receipt reference (optional)</label>
          <input id="cost-receipt" maxLength={100} value={form.receipt_ref} onChange={(e) => setForm({ ...form, receipt_ref: e.target.value })} className={`${inputCls} mb-5`} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-lg border border-line text-sm font-medium">Cancel</button>
            <button type="submit" disabled={record.isPending} className="flex-1 py-2.5 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">{record.isPending ? 'Saving…' : 'Enter cost'}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
